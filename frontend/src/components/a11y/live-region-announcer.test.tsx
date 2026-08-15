import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveRegionAnnouncer } from "./live-region-announcer";
import { useAnnounce } from "@/hooks/useAnnounce";

function Probe({ onReady }: { onReady: (announce: ReturnType<typeof useAnnounce>) => void }) {
  const announce = useAnnounce();
  onReady(announce);
  return null;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LiveRegionAnnouncer", () => {
  it("renders one polite and one assertive aria-live region, both initially empty and visually hidden", () => {
    const { container } = render(<LiveRegionAnnouncer>{null}</LiveRegionAnnouncer>);
    const polite = container.querySelector('[aria-live="polite"]');
    const assertive = container.querySelector('[aria-live="assertive"]');

    expect(polite).not.toBeNull();
    expect(assertive).not.toBeNull();
    expect(polite).toHaveClass("sr-only");
    expect(polite).toHaveTextContent("");
    expect(assertive).toHaveTextContent("");
  });

  it("an assertive announcement is delivered immediately (no debounce)", async () => {
    let announce!: ReturnType<typeof useAnnounce>;
    const { container } = render(
      <LiveRegionAnnouncer>
        <Probe onReady={(a) => (announce = a)} />
      </LiveRegionAnnouncer>,
    );

    await act(async () => {
      announce("Critical error occurred", "assertive");
      await wait(20);
    });

    expect(container.querySelector('[aria-live="assertive"]')).toHaveTextContent("Critical error occurred");
  });

  it("a polite announcement is debounced ~100ms before appearing", async () => {
    let announce!: ReturnType<typeof useAnnounce>;
    const { container } = render(
      <LiveRegionAnnouncer>
        <Probe onReady={(a) => (announce = a)} />
      </LiveRegionAnnouncer>,
    );

    await act(async () => {
      announce("Saved");
    });
    // Immediately after calling, the debounce hasn't fired yet.
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("");

    await act(async () => {
      await wait(150);
    });
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("Saved");
  });

  it("rapid-fire polite announcements only deliver the LAST one (debounce collapses the burst)", async () => {
    let announce!: ReturnType<typeof useAnnounce>;
    const { container } = render(
      <LiveRegionAnnouncer>
        <Probe onReady={(a) => (announce = a)} />
      </LiveRegionAnnouncer>,
    );

    await act(async () => {
      announce("first");
      announce("second");
      announce("third");
      await wait(150);
    });

    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("third");
  });
});
