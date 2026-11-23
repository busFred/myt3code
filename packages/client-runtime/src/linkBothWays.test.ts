import {
  type AuthMcpClientAccess,
  AuthSessionId,
  type AuthSessionLifetime,
  EnvironmentId,
  PeerLinkError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  type BothWaysOps,
  type BothWaysSide,
  runLinkBothWays,
  runRenewBothWays,
} from "./linkBothWays.ts";

const side = (name: string, overrides: Partial<BothWaysSide> = {}): BothWaysSide => ({
  environmentId: EnvironmentId.make(`environment-${name}`),
  label: name,
  urls: [`https://${name}.example.ts.net`, `http://100.64.0.${name.length}:3773`],
  linkedEnvironmentsEnabled: true,
  ...overrides,
});
const never: AuthSessionLifetime = { _tag: "never" };
const NOT_FOUND = { status: 404 };

/**
 * Records every call; `fail` names calls that fail, as `<op>:<environment>`. `linked` maps an
 * environment to the access of a link it already has, which it keeps.
 */
const recordingOps = (
  fail: Record<string, unknown> = {},
  echoLifetime = true,
  linked: Record<string, AuthMcpClientAccess> = {},
) => {
  const calls: Array<string> = [];
  const result = <A>(key: string, success: A) => {
    calls.push(key);
    return Promise.resolve(key in fail ? Result.fail(fail[key]) : Result.succeed(success));
  };
  const ops: BothWaysOps = {
    enableLinks: (environmentId) => result(`enable:${environmentId}`, undefined),
    mintLinkCode: (environmentId, input) =>
      result(`mint:${environmentId}`, {
        id: `link-code-${environmentId}`,
        credential: `code-${environmentId}`,
        ...(echoLifetime && input.lifetime ? { lifetime: input.lifetime } : {}),
      }),
    link: (environmentId, input) =>
      result(`link:${environmentId}->${input.expectedEnvironmentId}:${input.pairingCode}`, {
        alreadyLinked: environmentId in linked,
        access: linked[environmentId] ?? input.access,
      }),
    mintAppCode: (environmentId, input) =>
      result(`app:${environmentId}`, {
        id: `app-link-${environmentId}`,
        credential: `app-${environmentId}`,
        expiresAt: DateTime.makeUnsafe(0),
        ...(echoLifetime && input.lifetime ? { lifetime: input.lifetime } : {}),
      }),
    revokeCode: (environmentId, id) => result(`revoke:${environmentId}:${id}`, undefined),
    createInvite: (environmentId, input) =>
      result(`invite:${environmentId}:${input.environmentId}:${input.credential}`, {}),
    isUnsupported: (failure) => failure === NOT_FOUND,
  };
  return { ops, calls };
};

