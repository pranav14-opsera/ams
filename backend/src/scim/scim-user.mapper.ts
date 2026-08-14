const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  external_id: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface ScimUserResource {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  emails?: { value: string; primary: boolean }[];
  active: boolean;
  meta: { resourceType: "User"; created: string; lastModified: string; location: string };
}

/** SCIM's `active: true/false` collapses onto this platform's 3-value status enum: false always means 'deactivated' (never 'suspended', a distinct concept this WO doesn't touch), true always means 'active'. */
export function scimActiveToStatus(active: boolean): "active" | "deactivated" {
  return active ? "active" : "deactivated";
}

export function statusToScimActive(status: string): boolean {
  return status === "active";
}

export function toScimUser(row: UserRow, locationBase: string): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    externalId: row.external_id ?? undefined,
    userName: row.email,
    displayName: row.display_name,
    emails: [{ value: row.email, primary: true }],
    active: statusToScimActive(row.status),
    meta: {
      resourceType: "User",
      created: row.created_at.toISOString(),
      lastModified: row.updated_at.toISOString(),
      location: `${locationBase}/${row.id}`,
    },
  };
}

export interface ScimUserCreatePayload {
  userName: string;
  externalId?: string;
  displayName?: string;
  emails?: { value: string; primary?: boolean }[];
  active?: boolean;
}

export function scimEmail(payload: ScimUserCreatePayload): string {
  const primaryEmail = payload.emails?.find((e) => e.primary)?.value ?? payload.emails?.[0]?.value;
  return primaryEmail ?? payload.userName;
}
