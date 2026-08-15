"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

// Defaults: a 30s staleTime means a page revisited within that window
// never triggers a redundant refetch on mount; refetchOnWindowFocus is
// off because this is an internal ops tool, not a data feed users expect
// to see live-update the instant they tab back in — an explicit refresh
// or a real-time WebSocket subscription (this platform's actual live-data
// path) is preferable to surprising background refetches.
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
