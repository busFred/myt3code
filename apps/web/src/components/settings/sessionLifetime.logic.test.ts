import { describe, expect, it } from "vite-plus/test";

import {
  canRenewSession,
  defaultLinkLifetimeId,
  describeLifetime,
  isLifetimeChoiceValid,
  isMissingEndpointFailure,
  lifetimeFromChoice,
  linkLifetime,
} from "./sessionLifetime.logic";

const DAY = 24 * 60 * 60 * 1000;

describe("lifetimeFromChoice", () => {
  it.each([
    [{ mode: "default", days: "5" }, undefined],
    [{ mode: "never", days: "5" }, { _tag: "never" }],
    [
      { mode: "custom", days: "90" },
      { _tag: "duration", millis: 90 * DAY },
    ],
    [{ mode: "custom", days: "0" }, undefined],
    [{ mode: "custom", days: "1.5" }, undefined],
    [{ mode: "custom", days: "99999" }, undefined],
  ] as const)("%j", (choice, lifetime) => {
    expect(lifetimeFromChoice(choice)).toEqual(lifetime);
  });

  it("rejects only an unusable custom duration", () => {
    expect(isLifetimeChoiceValid({ mode: "custom", days: "" })).toBe(false);
    expect(isLifetimeChoiceValid({ mode: "custom", days: "30" })).toBe(true);
    expect(isLifetimeChoiceValid({ mode: "never", days: "" })).toBe(true);
  });
});

describe("session lifetime helpers", () => {
  it("does not offer renewing T3 Connect or desktop app sessions", () => {
    expect(canRenewSession({ subject: "cloud-connect" })).toBe(false);
    expect(canRenewSession({ subject: "desktop-bootstrap" })).toBe(false);
    expect(canRenewSession({ subject: "desktop-service" })).toBe(false);
    expect(canRenewSession({ subject: "one-time-token" })).toBe(true);
  });

  it("describes a lifetime", () => {
    expect(describeLifetime({ _tag: "never" })).toEqual({ kind: "never" });
    expect(describeLifetime({ _tag: "duration", millis: 30 * DAY })).toEqual({
      kind: "days",
      days: 30,
    });
  });

  it("finds a 404 through wrapped causes", () => {
    expect(isMissingEndpointFailure({ cause: { response: { status: 404 } } })).toBe(true);
    expect(isMissingEndpointFailure({ response: { status: 500 } })).toBe(false);
    expect(isMissingEndpointFailure("nope")).toBe(false);
  });
});

describe("link lifetime", () => {
  const now = Date.UTC(2026, 10, 25);
  it.each([
    ["a new link", null, "30-days"],
    ["a never-expiring link", Date.UTC(9999, 11, 31), "never"],
    // The linking side derives its copy from `expires_in`, so it lands a little early.
    ["a never-expiring link as the linking side sees it", Date.UTC(9999, 11, 30), "never"],
    ["a link ending within a month", now + 20 * DAY, "30-days"],
    ["a link ending in half a year", now + 180 * DAY, "1-year"],
    ["an expired link", now - DAY, "30-days"],
  ] as const)("starts renewing %s at %s", (_name, expiresAt, expected) => {
    expect(defaultLinkLifetimeId(expiresAt, now)).toBe(expected);
  });

  it("leaves the default 30 days to the server", () => {
    expect(linkLifetime("30-days")).toBeUndefined();
    expect(linkLifetime("never")).toEqual({ _tag: "never" });
    expect(linkLifetime("1-year")).toEqual({ _tag: "duration", millis: 365 * DAY });
  });
});