describe("runLinkBothWays", () => {
  it("turns links on where off, links each way with a code from the other side, and invites b", async () => {
    const { ops, calls } = recordingOps();
    const outcomes = await runLinkBothWays({
      a: side("a"),
      b: side("b", { linkedEnvironmentsEnabled: false }),
      access: "full-access",
      lifetime: never,
      invite: true,
      ops,
    });
    expect(Object.fromEntries(outcomes)).toEqual({
      enable_a: { kind: "skipped" },
      enable_b: { kind: "done" },
      a_to_b: { kind: "done" },
      b_to_a: { kind: "done" },
      invite: { kind: "done" },
    });
    expect(calls).toContain("enable:environment-b");
    expect(calls).not.toContain("enable:environment-a");
    // Each side links with a code minted on the side it links to.
    expect(calls).toContain("link:environment-a->environment-b:code-environment-b");
    expect(calls).toContain("link:environment-b->environment-a:code-environment-a");
    expect(calls).toContain("invite:environment-b:environment-a:app-environment-a");
    // The invite follows the links, so it never outruns them.
    expect(calls.indexOf("invite:environment-b:environment-a:app-environment-a")).toBeGreaterThan(
      calls.indexOf("link:environment-b->environment-a:code-environment-a"),
    );
    expect(calls.filter((call) => call.startsWith("revoke:"))).toEqual([]);
  });

  it("invites only with full access, and revokes the code when the invite fails", async () => {
    const narrow = recordingOps();
    const outcomes = await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "auto",
      invite: true,
      ops: narrow.ops,
    });
    expect(outcomes.get("invite")).toEqual({ kind: "skipped", reason: "not_full_access" });
    expect(narrow.calls.filter((call) => call.startsWith("app:"))).toEqual([]);

    const refused = recordingOps({
      "invite:environment-b:environment-a:app-environment-a": new Error("refused"),
    });
    await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops: refused.ops,
    });
    expect(refused.calls).toContain("revoke:environment-a:app-link-environment-a");

    // The invite follows b's link to a, made now or kept from before, so a rerun retries it.
    const both = { "environment-a": "full-access", "environment-b": "full-access" } as const;
    const alreadyLinked = recordingOps({}, true, both);
    const kept = await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops: alreadyLinked.ops,
    });
    expect(kept.get("b_to_a")).toEqual({ kind: "kept", access: "full-access" });
    expect(kept.get("invite")).toEqual({ kind: "done" });
    // b keeps its narrower link to a, so the invite would give its app more: none is left.
    const onlyA = recordingOps({}, true, { "environment-b": "auto" });
    const narrowBack = await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops: onlyA.ops,
    });
    expect(narrowBack.get("a_to_b")).toEqual({ kind: "done" });
    expect(narrowBack.get("invite")).toEqual({ kind: "skipped", reason: "not_full_access" });
    expect(onlyA.calls.filter((call) => call.startsWith("app:"))).toEqual([]);
    const noBack = recordingOps({
      "link:environment-b->environment-a:code-environment-a": new Error("refused"),
    });
    const unlinked = await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops: noBack.ops,
    });
    expect(unlinked.get("a_to_b")).toEqual({ kind: "done" });
    expect(unlinked.get("invite")).toEqual({ kind: "skipped", reason: "not_linked" });
  });

  it("leaves linked directions alone and retries only what failed", async () => {
    const first = recordingOps({
      "link:environment-b->environment-a:code-environment-a": new PeerLinkError({
        reason: "unreachable",
        message: "a did not answer.",
      }),
    });
    const failed = await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "approval-required",
      invite: false,
      ops: first.ops,
    });
    expect(failed.get("a_to_b")).toEqual({ kind: "done" });
    expect(failed.get("b_to_a")).toEqual({
      kind: "failed",
      failure: "unreachable",
      detail: "a did not answer.",
    });
    expect(failed.get("invite")).toEqual({ kind: "skipped" });

    const retry = recordingOps({}, true, { "environment-a": "approval-required" });
    const retried = await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "approval-required",
      invite: false,
      ops: retry.ops,
    });
    expect(retried.get("a_to_b")).toEqual({ kind: "kept", access: "approval-required" });
    expect(retried.get("b_to_a")).toEqual({ kind: "done" });
    // The kept link and the failed one each revoke the code they left unused.
    expect(retry.calls).toContain("revoke:environment-b:link-code-environment-b");
    expect(first.calls).toContain("revoke:environment-a:link-code-environment-a");
  });

  it("does not link when links cannot be turned on, and names servers too old for a call", async () => {
    const { ops, calls } = recordingOps({
      "enable:environment-a": new Error("settings write refused"),
      "app:environment-a": NOT_FOUND,
    });
    const outcomes = await runLinkBothWays({
      a: side("a", { linkedEnvironmentsEnabled: false }),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops,
    });
    expect(outcomes.get("enable_a")).toEqual({ kind: "failed", failure: "other", detail: null });
    expect(outcomes.get("a_to_b")).toEqual({ kind: "failed", failure: "disabled", detail: null });
    expect(outcomes.get("b_to_a")).toEqual({ kind: "failed", failure: "disabled", detail: null });
    expect(outcomes.get("invite")).toEqual({ kind: "skipped", reason: "not_linked" });
    expect(calls.filter((call) => call.startsWith("mint:"))).toEqual([]);

    const older = await runLinkBothWays({
      a: side("a"),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops,
    });
    expect(older.get("invite")).toEqual({ kind: "failed", failure: "unsupported", detail: null });
  });

  it("sends the invite's code only to addresses that encrypt it", async () => {
    const { ops, calls } = recordingOps();
    const invited: Array<ReadonlyArray<string>> = [];
    const outcomes = await runLinkBothWays({
      a: side("a", {
        urls: ["http://192.168.1.5:3773", "https://a.example.ts.net", "http://a.tail.ts.net"],
      }),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops: {
        ...ops,
        createInvite: (environmentId, input) => {
          invited.push(input.urls);
          return ops.createInvite(environmentId, input);
        },
      },
    });
    expect(outcomes.get("invite")).toEqual({ kind: "done" });
    expect(invited).toEqual([["https://a.example.ts.net", "http://a.tail.ts.net"]]);

    const lanOnly = recordingOps();
    const skipped = await runLinkBothWays({
      a: side("a", { urls: ["http://192.168.1.5:3773"] }),
      b: side("b"),
      access: "full-access",
      invite: true,
      ops: lanOnly.ops,
    });
    expect(skipped.get("b_to_a")).toEqual({ kind: "done" });
    expect(skipped.get("invite")).toEqual({ kind: "skipped", reason: "no_safe_address" });
    expect(lanOnly.calls.filter((call) => call.startsWith("app:"))).toEqual([]);
    expect(calls.filter((call) => call.startsWith("revoke:"))).toEqual([]);
  });

  it("reports a lifetime the other side dropped and a side with no reachable address", async () => {
    const { ops } = recordingOps({}, false);
    const outcomes = await runLinkBothWays({
      a: side("a", { urls: [] }),
      b: side("b"),
      access: "full-access",
      lifetime: never,
      invite: true,
      ops,
    });
    expect(outcomes.get("a_to_b")).toEqual({ kind: "done", lifetimeIgnored: true });
    expect(outcomes.get("b_to_a")).toEqual({
      kind: "failed",
      failure: "no_address",
      detail: null,
    });
    expect(outcomes.get("invite")).toEqual({ kind: "skipped", reason: "not_linked" });
  });
});

