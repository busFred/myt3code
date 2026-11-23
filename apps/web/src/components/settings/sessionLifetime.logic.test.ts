import type { BothWaysOutcome, BothWaysStep } from "@t3tools/client-runtime/link-both-ways";
import { describe, expect, it } from "vite-plus/test";

import {
  canRenewSession,
  describeLifetime,
  isLifetimeChoiceValid,
  isMissingEndpointFailure,
  lifetimeFromChoice,
  mergeBothWaysRetry,
  summarizeBothWays,
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

describe("both ways outcomes", () => {
  const outcomes = (entries: Array<[BothWaysStep, BothWaysOutcome]>) => new Map(entries);

  it("lists failed steps and a dropped lifetime", () => {
    const summary = summarizeBothWays(
      outcomes([
        ["a_to_b", { kind: "done", lifetimeIgnored: true }],
        ["b_to_a", { kind: "failed", failure: "no_address", detail: null }],
        ["invite", { kind: "skipped" }],
      ]),
    );
    expect(summary).toEqual({
      failedSteps: ["b_to_a"],
      lifetimeIgnored: true,
      complete: false,
      changed: true,
    });
    // Links both sides already had are kept: nothing failed, and nothing changed either.
    expect(
      summarizeBothWays(
        outcomes([
          ["enable_a", { kind: "skipped" }],
          ["a_to_b", { kind: "kept", access: "auto" }],
          ["b_to_a", { kind: "kept", access: "auto" }],
          ["invite", { kind: "skipped", reason: "not_full_access" }],
        ]),
      ),
    ).toEqual({ failedSteps: [], lifetimeIgnored: false, complete: true, changed: false });
  });

  it("keeps what an earlier run finished, so the next retry still knows a link was made", () => {
    const previous = outcomes([
      ["a_to_b", { kind: "done" }],
      ["b_to_a", { kind: "skipped" }],
      ["invite", { kind: "failed", failure: "other", detail: null }],
    ]);
    const retried = mergeBothWaysRetry(
      previous,
      outcomes([
        ["a_to_b", { kind: "kept", access: "auto" }],
        ["b_to_a", { kind: "skipped" }],
        ["invite", { kind: "done" }],
      ]),
    );
    expect(Object.fromEntries(retried)).toEqual({
      a_to_b: { kind: "done" },
      b_to_a: { kind: "skipped" },
      invite: { kind: "done" },
    });
  });
});
