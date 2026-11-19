import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copilotUsageEntryToLimits, readCopilotUsageLimits } from "./copilotUsageLimits.ts";

const retrievedAt = "2026-11-18T23:37:24.815Z";
const resetsAt = "2026-12-01T00:00:00.000Z";
const entry = (input: {
  readonly retrievedAt?: string | undefined;
  readonly tokenBasedBilling?: boolean | undefined;
  readonly percentRemaining?: number | undefined;
  readonly unlimited?: boolean | undefined;
  readonly overagePermitted?: boolean | undefined;
  readonly resetDate?: string | undefined;
  readonly login?: string | undefined;
}) => ({
  retrievedAt: Object.hasOwn(input, "retrievedAt") ? input.retrievedAt! : retrievedAt,
  response: {
    ...("login" in input ? { login: input.login } : {}),
    ...("tokenBasedBilling" in input
      ? { token_based_billing: input.tokenBasedBilling }
      : { token_based_billing: true }),
    ...("resetDate" in input
      ? { quota_reset_date_utc: input.resetDate }
      : {
          quota_reset_date_utc: resetsAt,
        }),
    quota_snapshots: {
      premium_interactions: {
        ...("percentRemaining" in input
          ? { percent_remaining: input.percentRemaining }
          : { percent_remaining: 42 }),
        ...("unlimited" in input ? { unlimited: input.unlimited } : { unlimited: false }),
        ...("overagePermitted" in input
          ? { overage_permitted: input.overagePermitted }
          : { overage_permitted: false }),
      },
    },
  },
});

const now = Date.parse("2026-11-19T00:00:00.000Z");

describe("copilotUsageEntryToLimits", () => {
  it.effect.each([
    ["monthly_credits", "Monthly credits", true],
    ["premium_requests", "Premium requests", false],
    ["premium_requests", "Premium requests", undefined],
  ] as const)("labels token billing usage as %s", ([id, label, tokenBasedBilling]) =>
    Effect.sync(() => {
      expect(copilotUsageEntryToLimits(entry({ tokenBasedBilling }), now).windows[0]).toMatchObject(
        {
          id,
          kind: "monthly",
          label,
          usedPercent: 58,
          resetsAt,
          windowDurationMins: 43_200,
        },
      );
    }),
  );

  it.effect("reports unlimited premium interactions as unsupported", () =>
    Effect.sync(() => {
      expect(copilotUsageEntryToLimits(entry({ unlimited: true }), now)).toEqual({
        checkedAt: retrievedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      });
    }),
  );

  it.effect("reports missing premium interactions as unsupported", () =>
    Effect.sync(() => {
      expect(
        copilotUsageEntryToLimits(
          {
            retrievedAt,
            response: {
              token_based_billing: false,
              quota_reset_date_utc: resetsAt,
              quota_snapshots: {},
            },
          },
          now,
        ),
      ).toEqual({
        checkedAt: retrievedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      });
    }),
  );

  it.effect.each([
    ["missing", undefined],
    ["non-finite", Number.POSITIVE_INFINITY],
  ] as const)("reports %s percent remaining as unsupported", ([, percentRemaining]) =>
    Effect.sync(() => {
      expect(copilotUsageEntryToLimits(entry({ percentRemaining }), now)).toEqual({
        checkedAt: retrievedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      });
    }),
  );

  it.effect.each([
    ["missing", undefined],
    ["invalid", "not-a-date"],
  ] as const)("omits reset information when the reset date is %s", ([, resetDate]) =>
    Effect.sync(() => {
      expect(copilotUsageEntryToLimits(entry({ resetDate }), now).windows[0]).toEqual({
        id: "monthly_credits",
        kind: "monthly",
        label: "Monthly credits",
        usedPercent: 58,
      });
    }),
  );

  it.effect("treats a past reset as a renewed zero-use allowance", () =>
    Effect.sync(() => {
      expect(
        copilotUsageEntryToLimits(entry({ resetDate: "2026-11-19T00:00:00.000Z" }), now),
      ).toMatchObject({
        windows: [
          {
            id: "monthly_credits",
            usedPercent: 0,
          },
        ],
      });
      expect(
        copilotUsageEntryToLimits(entry({ resetDate: "2026-11-18T00:00:00.000Z" }), now).windows[0],
      ).not.toHaveProperty("resetsAt");
      expect(
        copilotUsageEntryToLimits(entry({ resetDate: "2026-11-18T00:00:00.000Z" }), now).windows[0],
      ).not.toHaveProperty("windowDurationMins");
    }),
  );

  it.effect.each([
    ["overage billing", { percentRemaining: 0, overagePermitted: true }],
    ["a missing reset", { percentRemaining: 0, resetDate: undefined }],
  ] as const)("caps exhausted usage with %s at 99.9 percent", ([, input]) =>
    Effect.sync(() => {
      expect(copilotUsageEntryToLimits(entry(input), now).windows[0]?.usedPercent).toBe(99.9);
    }),
  );
});

