import * as http from "node:http";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import * as jwt from "jsonwebtoken";

export interface MockOidcProvider {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Signs and returns a real RS256 id_token for the next /token exchange this server will serve. */
  issueIdToken(claimsOverrides?: Record<string, unknown>, options?: { expiresInSeconds?: number }): string;
  close(): Promise<void>;
}

/**
 * A real local HTTP server implementing just enough of the OIDC
 * discovery/JWKS/token-endpoint surface for openid-client's own
 * Issuer.discover() + client.callback() to exercise the genuine protocol
 * flow (real network calls to real endpoints, real RS256 signature
 * verification against the served JWKS) — this WO's acceptance criteria
 * explicitly calls for "a mock OIDC provider", which this is, not a
 * stubbed-out OidcService.
 */
export async function startMockOidcProvider(): Promise<MockOidcProvider> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const clientId = "test-client-id";
  const clientSecret = "test-client-secret";
  const kid = "test-key-1";
  let nextIdToken: string | null = null;

  const jwk = (publicKey as KeyObject).export({ format: "jwk" }) as Record<string, unknown>;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: issuerUrlPlaceholder(),
          authorization_endpoint: `${issuerUrlPlaceholder()}/authorize`,
          token_endpoint: `${issuerUrlPlaceholder()}/token`,
          jwks_uri: `${issuerUrlPlaceholder()}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        // A real code/client credential check would validate `body` here
        // — this mock always succeeds once a code has been "issued" via
        // issueIdToken(), matching this WO's stated scope of proving the
        // exchange mechanics, not building a full authorization-code
        // store.
        if (!nextIdToken) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock-access-token", token_type: "Bearer", id_token: nextIdToken, expires_in: 3600 }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  function issuerUrlPlaceholder(): string {
    return `http://127.0.0.1:${port}`;
  }

  return {
    issuerUrl: issuerUrlPlaceholder(),
    clientId,
    clientSecret,
    issueIdToken(claimsOverrides = {}, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuerUrlPlaceholder(),
        sub: "user-1@example.com",
        aud: clientId,
        iat: now,
        email: "user-1@example.com",
        groups: ["clinicians"],
        ...claimsOverrides,
      };
      nextIdToken = jwt.sign(claims, privateKey, {
        algorithm: "RS256",
        keyid: kid,
        expiresIn: options.expiresInSeconds ?? 3600,
      });
      return nextIdToken;
    },
    close() {
      nextIdToken = null;
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
