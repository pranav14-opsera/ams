import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <>
      <header>
        <h1 className="text-xl font-semibold">Agent Management Service</h1>
      </header>
      <p>
        Turnkey multi-agent management platform — shell scaffold (WO-050) with role-aware sidebar navigation (WO-051). Feature pages land in subsequent work
        orders.
      </p>
      <Button>Get started</Button>
    </>
  );
}
