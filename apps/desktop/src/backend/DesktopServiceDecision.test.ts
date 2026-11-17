import { describe, expect, it } from "vite-plus/test";

import { launchDecision, quitDecision } from "./DesktopServiceDecision.ts";

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
