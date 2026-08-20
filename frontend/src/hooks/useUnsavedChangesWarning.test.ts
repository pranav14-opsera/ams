import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUnsavedChangesWarning } from "./useUnsavedChangesWarning";

describe("useUnsavedChangesWarning", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preventDefault()s beforeunload when there are unsaved changes", () => {
    renderHook(() => useUnsavedChangesWarning(true));
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("does nothing on beforeunload when there are no unsaved changes", () => {
    renderHook(() => useUnsavedChangesWarning(false));
    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  it("shows a confirm dialog on browser back and stays on the page when declined", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    renderHook(() => useUnsavedChangesWarning(true, "Leave?"));
    pushStateSpy.mockClear();

    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(confirmSpy).toHaveBeenCalledWith("Leave?");
    // Declined -> re-pushes the sentinel state to cancel the navigation.
    expect(pushStateSpy).toHaveBeenCalled();
  });

  it("intercepts an internal link click and blocks navigation when the user declines", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderHook(() => useUnsavedChangesWarning(true));

    const link = document.createElement("a");
    link.href = "/agents/registry";
    document.body.appendChild(link);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(clickEvent, "preventDefault");
    link.dispatchEvent(clickEvent);

    expect(preventDefaultSpy).toHaveBeenCalled();
    document.body.removeChild(link);
  });

  it("does not intercept a link click when there are no unsaved changes", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    renderHook(() => useUnsavedChangesWarning(false));

    const link = document.createElement("a");
    link.href = "/agents/registry";
    // Prevents jsdom's own "Not implemented: navigation" noise — this
    // test only cares that the hook itself never calls confirm(), not
    // about jsdom's (unsupported) real navigation.
    link.addEventListener("click", (e) => e.preventDefault());
    document.body.appendChild(link);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(confirmSpy).not.toHaveBeenCalled();
    document.body.removeChild(link);
  });
});