it.layer(NodeServices.layer)("readCopilotUsageLimits", (it) => {
  it.effect("parses comments and selects the newest cache entry", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const cacheHome = path.join(home, "Library", "Caches", "copilot");
      const copilotHome = path.join(home, "config");
      yield* fileSystem.makeDirectory(cacheHome, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cacheHome, "copilot-user-cache.json"),
        [
          "// Copilot user cache",
          "// Generated automatically",
          JSON.stringify({
            copilotUserCache: {
              older: entry({
                retrievedAt: "2026-11-17T12:00:00.000Z",
                percentRemaining: 90,
              }),
              newer: {
                ...entry({ percentRemaining: 25 }),
                ignored: { personal: "not retained" },
              },
              invalid: entry({
                retrievedAt: "not-a-date",
                percentRemaining: 0,
              }),
              malformed: { retrievedAt: 42, response: null },
            },
          }),
        ].join("\n"),
      );

      const limits = yield* readCopilotUsageLimits({ HOME: home, COPILOT_HOME: copilotHome }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
      );

      expect(limits.checkedAt).toBe(retrievedAt);
      expect(limits.windows[0]?.usedPercent).toBe(75);
    }),
  );

  it.effect("tolerates null optional cache fields", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheHome = yield* fileSystem.makeTempDirectoryScoped();
      const copilotHome = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(cacheHome, "copilot-user-cache.json"),
        JSON.stringify({
          copilotUserCache: {
            nullable: {
              retrievedAt,
              response: {
                login: null,
                token_based_billing: null,
                quota_reset_date_utc: null,
                quota_snapshots: {
                  premium_interactions: {
                    percent_remaining: 42,
                    unlimited: null,
                    overage_permitted: null,
                  },
                },
              },
            },
          },
        }),
      );

      const limits = yield* readCopilotUsageLimits({
        COPILOT_CACHE_HOME: cacheHome,
        COPILOT_HOME: copilotHome,
      });

      expect(limits.windows[0]?.usedPercent).toBe(58);
      expect(limits.unavailable).toBeUndefined();
    }),
  );

  it.effect.each([
    ["the matching account", true, 80],
    ["probe failure when the matching account is absent", false, undefined],
  ] as const)("selects %s from a known login", ([, includesMatch, usedPercent]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheHome = yield* fileSystem.makeTempDirectoryScoped();
      const copilotHome = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(
        path.join(copilotHome, "config.json"),
        [
          "// Copilot config",
          JSON.stringify({ lastLoggedInUser: { host: "github.com", login: "Ada" } }),
        ].join("\n"),
      );
      yield* fileSystem.writeFileString(
        path.join(cacheHome, "copilot-user-cache.json"),
        JSON.stringify({
          copilotUserCache: {
            match: entry({
              retrievedAt: "2026-11-17T12:00:00.000Z",
              login: includesMatch ? "ada" : "grace",
              percentRemaining: 20,
            }),
            other: entry({
              login: "other",
              percentRemaining: 10,
            }),
          },
        }),
      );

      const limits = yield* readCopilotUsageLimits({
        COPILOT_CACHE_HOME: cacheHome,
        COPILOT_HOME: copilotHome,
      });

      expect(limits.windows[0]?.usedPercent).toBe(usedPercent);
      if (usedPercent === undefined) expect(limits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect("falls back to the home cache when XDG_CACHE_HOME is empty", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const copilotHome = path.join(home, ".copilot");
      const cacheHome = path.join(home, ".cache", "copilot");
      yield* fileSystem.makeDirectory(cacheHome, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cacheHome, "copilot-user-cache.json"),
        JSON.stringify({ copilotUserCache: { current: entry({ percentRemaining: 12 }) } }),
      );

      const limits = yield* readCopilotUsageLimits({
        HOME: home,
        XDG_CACHE_HOME: "",
        COPILOT_HOME: copilotHome,
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"));

      expect(limits.windows[0]?.usedPercent).toBe(88);
    }),
  );

  it.effect("reports a missing cache as a probe failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheHome = yield* fileSystem.makeTempDirectoryScoped();
      const copilotHome = yield* fileSystem.makeTempDirectoryScoped();

      const limits = yield* readCopilotUsageLimits({
        COPILOT_CACHE_HOME: cacheHome,
        COPILOT_HOME: copilotHome,
      });

      expect(limits).toMatchObject({
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "Start a Copilot session to load its quota.",
        },
      });
      expect(Number.isFinite(Date.parse(limits.checkedAt))).toBe(true);
    }),
  );
});
