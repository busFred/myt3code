import { AuthSessionId, type AuthSessionLifetime, EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { peerLinkLifetimeDropped, renewPeerLink } from "./linkExpiry.ts";

const never: AuthSessionLifetime = { _tag: "never" };
const NOT_FOUND = { status: 404 };
const link = (peerSessionId?: string) => ({
  environmentId: EnvironmentId.make("b"),
  ...(peerSessionId === undefined ? {} : { peerSessionId: AuthSessionId.make(peerSessionId) }),
});

describe("renewPeerLink", () => {
  it("renews the link's session on the machine it reaches, only as a peer link's session", async () => {
    const renewed: Array<string> = [];
    const outcome = await renewPeerLink({
      link: link("link-on-b"),
      lifetime: never,
      ops: {
        renew: (environmentId, input) => {
          renewed.push(
            `${environmentId}:${input.sessionId}:${input.lifetime._tag}:${input.expectedSubject}`,
          );
          return Promise.resolve(Result.succeed({ renewed: true }));
        },
        refreshSource: () => {
          renewed.push("refresh");
          return Promise.resolve(Result.succeed(undefined));
        },
      },
    });
    // A wrong id cannot reach another kind of session there.
    expect(renewed).toEqual(["b:link-on-b:never:mcp-client", "refresh"]);
    expect(outcome).toEqual({ kind: "done", sourceUpdated: true });
  });

  it("says when the linking side still shows the old expiry", async () => {
    // It learns a shorter expiry only when asked, so renewing again retries the ask.
    const outcome = await renewPeerLink({
      link: link("link-on-b"),
      lifetime: { _tag: "duration", millis: 1000 },
      ops: {
        renew: () => Promise.resolve(Result.succeed({ renewed: true })),
        refreshSource: () => Promise.reject(new Error("offline")),
      },
    });
    expect(outcome).toEqual({ kind: "done", sourceUpdated: false });
    const answered = await renewPeerLink({
      link: link("link-on-b"),
      lifetime: never,
      ops: {
        renew: () => Promise.resolve(Result.succeed({ renewed: true })),
        refreshSource: () => Promise.resolve(Result.fail({ status: 404 })),
      },
    });
    expect(answered).toEqual({ kind: "done", sourceUpdated: false });
  });

  it("names what it cannot renew", async () => {
    const calls: Array<string> = [];
    const renew = (result: Result.Result<{ readonly renewed: boolean }, unknown>) => ({
      renew: (environmentId: EnvironmentId) => {
        calls.push(environmentId);
        return Promise.resolve(result);
      },
      isUnsupported: (failure: unknown) => failure === NOT_FOUND,
      refreshSource: () => Promise.resolve(Result.succeed(undefined)),
    });
    expect(
      await renewPeerLink({
        link: link(),
        lifetime: never,
        ops: renew(Result.succeed({ renewed: true })),
      }),
    ).toEqual({ kind: "failed", failure: "unknown_session" });
    expect(calls).toEqual([]);
    expect(
      await renewPeerLink({
        link: link("gone"),
        lifetime: { _tag: "duration", millis: 1000 },
        ops: renew(Result.succeed({ renewed: false })),
      }),
    ).toEqual({ kind: "failed", failure: "not_found" });
    expect(
      await renewPeerLink({
        link: link("old"),
        lifetime: never,
        ops: renew(Result.fail(NOT_FOUND)),
      }),
    ).toEqual({ kind: "failed", failure: "unsupported" });
    expect(
      await renewPeerLink({
        link: link("x"),
        lifetime: never,
        ops: {
          renew: () => Promise.reject(new Error("offline")),
          refreshSource: () => Promise.resolve(Result.succeed(undefined)),
        },
      }),
    ).toEqual({ kind: "failed", failure: "other" });
  });
});

describe("peerLinkLifetimeDropped", () => {
  it.each([
    [undefined, undefined, false],
    [never, never, false],
    [never, undefined, true],
    [{ _tag: "duration", millis: 1000 }, undefined, true],
  ] as const)("asked %j, got %j", (requested, minted, dropped) => {
    expect(peerLinkLifetimeDropped(requested, minted)).toBe(dropped);
  });
});
