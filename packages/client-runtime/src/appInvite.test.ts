import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { type AppInviteOps, inviteDesktopApp } from "./appInvite.ts";

const host = (urls: ReadonlyArray<string>) => ({
  environmentId: EnvironmentId.make("environment-a"),
  label: "a",
  urls,
});
const app = { environmentId: EnvironmentId.make("environment-b"), label: "b" };
const NOT_FOUND = { status: 404 };

/** Records every call; `fail` names calls that fail, as `<op>:<environment>`. */
const recordingOps = (fail: Record<string, unknown> = {}) => {
  const calls: Array<string> = [];
  const invited: Array<ReadonlyArray<string>> = [];
  const result = <A>(key: string, success: A) => {
    calls.push(key);
    return Promise.resolve(key in fail ? Result.fail(fail[key]) : Result.succeed(success));
  };
  const ops: AppInviteOps = {
    mintAppCode: (environmentId) =>
      result(`app:${environmentId}`, {
        id: `app-link-${environmentId}`,
        credential: `app-${environmentId}`,
        expiresAt: DateTime.makeUnsafe(0),
      }),
    createInvite: (environmentId, input) => {
      invited.push(input.urls);
      return result(`invite:${environmentId}:${input.environmentId}:${input.credential}`, {});
    },
    revokeCode: (environmentId, id) => result(`revoke:${environmentId}:${id}`, undefined),
    isUnsupported: (failure) => failure === NOT_FOUND,
    appConnectionUrl: () => "https://b.example.ts.net",
  };
  return { ops, calls, invited };
};

describe("inviteDesktopApp", () => {
  it("invites only with full access, and revokes the code when the invite fails", async () => {
    const narrow = recordingOps();
    expect(
      await inviteDesktopApp({
        host: host(["https://a.example.ts.net"]),
        app,
        appLinkAccess: "auto",
        ops: narrow.ops,
      }),
    ).toEqual({ kind: "skipped", reason: "not_full_access" });
    expect(narrow.calls).toEqual([]);

    const done = recordingOps();
    expect(
      await inviteDesktopApp({
        host: host(["https://a.example.ts.net"]),
        app,
        appLinkAccess: "full-access",
        ops: done.ops,
      }),
    ).toEqual({ kind: "invited" });
    expect(done.calls).toEqual([
      "app:environment-a",
      "invite:environment-b:environment-a:app-environment-a",
    ]);

    const refused = recordingOps({
      "invite:environment-b:environment-a:app-environment-a": new Error("refused"),
    });
    expect(
      await inviteDesktopApp({
        host: host(["https://a.example.ts.net"]),
        app,
        appLinkAccess: "full-access",
        ops: refused.ops,
      }),
    ).toEqual({ kind: "failed", failure: "other" });
    expect(refused.calls).toContain("revoke:environment-a:app-link-environment-a");

    // A request that throws leaves the code unused as well.
    const thrown = recordingOps();
    expect(
      await inviteDesktopApp({
        host: host(["https://a.example.ts.net"]),
        app,
        appLinkAccess: "full-access",
        ops: { ...thrown.ops, createInvite: () => Promise.reject(new Error("offline")) },
      }),
    ).toEqual({ kind: "failed", failure: "other" });
    expect(thrown.calls).toContain("revoke:environment-a:app-link-environment-a");
  });

  it("sends the code only over a connection to the app's machine that encrypts it", async () => {
    for (const [url, sent] of [
      ["http://192.168.1.9:3773", false],
      [null, false],
      ["http://b.tail1234.ts.net:3773", true],
      ["https://b.example.com", true],
    ] as const) {
      const { ops, calls } = recordingOps();
      const outcome = await inviteDesktopApp({
        host: host(["https://a.example.ts.net"]),
        app,
        appLinkAccess: "full-access",
        ops: { ...ops, appConnectionUrl: () => url },
      });
      expect(outcome, String(url)).toEqual(
        sent ? { kind: "invited" } : { kind: "skipped", reason: "unsafe_connection" },
      );
      // Nothing is minted for an invite that cannot be sent.
      expect(calls.length > 0, String(url)).toBe(sent);
    }
  });

  it("sends the invite's code only to addresses that encrypt it", async () => {
    const { ops, calls, invited } = recordingOps();
    await inviteDesktopApp({
      host: host(["http://192.168.1.5:3773", "https://a.example.ts.net", "http://a.tail.ts.net"]),
      app,
      appLinkAccess: "full-access",
      ops,
    });
    expect(invited).toEqual([["https://a.example.ts.net", "http://a.tail.ts.net"]]);

    const lanOnly = recordingOps();
    expect(
      await inviteDesktopApp({
        host: host(["http://192.168.1.5:3773"]),
        app,
        appLinkAccess: "full-access",
        ops: lanOnly.ops,
      }),
    ).toEqual({ kind: "skipped", reason: "no_safe_address" });
    expect(lanOnly.calls).toEqual([]);
    expect(calls.filter((call) => call.startsWith("revoke:"))).toEqual([]);
  });

  it("names servers too old for a call and a code that could not be minted", async () => {
    const older = recordingOps({
      "invite:environment-b:environment-a:app-environment-a": NOT_FOUND,
    });
    expect(
      await inviteDesktopApp({
        host: host(["https://a.example.ts.net"]),
        app,
        appLinkAccess: "full-access",
        ops: older.ops,
      }),
    ).toEqual({ kind: "failed", failure: "unsupported" });
    const noCode = recordingOps({ "app:environment-a": new Error("forbidden") });
    expect(
      await inviteDesktopApp({
        host: host(["https://a.example.ts.net"]),
        app,
        appLinkAccess: "full-access",
        ops: noCode.ops,
      }),
    ).toEqual({ kind: "failed", failure: "no_code" });
  });
});
