export interface ScimPatchOperation {
  op: "add" | "remove" | "replace";
  path?: string;
  value?: unknown;
}

export interface ScimPatchOpDto {
  schemas: string[];
  Operations: ScimPatchOperation[];
}
