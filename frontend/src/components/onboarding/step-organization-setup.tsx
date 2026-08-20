"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useCreateTenantMutation, CreateTenantError } from "@/hooks/useCreateTenantMutation";
import type { Tenant } from "@/types/onboarding";

export interface StepOrganizationSetupProps {
  tenant: Tenant | null;
  onProvisioned: (tenant: Tenant) => void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateOrgName(name: string): string | null {
  if (name.trim().length === 0) return "Organization name is required.";
  if (name.length < 3 || name.length > 100) return "Organization name must be between 3 and 100 characters.";
  return null;
}

function validateEmail(email: string): string | null {
  if (!email.trim()) return "Primary admin contact email is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
  return null;
}

/**
 * AC 2: org name (3-100 chars), data residency (US/EU), primary admin
 * email; submitting provisions the tenant (POST /api/v1/tenants).
 * edge_case: data residency is a PERMANENT choice — a confirmation
 * dialog (AlertDialog) is required before the tenant is actually created.
 * Once `tenant` is set (provisioning succeeded), the form renders
 * read-only — data residency can never be changed after this point.
 */
export function StepOrganizationSetup({ tenant, onProvisioned }: StepOrganizationSetupProps) {
  const [organizationName, setOrganizationName] = useState("");
  const [dataResidencyRegion, setDataResidencyRegion] = useState<"us" | "eu">("us");
  const [adminEmail, setAdminEmail] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [touched, setTouched] = useState(false);
  const createTenant = useCreateTenantMutation();

  if (tenant) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold">Organization Setup</h2>
          <p className="text-muted-foreground text-sm">Your organization has been provisioned.</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Organization name</dt>
          <dd>{tenant.name}</dd>
          <dt className="text-muted-foreground">Data residency region</dt>
          <dd className="uppercase">{tenant.dataResidencyRegion}</dd>
        </dl>
        <p className="text-muted-foreground text-xs">Data residency is permanent and cannot be changed after provisioning.</p>
      </div>
    );
  }

  const nameError = touched ? validateOrgName(organizationName) : null;
  const emailError = touched ? validateEmail(adminEmail) : null;

  function handleSubmitClick() {
    setTouched(true);
    if (validateOrgName(organizationName) || validateEmail(adminEmail)) return;
    setShowConfirm(true);
  }

  function handleConfirmProvision() {
    setShowConfirm(false);
    createTenant.mutate(
      { name: organizationName.trim(), slug: slugify(organizationName), dataResidencyRegion },
      { onSuccess: (created) => onProvisioned(created) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Organization Setup</h2>
        <p className="text-muted-foreground text-sm">Tell us about your organization to get started.</p>
      </div>

      <div className="flex max-w-md flex-col gap-1">
        <label htmlFor="org-name" className="text-sm font-medium">
          Organization name <span aria-hidden="true">*</span>
        </label>
        <input
          id="org-name"
          type="text"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          aria-required="true"
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? "org-name-error" : undefined}
          className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
        />
        {nameError && (
          <p id="org-name-error" role="alert" className="text-sm text-red-700">
            {nameError}
          </p>
        )}
      </div>

      <fieldset className="flex max-w-md flex-col gap-1">
        <legend className="text-sm font-medium">
          Data residency region <span aria-hidden="true">*</span>
        </legend>
        <p className="text-muted-foreground text-xs">This determines where all of your organization&apos;s data is stored and cannot be changed later.</p>
        <div className="flex gap-4">
          {(["us", "eu"] as const).map((region) => (
            <label key={region} className="flex items-center gap-2 text-sm">
              <input type="radio" name="data-residency-region" value={region} checked={dataResidencyRegion === region} onChange={() => setDataResidencyRegion(region)} />
              {region.toUpperCase()}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex max-w-md flex-col gap-1">
        <label htmlFor="admin-email" className="text-sm font-medium">
          Primary admin contact email <span aria-hidden="true">*</span>
        </label>
        <input
          id="admin-email"
          type="email"
          value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)}
          aria-required="true"
          aria-invalid={Boolean(emailError)}
          aria-describedby={emailError ? "admin-email-error" : undefined}
          className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
        />
        {emailError && (
          <p id="admin-email-error" role="alert" className="text-sm text-red-700">
            {emailError}
          </p>
        )}
      </div>

      {createTenant.isError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {createTenant.error instanceof CreateTenantError ? createTenant.error.message : "Failed to provision your organization. Please try again or contact support."}
        </p>
      )}

      <div>
        <Button type="button" onClick={handleSubmitClick} disabled={createTenant.isPending}>
          {createTenant.isPending ? "Provisioning…" : "Provision Organization"}
        </Button>
      </div>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm data residency region</AlertDialogTitle>
            <AlertDialogDescription>
              You are choosing <strong>{dataResidencyRegion.toUpperCase()}</strong> as your data residency region. This choice is <strong>permanent</strong> — it
              determines where all of your organization&apos;s data is stored and cannot be changed after provisioning. Are you sure you want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmProvision}>Confirm and Provision</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
