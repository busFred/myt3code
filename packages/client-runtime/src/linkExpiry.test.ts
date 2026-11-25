import { AuthSessionId, type AuthSessionLifetime, EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { renewPeerLink } from "./linkExpiry.ts";

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
      },
    });
    // A wrong id cannot reach another kind of session there.
    expect(renewed).toEqual(["b:link-on-b:never:mcp-client"]);
    expect(outcome).toEqual({ kind: "done" });
  });

  it("names what it cannot renew", async () => {
    const calls: Array<string> = [];
    const renew = (result: Result.Result<{ readonly renewed: boolean }, unknown>) => ({
      renew: (environmentId: EnvironmentId) => {
        calls.push(environmentId);
        return Promise.resolve(result);
      },
      isUnsupported: (failure: unknown) => failure === NOT_FOUND,
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
        ops: { renew: () => Promise.reject(new Error("offline")) },
      }),
    ).toEqual({ kind: "failed", failure: "other" });
  });
});
