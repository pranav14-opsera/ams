import { createHash } from "node:crypto";

/**
 * SHA-256 hash of User-Agent + the /24 subnet of the client IP (per this
 * WO's implementation step). The /24 truncation — not the exact IP — is
 * deliberate: mobile/carrier-grade-NAT clients can legitimately hop
 * between adjacent addresses within the same subnet across a single
 * session; binding to the exact IP would spuriously reject a refresh
 * mid-session for a real, non-malicious user far more often than it
 * would catch anything a full IP match wouldn't already catch.
 */
export function computeDeviceFingerprint(userAgent: string, ipAddress: string): string {
  const subnet = truncateToSlash24(ipAddress);
  return createHash("sha256").update(`${userAgent}|${subnet}`).digest("hex");
}

function truncateToSlash24(ip: string): string {
  const ipv4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const parts = ipv4.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  // IPv6 (or anything else unrecognized): fall back to the whole value
  // rather than guessing at a prefix-length truncation scheme — an exact
  // match is stricter, not weaker, than intended, and IPv6 clients
  // rotating addresses within a session is a real but separate problem
  // from what a /24-specific truncation is trying to solve here.
  return ip;
}
