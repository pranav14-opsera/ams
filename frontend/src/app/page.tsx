import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <>
      <header>
        <h1 className="text-xl font-semibold">Agent Management Service</h1>
      </header>
      <nav aria-label="Primary">
        <ul className="flex gap-4">
          <li>
            <a href="#main">Dashboard</a>
          </li>
        </ul>
      </nav>
      <main id="main">
        <p>Turnkey multi-agent management platform — shell scaffold (WO-050). Feature pages land in subsequent work orders.</p>
        <Button>Get started</Button>
      </main>
      <aside aria-label="Sidebar">
        <p>Contextual panels render here.</p>
      </aside>
    </>
  );
}
