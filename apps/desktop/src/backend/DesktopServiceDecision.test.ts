import { describe, expect, it } from "vite-plus/test";

import {
  launchDecision,
  quitDecision,
  serviceUpdateDecision,
  serviceUpdateResponse,
} from "./DesktopServiceDecision.ts";

describe("local backend launch", () => {
  it.each([
    { label: "local environment disabled", enabled: false, expected: "own" },
    { label: "WSL only", wslOnly: true, expected: "own" },
    { label: "no service installed", installed: false, expected: "own" },
    { label: "running service, first connection", owner: "service", expected: "ask-connect" },
    {
      label: "running service, remembered connection",
      owner: "service",
      remembered: true,
      expected: "attach",
    },
    { label: "stopped service", expected: "ask-start" },
    { label: "broken service", running: true, expected: "ask-start" },
    {
      label: "stopped service with app-and-service",
      quitBehavior: "app-and-service",
      expected: "start-attach",
    },
    { label: "non-service owner", owner: "other", expected: "ask-connect" },
    {
      label: "non-service owner without service installed",
      installed: false,
      owner: "other",
      expected: "ask-connect",
    },
    { label: "service for another home", otherBaseDir: "/another", expected: "own" },
    {
      label: "service owner with another registered home",
      owner: "service",
      otherBaseDir: "/another",
      remembered: true,
      expected: "own",
    },
    {
      label: "other home's service and local non-service owner",
      otherBaseDir: "/another",
      owner: "other",
      expected: "ask-connect",
    },
    { label: "unidentified owner", owner: "unknown", expected: "unavailable" },
  ])("$label", ({ label: _label, expected, ...input }) => {
    expect(
      launchDecision({
        enabled: true,
        wslOnly: false,
        installed: true,
        running: false,
        remembered: false,
        quitBehavior: "ask",
        owner: "none",
        ...input,
      } as Parameters<typeof launchDecision>[0]),
    ).toBe(expected);
  });
});

describe("attached quit", () => {
  it.each([
    [false, "ask", "user", "quit"],
    [true, "ask", "user", "ask"],
    [true, "app-only", "user", "quit"],
    [true, "app-and-service", "user", "stop-quit"],
    [true, "ask", "update", "quit"],
    [true, "app-and-service", "update", "quit"],
    [true, "ask", "shutdown", "quit"],
    [true, "app-and-service", "shutdown", "quit"],
  ] as const)("service=%s, %s, %s => %s", (service, behavior, reason, expected) => {
    expect(quitDecision(service, behavior, reason)).toBe(expected);
  });
});

describe("background service update", () => {
  it.each([
    ["install", true, "1.2.3", "1.2.4", "ask"],
    ["install", true, "1.2.4", "1.2.4", "skip"],
    ["install", false, "1.2.3", "1.2.4", "skip"],
    ["install", true, undefined, "1.2.4", "ask"],
    ["attach", true, "1.2.3", "1.2.4", "ask"],
    ["attach", true, "1.2.4", "1.2.4", "skip"],
    ["attach", true, "1.2.5", "1.2.4", "skip"],
    ["attach", true, "1.2.4-nightly.9", "1.2.4-nightly.10", "ask"],
    ["attach", true, "1.2.4-nightly.10", "1.2.4", "ask"],
    ["attach", true, "1.2.4", "1.2.4-nightly.10", "skip"],
    ["attach", true, "1.2.4+build.1", "1.2.4+build.2", "skip"],
    ["attach", true, undefined, "1.2.4", "skip"],
    ["attach", true, "unknown", "1.2.4", "skip"],
    ["attach", false, "1.2.3", "1.2.4", "skip"],
    ["required", true, "1.2.3", "1.2.4", "ask"],
    ["required", true, "1.2.5", "1.2.4", "skip"],
  ] as const)(
    "%s service=%s %s -> %s",
    (trigger, serviceManaged, serviceVersion, targetVersion, expected) => {
      expect(
        serviceUpdateDecision({ trigger, serviceManaged, serviceVersion, targetVersion }),
      ).toBe(expected);
    },
  );

  it.each([
    ["install", "confirm", 0, "update"],
    ["install", "confirm", 1, "cancel"],
    ["install", "confirm", 99, "cancel"],
    ["install", "failure", 0, "update"],
    ["install", "failure", 1, "continue"],
    ["install", "failure", 2, "cancel"],
    ["attach", "confirm", 0, "update"],
    ["attach", "confirm", 1, "continue"],
    ["attach", "failure", 0, "update"],
    ["attach", "failure", 1, "continue"],
    ["attach", "failure", 99, "continue"],
    ["required", "confirm", 0, "update"],
    ["required", "confirm", 1, "cancel"],
    ["required", "failure", 0, "update"],
    ["required", "failure", 1, "cancel"],
  ] as const)("%s %s response=%s -> %s", (trigger, phase, response, expected) => {
    expect(serviceUpdateResponse(trigger, phase, response)).toBe(expected);
  });
});
