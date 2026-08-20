"use client";

import { AGENT_REGISTRY_PAGE_SIZES, type AgentRegistryPageSize, type AgentRegistryPagination } from "@/types/dashboard";

export interface AgentRegistryPaginationBarProps {
  pagination: AgentRegistryPagination;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: AgentRegistryPageSize) => void;
}

/** AC: server-side pagination with configurable page sizes (10/25/50/100), displaying the total agent count. */
export function AgentRegistryPaginationBar({ pagination, onPageChange, onPageSizeChange }: AgentRegistryPaginationBarProps) {
  const { page, pageSize, total, totalPages } = pagination;
  const firstItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
      <p role="status">
        {total === 0 ? "No agents" : `Showing ${firstItem}–${lastItem} of ${total} agents`}
      </p>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            className="border-border rounded-md border bg-transparent px-2 py-1"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value) as AgentRegistryPageSize)}
          >
            {AGENT_REGISTRY_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <button type="button" className="border-border rounded-md border px-2 py-1 disabled:opacity-50" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
            Previous
          </button>
          <span aria-current="page">
            Page {page} of {Math.max(totalPages, 1)}
          </span>
          <button
            type="button"
            className="border-border rounded-md border px-2 py-1 disabled:opacity-50"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
