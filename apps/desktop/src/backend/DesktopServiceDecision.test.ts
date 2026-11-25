import { describe, expect, it } from "vite-plus/test";

import {
  appCatchUpDecision,
  catchUpTargetMatches,
  closeChoiceBehavior,
  closeDecision,
  closeDialogChoices,
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
      closeWindowBehavior: "app-and-service",
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
        closeWindowBehavior: "ask",
        owner: "none",
        ...input,
      } as Parameters<typeof launchDecision>[0]),
    ).toBe(expected);
  });
});

describe("attached quit", () => {
  it.each([
    [false, "app-and-service", "user", "quit"],
    [true, undefined, "user", "quit"],
    [true, "app-only", "user", "quit"],
    [true, "app-and-service", "user", "stop-quit"],
    [true, "app-and-service", "update", "quit"],
    [true, "app-and-service", "shutdown", "quit"],
  ] as const)("service=%s, choice=%s, %s => %s", (service, choice, reason, expected) => {
    expect(quitDecision(service, choice, reason)).toBe(expected);
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

describe("app catching up to the background service", () => {
  it.each([
    { label: "newer service", serviceVersion: "0.1.12-rev.1", expected: "update" },
    { label: "newer service on a stable release", serviceVersion: "0.2.0", expected: "update" },
    { label: "older service", serviceVersion: "0.1.10", expected: "none" },
    { label: "same build", serviceBuild: "FD75C53052DF", expected: "none" },
    { label: "same build, longer hash", serviceBuild: "fd75c53052df0123", expected: "none" },
    {
      label: "same version, other build",
      serviceBuild: "d2d1243a5da8",
      expected: "reinstall-if-published",
    },
    { label: "service build unknown", serviceBuild: undefined, expected: "none" },
    { label: "app build unknown", appBuild: undefined, expected: "none" },
    { label: "unparsable service version", serviceVersion: "dev", expected: "none" },
  ] as const)("$label -> $expected", ({ expected, ...overrides }) => {
    const { label: _label, ...input } = {
      appVersion: "0.1.11",
      appBuild: "fd75c53052df" as string | undefined,
      serviceVersion: "0.1.11",
      serviceBuild: "fd75c53052df" as string | undefined,
      ...overrides,
    };
    expect(appCatchUpDecision(input)).toBe(expected);
  });
});

describe("the app's catch-up target", () => {
  it.each([
    { label: "the offered update is the service's", offeredVersion: "0.3.0", expected: true },
    { label: "the feed moved past the service", offeredVersion: "0.3.1", expected: false },
    { label: "nothing offered", offeredVersion: null, expected: false },
    {
      label: "reinstall of the service's published build",
      decision: "reinstall-if-published",
      publishedBuild: "d2d1243a5da8",
      expected: true,
    },
    {
      label: "reinstall after the release was republished",
      decision: "reinstall-if-published",
      publishedBuild: "0123456789ab",
      expected: false,
    },
    {
      label: "reinstall with no BUILD file",
      decision: "reinstall-if-published",
      publishedBuild: undefined,
      expected: false,
    },
  ] as const)("$label -> $expected", ({ label: _label, expected, ...overrides }) => {
    expect(
      catchUpTargetMatches({
        decision: "update",
        serviceVersion: "0.3.0",
        serviceBuild: "d2d1243a5da8",
        offeredVersion: "0.3.0",
        ...overrides,
      }),
    ).toBe(expected);
  });
});

describe("closing the window", () => {
  it.each([
    ["ask", true, true, "ask"],
    ["ask", true, false, "ask"],
    ["ask", false, true, "ask"],
    ["ask", false, false, "quit"],
    ["tray", true, true, "hide"],
    ["tray", false, true, "hide"],
    ["tray", true, false, "ask"],
    ["tray", false, false, "quit"],
    ["app-only", true, true, "quit"],
    ["app-and-service", true, true, "stop-quit"],
    ["app-and-service", false, true, "quit"],
  ] as const)(
    "%s, service=%s, tray=%s => %s",
    (behavior, attachedToService, trayActive, expected) => {
      expect(closeDecision({ behavior, attachedToService, trayActive })).toBe(expected);
    },
  );

  it.each([
    [true, true, ["hide", "app-only", "app-and-service"]],
    [true, false, ["app-only", "app-and-service"]],
    [false, true, ["hide", "quit"]],
    [false, false, ["quit"]],
  ] as const)("dialog choices: service=%s, tray=%s", (attachedToService, trayActive, expected) => {
    expect(closeDialogChoices({ attachedToService, trayActive })).toEqual(expected);
  });

  it.each([
    ["hide", "tray"],
    ["app-only", "app-only"],
    ["app-and-service", "app-and-service"],
    ["quit", "app-only"],
  ] as const)("remembering %s saves %s", (choice, expected) => {
    expect(closeChoiceBehavior(choice)).toBe(expected);
  });
});
