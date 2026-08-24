"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfigureSsoMutation, useTestSsoConnectionMutation } from "@/hooks/useSsoConfiguration";
import { useDeleteGroupMappingMutation, useGroupMappingsQuery, useUpsertGroupMappingMutation } from "@/hooks/useGroupRoleMappings";
import { PLATFORM_ROLES, type PlatformRoleValue, type SsoConfigResponse, type SsoProtocol } from "@/types/onboarding";

export interface StepSsoConfigurationProps {
  tenantId: string;
  config: SsoConfigResponse | null;
  onConfigured: (config: SsoConfigResponse) => void;
}

const DIAGNOSTIC_LABELS: Record<string, string> = {
  metadataFetch: "Metadata fetch",
  certificateValidation: "Certificate validation",
  assertionParsing: "Assertion parsing",
  groupMapping: "Group mapping",
};

/**
 * AC 3/4: protocol selector (SAML 2.0 / OIDC), conditional protocol-
 * specific fields, "Test SSO Connection" with per-check diagnostics.
 * AC 4 (group-to-role mapping): maps IdP groups to the 5 platform roles
 * via the existing GroupMappingController.
 */
export function StepSsoConfiguration({ tenantId, config, onConfigured }: StepSsoConfigurationProps) {
  const [protocol, setProtocol] = useState<SsoProtocol>(config?.protocol ?? "saml");
  const [samlMetadataUrl, setSamlMetadataUrl] = useState(config?.samlMetadataUrl ?? "");
  const [samlEntityId, setSamlEntityId] = useState(config?.samlEntityId ?? "");
  const [oidcDiscoveryUrl, setOidcDiscoveryUrl] = useState(config?.oidcDiscoveryUrl ?? "");
  const [oidcClientId, setOidcClientId] = useState(config?.oidcClientId ?? "");
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [newRole, setNewRole] = useState<PlatformRoleValue>("agent_operator");

  const configureSso = useConfigureSsoMutation();
  const testSso = useTestSsoConnectionMutation();
  const mappingsQuery = useGroupMappingsQuery(tenantId);
  const upsertMapping = useUpsertGroupMappingMutation();
  const deleteMapping = useDeleteGroupMappingMutation();

  function handleSave() {
    configureSso.mutate(
      {
        tenantId,
        protocol,
        ...(protocol === "saml" ? { samlMetadataUrl, samlEntityId } : { oidcDiscoveryUrl, oidcClientId, oidcClientSecret }),
      },
      { onSuccess: (result) => onConfigured(result) },
    );
  }

  function handleAddMapping() {
    if (!newGroup.trim()) return;
    upsertMapping.mutate(
      { tenantId, idpGroup: newGroup.trim(), platformRole: newRole, priority: mappingsQuery.data?.length ?? 0 },
      { onSuccess: () => setNewGroup("") },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">SSO Configuration</h2>
        <p className="text-muted-foreground text-sm">Connect your identity provider using SAML 2.0 or OIDC.</p>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">SSO protocol</legend>
        <div role="radiogroup" aria-label="SSO protocol" className="flex gap-4">
          {(["saml", "oidc"] as const).map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <input type="radio" name="sso-protocol" value={p} checked={protocol === p} onChange={() => setProtocol(p)} />
              {p === "saml" ? "SAML 2.0" : "OIDC"}
            </label>
          ))}
        </div>
      </fieldset>

      {protocol === "saml" ? (
        <div className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="saml-metadata-url" className="text-sm font-medium">
              IdP metadata URL
            </label>
            <input
              id="saml-metadata-url"
              type="url"
              value={samlMetadataUrl}
              onChange={(e) => setSamlMetadataUrl(e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="saml-entity-id" className="text-sm font-medium">
              Entity ID
            </label>
            <input
              id="saml-entity-id"
              type="text"
              value={samlEntityId}
              onChange={(e) => setSamlEntityId(e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          {config?.acsUrl && (
            <p className="text-muted-foreground text-xs">
              Configure this ACS URL in your IdP: <code className="bg-muted rounded px-1 py-0.5">{config.acsUrl}</code>
            </p>
          )}
        </div>
      ) : (
        <div className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="oidc-discovery-url" className="text-sm font-medium">
              Discovery URL
            </label>
            <input
              id="oidc-discovery-url"
              type="url"
              value={oidcDiscoveryUrl}
              onChange={(e) => setOidcDiscoveryUrl(e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="oidc-client-id" className="text-sm font-medium">
              Client ID
            </label>
            <input
              id="oidc-client-id"
              type="text"
              value={oidcClientId}
              onChange={(e) => setOidcClientId(e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="oidc-client-secret" className="text-sm font-medium">
              Client secret
            </label>
            <input
              id="oidc-client-secret"
              type="password"
              autoComplete="off"
              value={oidcClientSecret}
              onChange={(e) => setOidcClientSecret(e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          {config?.redirectUri && (
            <p className="text-muted-foreground text-xs">
              Configure this redirect URI in your IdP: <code className="bg-muted rounded px-1 py-0.5">{config.redirectUri}</code>
            </p>
          )}
        </div>
      )}

      {configureSso.isError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {configureSso.error instanceof Error ? configureSso.error.message : "Failed to save SSO configuration."}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" onClick={handleSave} disabled={configureSso.isPending}>
          {configureSso.isPending ? "Saving…" : "Save SSO Configuration"}
        </Button>
        <Button type="button" variant="outline" onClick={() => testSso.mutate(tenantId)} disabled={testSso.isPending || !config}>
          {testSso.isPending ? "Testing…" : "Test SSO Connection"}
        </Button>
      </div>

      {testSso.isPending && (
        <p role="status" aria-live="polite" className="text-sm">
          Validating your SSO configuration…
        </p>
      )}

      {testSso.data && (
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${testSso.data.success ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-800"}`}
        >
          <p className="font-medium">{testSso.data.success ? "SSO connection validated successfully." : "SSO connection test failed."}</p>
          {testSso.data.errorMessage && <p>{testSso.data.errorMessage}</p>}
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {Object.entries(testSso.data.diagnostics).map(([key, value]) => (
              <div key={key} className="contents">
                <dt>{DIAGNOSTIC_LABELS[key] ?? key}</dt>
                <dd className={value === "pass" ? "text-green-700" : "text-red-700"}>{value === "pass" ? "Pass" : "Fail"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {testSso.isError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {testSso.error instanceof Error ? testSso.error.message : "Retry the test."}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t pt-4">
        <div>
          <h3 className="text-sm font-semibold">Group-to-role mapping</h3>
          <p className="text-muted-foreground text-xs">Map your IdP groups to the platform&apos;s 5-tier RBAC roles.</p>
        </div>

        {mappingsQuery.isSuccess && mappingsQuery.data.length > 0 && (
          <ul className="flex flex-col gap-2">
            {mappingsQuery.data.map((mapping) => (
              <li key={mapping.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="break-all">
                  <strong>{mapping.idpGroup}</strong> → {PLATFORM_ROLES.find((r) => r.value === mapping.platformRole)?.label ?? mapping.platformRole}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteMapping.mutate({ tenantId, id: mapping.id })}
                  aria-label={`Remove mapping for ${mapping.idpGroup}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex max-w-lg flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="new-idp-group" className="text-sm font-medium">
              IdP group name
            </label>
            <input
              id="new-idp-group"
              type="text"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="new-platform-role" className="text-sm font-medium">
              Platform role
            </label>
            <select
              id="new-platform-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as PlatformRoleValue)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            >
              {PLATFORM_ROLES.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </div>
          <Button type="button" size="sm" onClick={handleAddMapping} disabled={!newGroup.trim() || upsertMapping.isPending}>
            Add mapping
          </Button>
        </div>
      </div>
    </div>
  );
}
