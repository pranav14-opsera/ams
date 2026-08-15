import { render, screen } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { QueryProvider } from "./query-provider";

function Probe() {
  const { data } = useQuery({ queryKey: ["probe"], queryFn: () => Promise.resolve("ready"), initialData: "ready" });
  return <div>{data}</div>;
}

describe("QueryProvider", () => {
  it("mounts and provides a working QueryClient context to descendants", () => {
    render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );

    expect(screen.getByText("ready")).toBeInTheDocument();
  });
});
