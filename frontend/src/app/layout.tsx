import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SkipToContent } from "@/components/a11y/skip-to-content";
import { LiveRegionAnnouncer } from "@/components/a11y/live-region-announcer";
import { Sidebar } from "@/components/navigation";
import { QueryProvider } from "@/providers/query-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Management Service",
  description: "Turnkey multi-agent management platform.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// AC (WO-053): header (banner) / nav / main / aside landmarks present and
// correctly nested at the root. `nav` lives inside Sidebar's own `aside`
// (a "nav rail as aside" structure, already shipped in WO-051) — that
// satisfies both nav and aside; this layout adds the one still missing,
// `header`. SkipToContent is the literal first child of <body>, before
// any provider, so it's reachable by a single Tab press no matter what
// else renders.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <SkipToContent />
        <ThemeProvider>
          <QueryProvider>
            <LiveRegionAnnouncer>
              <div className="flex min-h-screen flex-col">
                <header className="border-border flex items-center border-b p-4">
                  <h1 className="text-lg font-semibold">Agent Management Service</h1>
                </header>
                <div className="flex flex-1">
                  <Sidebar />
                  <main id="main-content" className="flex-1 p-6">
                    {children}
                  </main>
                </div>
              </div>
            </LiveRegionAnnouncer>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