describe("runRenewBothWays", () => {
  it("renews each link's session on the side it links to, and the client's own sessions", async () => {
    const renewed: Array<string> = [];
    const outcomes = await runRenewBothWays({
      a: {
        environmentId: EnvironmentId.make("a"),
        linkToOther: { status: "reachable", peerSessionId: AuthSessionId.make("link-on-b") },
        clientSessionId: AuthSessionId.make("client-on-a"),
      },
      b: {
        environmentId: EnvironmentId.make("b"),
        linkToOther: { status: "unreachable", peerSessionId: AuthSessionId.make("link-on-a") },
      },
      lifetime: never,
      ops: {
        renew: (environmentId, sessionId, lifetime, expectedSubject) => {
          renewed.push(`${environmentId}:${sessionId}:${lifetime._tag}:${expectedSubject}`);
          return Promise.resolve(Result.succeed({ renewed: true }));
        },
      },
    });
    // Link sessions are renewed only as peer links, so a wrong id cannot reach another session.
    expect(renewed.toSorted()).toEqual([
      "a:client-on-a:never:undefined",
      "a:link-on-a:never:mcp-client",
      "b:link-on-b:never:mcp-client",
    ]);
    expect(Object.fromEntries(outcomes)).toEqual({
      a_to_b: { kind: "done" },
      b_to_a: { kind: "done" },
      client_a: { kind: "done" },
      client_b: { kind: "skipped" },
    });
  });

  it("skips missing or expired links and names what it cannot renew", async () => {
    const outcomes = await runRenewBothWays({
      a: {
        environmentId: EnvironmentId.make("a"),
        linkToOther: { status: "reachable" },
        clientSessionId: AuthSessionId.make("gone"),
      },
      b: {
        environmentId: EnvironmentId.make("b"),
        linkToOther: { status: "expired", peerSessionId: AuthSessionId.make("old") },
        clientSessionId: AuthSessionId.make("client-on-b"),
      },
      lifetime: { _tag: "duration", millis: 1000 },
      ops: {
        renew: (environmentId) =>
          Promise.resolve(
            environmentId === "a" ? Result.succeed({ renewed: false }) : Result.fail(NOT_FOUND),
          ),
        isUnsupported: (failure) => failure === NOT_FOUND,
      },
    });
    expect(Object.fromEntries(outcomes)).toEqual({
      a_to_b: { kind: "failed", failure: "unknown_session" },
      b_to_a: { kind: "skipped" },
      client_a: { kind: "failed", failure: "not_found" },
      client_b: { kind: "failed", failure: "unsupported" },
    });

    // Links that could not be read are not the same as no link back.
    const unread = await runRenewBothWays({
      a: { environmentId: EnvironmentId.make("a") },
      b: { environmentId: EnvironmentId.make("b"), linkToOther: null },
      lifetime: never,
      ops: { renew: () => Promise.resolve(Result.succeed({ renewed: true })) },
    });
    expect(unread.get("a_to_b")).toEqual({ kind: "skipped" });
    expect(unread.get("b_to_a")).toEqual({ kind: "failed", failure: "unreadable" });
  });
});
