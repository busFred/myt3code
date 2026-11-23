import type { AuthPendingAppInvite } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type AppInvitePickupDeps,
  appInviteSignal,
  pickUpAppInvites,
  shouldTakeAppInvites,
  singleFlightWithFollowUp,
} from "./appInvitePickup";

const invite = (id: string, urls: ReadonlyArray<string>) =>
  ({
    id: `invite-${id}`,
    environmentId: EnvironmentId.make(id),
    label: `Machine ${id}`,
    urls,
    credential: `code-${id}`,
  }) as unknown as AuthPendingAppInvite;

function setup(overrides: Partial<AppInvitePickupDeps> & { invites?: AuthPendingAppInvite[] }) {
  const pair = vi.fn<AppInvitePickupDeps["pair"]>(async () => ({ ok: true }));
  const log = vi.fn<AppInvitePickupDeps["log"]>();
  const deps: AppInvitePickupDeps = {
    isDesktop: true,
    take: async () => ({ _tag: "Taken", invites: overrides.invites ?? [] }),
    isHandled: () => false,
    pair,
    log,
    ...overrides,
  };
  return { deps, pair, log };
}

describe("pickUpAppInvites", () => {
  it("does nothing outside the desktop app", async () => {
    const take = vi.fn(async () => ({ _tag: "Taken" as const, invites: [invite("a", ["x"])] }));
    const { deps, pair } = setup({ isDesktop: false, take });
    expect(await pickUpAppInvites(deps)).toBe(0);
    expect(take).not.toHaveBeenCalled();
    expect(pair).not.toHaveBeenCalled();
  });

  it("ignores servers without the endpoint", async () => {
    const { deps, pair, log } = setup({ take: async () => ({ _tag: "Unsupported" }) });
    expect(await pickUpAppInvites(deps)).toBe(0);
    expect(pair).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a failed check", async () => {
    const { deps, log } = setup({ take: async () => ({ _tag: "Failed", error: "boom" }) });
    expect(await pickUpAppInvites(deps)).toBe(0);
    expect(log).toHaveBeenCalledOnce();
  });

  it("skips environments that are already handled", async () => {
    const { deps, pair } = setup({
      invites: [invite("a", ["https://a"]), invite("b", ["https://b"])],
      isHandled: (id) => id === EnvironmentId.make("a"),
    });
    expect(await pickUpAppInvites(deps)).toBe(1);
    expect(pair).toHaveBeenCalledOnce();
    expect(pair).toHaveBeenCalledWith({
      host: "https://b",
      pairingCode: "code-b",
      expectedEnvironmentId: EnvironmentId.make("b"),
    });
  });

  it("tries addresses in order until one works, never over plain http", async () => {
    const { deps, pair, log } = setup({
      invites: [
        invite("a", [
          "http://192.168.1.5:3773",
          "https://1.example",
          "http://box.tail.ts.net",
          "https://3.example",
        ]),
      ],
    });
    pair.mockResolvedValueOnce({ ok: false, error: "down" }).mockResolvedValueOnce({ ok: true });
    expect(await pickUpAppInvites(deps)).toBe(1);
    expect(pair.mock.calls.map(([input]) => input.host)).toEqual([
      "https://1.example",
      "http://box.tail.ts.net",
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs an invite with only plain http addresses and sends its code nowhere", async () => {
    const { deps, pair, log } = setup({ invites: [invite("a", ["http://192.168.1.5:3773"])] });
    expect(await pickUpAppInvites(deps)).toBe(0);
    expect(pair).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it("logs the invite when every address fails and carries on with the next", async () => {
    const { deps, pair, log } = setup({
      invites: [invite("a", ["https://1"]), invite("b", ["https://2"])],
    });
    pair.mockResolvedValueOnce({ ok: false, error: "down" });
    expect(await pickUpAppInvites(deps)).toBe(1);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain("Machine a");
  });
});

describe("shouldTakeAppInvites", () => {
  const NOW = 1_000;
  const take = (
    snapshot: {
      readonly appInvites?: ReadonlyArray<{ readonly expiresAt: { epochMilliseconds: number } }>;
    } | null,
    failed: boolean,
    checkedAtLaunch: boolean,
  ) => shouldTakeAppInvites(appInviteSignal({ snapshot, failed }, NOW), checkedAtLaunch);

  it("takes only when the snapshot lists invites that have not expired", () => {
    const live = { expiresAt: { epochMilliseconds: NOW + 1 } };
    const expired = { expiresAt: { epochMilliseconds: NOW } };
    expect(take({ appInvites: [expired, live] }, false, true)).toBe(true);
    expect(take({ appInvites: [expired] }, false, false)).toBe(false);
    expect(take({ appInvites: [] }, false, false)).toBe(false);
    expect(take(null, false, false)).toBe(false);
  });

  it("checks once at launch when no snapshot says", () => {
    // A server that predates invites, or an access stream that failed.
    expect(take({}, false, false)).toBe(true);
    expect(take({}, false, true)).toBe(false);
    expect(take(null, true, false)).toBe(true);
    expect(take(null, true, true)).toBe(false);
  });
});

describe("singleFlightWithFollowUp", () => {
  it("runs once more after a run that was triggered again, however often", async () => {
    let release = () => {};
    let runs = 0;
    const trigger = singleFlightWithFollowUp(async () => {
      runs += 1;
      if (runs === 1) await new Promise<void>((resolve) => (release = resolve));
    });
    const first = trigger();
    void trigger();
    void trigger();
    expect(runs).toBe(1);
    release();
    await first;
    expect(runs).toBe(2);
    await trigger();
    expect(runs).toBe(3);
  });
});
