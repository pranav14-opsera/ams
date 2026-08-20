import { describe, expect, it } from "vitest";
import {
  getCommonValidActions,
  getValidActions,
  isValidTransition,
  requiresInFlightWarning,
} from "./agent-lifecycle-state-machine";
import type { AgentLifecycleStatus } from "@/types/dashboard";

describe("agent-lifecycle-state-machine", () => {
  describe("getValidActions", () => {
    it("returns Pause and Retire for Active", () => {
      expect(getValidActions("active").map((a) => a.name)).toEqual(["pause", "retire"]);
    });

    it("returns Resume and Retire for Paused", () => {
      expect(getValidActions("paused").map((a) => a.name)).toEqual(["resume", "retire"]);
    });

    it("returns Decommission for Retired", () => {
      expect(getValidActions("retired").map((a) => a.name)).toEqual(["decommission"]);
    });

    it("returns no actions for Connecting", () => {
      expect(getValidActions("connecting")).toEqual([]);
    });

    it("returns no actions for Decommissioned", () => {
      expect(getValidActions("decommissioned")).toEqual([]);
    });
  });

  describe("isValidTransition", () => {
    const validCases: Array<[AgentLifecycleStatus, "pause" | "resume" | "retire" | "decommission"]> = [
      ["active", "pause"],
      ["active", "retire"],
      ["paused", "resume"],
      ["paused", "retire"],
      ["retired", "decommission"],
    ];
    it.each(validCases)("allows %s -> %s", (status, action) => {
      expect(isValidTransition(status, action)).toBe(true);
    });

    const invalidCases: Array<[AgentLifecycleStatus, "pause" | "resume" | "retire" | "decommission"]> = [
      ["connecting", "pause"],
      ["connecting", "resume"],
      ["connecting", "retire"],
      ["connecting", "decommission"],
      ["active", "resume"],
      ["active", "decommission"],
      ["paused", "pause"],
      ["paused", "decommission"],
      ["retired", "pause"],
      ["retired", "resume"],
      ["retired", "retire"],
      ["decommissioned", "pause"],
      ["decommissioned", "resume"],
      ["decommissioned", "retire"],
      ["decommissioned", "decommission"],
    ];
    it.each(invalidCases)("rejects %s -> %s", (status, action) => {
      expect(isValidTransition(status, action)).toBe(false);
    });
  });

  describe("getCommonValidActions", () => {
    it("returns an empty array for an empty selection", () => {
      expect(getCommonValidActions([])).toEqual([]);
    });

    it("returns the full set for a single-status selection", () => {
      expect(getCommonValidActions(["active", "active"]).map((a) => a.name)).toEqual(["pause", "retire"]);
    });

    it("intersects Active + Paused down to just Retire", () => {
      expect(getCommonValidActions(["active", "paused"]).map((a) => a.name)).toEqual(["retire"]);
    });

    it("returns an empty array when there is no common action (Active + Retired)", () => {
      expect(getCommonValidActions(["active", "retired"])).toEqual([]);
    });

    it("returns an empty array when any selected agent is Connecting or Decommissioned", () => {
      expect(getCommonValidActions(["active", "connecting"])).toEqual([]);
      expect(getCommonValidActions(["retired", "decommissioned"])).toEqual([]);
    });
  });

  describe("requiresInFlightWarning", () => {
    it("is true only for Active -> pause", () => {
      expect(requiresInFlightWarning("active", "pause")).toBe(true);
    });

    it("is false for every other status/action combination", () => {
      expect(requiresInFlightWarning("paused", "resume")).toBe(false);
      expect(requiresInFlightWarning("active", "retire")).toBe(false);
      expect(requiresInFlightWarning("paused", "retire")).toBe(false);
      expect(requiresInFlightWarning("retired", "decommission")).toBe(false);
    });
  });
});
