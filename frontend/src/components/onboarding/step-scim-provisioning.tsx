"use client";

import { useState } from "react";
import { env } from "@/env";
import { Button } from "@/components/ui/button";
import { useGenerateScimTokenMutation, useTestScimProvisioningMutation } from "@/hooks/useScimProvisioning";

export interface StepScimProvisioningProps {
  tenantId: string;
  onSkip: () => void;
  onConfigured: () => void;
}

/** AC 5: optional SCIM step — endpoint URL + generated bearer token (copy-to-clipboard), "Test Provisioning," and a prominent Skip button. */
export function StepScimProvisioning({ tenantId, onSkip, onConfigured }: StepScimProvisioningProps) {
  const [copied, setCopied] = useState(false);
  const generateToken = useGenerateScimTokenMutation();
  const testProvisioning = useTestScimProvisioningMutation();

  const scimEndpointUrl = `${env.NEXT_PUBLIC_API_BASE_URL}/scim/v2`;

  function handleGenerate() {
    generateToken.mutate(tenantId, { onSuccess: () => onConfigured() });
  }

  async function handleCopy() {
    if (!generateToken.data) return;
    try {
      await navigator.clipboard.writeText(generateToken.data.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // clipboard API unavailable (e.g. insecure context) — the token remains selectable text either way.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">SCIM Provisioning (optional)</h2>
        <p className="text-muted-foreground text-sm">
          Automatically provision and deprovision users from your identity provider. This step is optional — you can configure it later from Settings.
        </p>
      </div>

      <div className="flex max-w-md flex-col gap-1">
        <span className="text-sm font-medium">SCIM 2.0 endpoint URL</span>
        <code className="bg-muted rounded px-2 py-1 text-sm break-all">{scimEndpointUrl}</code>
      </div>

      {!generateToken.data ? (
        <Button type="button" onClick={handleGenerate} disabled={generateToken.isPending}>
          {generateToken.isPending ? "Generating…" : "Generate SCIM Bearer Token"}
        </Button>
      ) : (
        <div className="flex max-w-md flex-col gap-2">
          <span className="text-sm font-medium">Bearer token</span>
          <div className="flex items-center gap-2">
            <code className="bg-muted flex-1 rounded px-2 py-1 text-sm break-all">{generateToken.data.token}</code>
            <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">This token is shown only once — copy it now and configure it in your IdP&apos;s SCIM settings.</p>
        </div>
      )}

      {generateToken.isError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Failed to generate a SCIM bearer token. Please try again.
        </p>
      )}

      {generateToken.data && (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" onClick={() => testProvisioning.mutate(tenantId)} disabled={testProvisioning.isPending}>
            {testProvisioning.isPending ? "Testing…" : "Test Provisioning"}
          </Button>
          {testProvisioning.data && (
            <div
              role="status"
              className={`max-w-md rounded-md border px-3 py-2 text-sm ${testProvisioning.data.success ? "border-green-300 bg-green-50 text-green-900" : "border-red-300 bg-red-50 text-red-800"}`}
            >
              <p className="font-medium">{testProvisioning.data.success ? "SCIM provisioning validated successfully." : "SCIM provisioning test failed."}</p>
              {testProvisioning.data.errorMessage && <p>{testProvisioning.data.errorMessage}</p>}
              {/* edge_case: "SCIM provisioning test fails: display error with guidance and allow the customer to skip SCIM and configure it later from settings." */}
              {!testProvisioning.data.success && <p>You can skip this step and configure SCIM later from Settings.</p>}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 border-t pt-4">
        <Button type="button" variant="ghost" onClick={onSkip}>
          Skip — configure SCIM later
        </Button>
      </div>
    </div>
  );
}
