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
  readonly resetDate?: string | undefined;
}) => ({
  retrievedAt: Object.hasOwn(input, "retrievedAt") ? input.retrievedAt! : retrievedAt,
  response: {
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
      },
    },
  },
});

describe("copilotUsageEntryToLimits", () => {
  it.effect.each([
    ["Monthly credits", true],
    ["Premium requests", false],
    ["Premium requests", undefined],
  ] as const)("labels token billing usage as %s", ([label, tokenBasedBilling]) =>
    Effect.sync(() => {
      expect(copilotUsageEntryToLimits(entry({ tokenBasedBilling })).windows[0]).toMatchObject({
        id: "premium_interactions",
        kind: "monthly",
        label,
        usedPercent: 58,
        resetsAt,
        windowDurationMins: 43_200,
      });
    }),
  );

  it.effect("reports unlimited premium interactions as unsupported", () =>
    Effect.sync(() => {
      expect(copilotUsageEntryToLimits(entry({ unlimited: true }))).toEqual({
        checkedAt: retrievedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      });
    }),
  );

  it.effect("reports missing premium interactions as unsupported", () =>
    Effect.sync(() => {
      expect(
        copilotUsageEntryToLimits({
          retrievedAt,
          response: {
            token_based_billing: false,
            quota_reset_date_utc: resetsAt,
            quota_snapshots: {},
          },
        }),
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
      expect(copilotUsageEntryToLimits(entry({ percentRemaining }))).toEqual({
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
      expect(copilotUsageEntryToLimits(entry({ resetDate })).windows[0]).toEqual({
        id: "premium_interactions",
        kind: "monthly",
        label: "Monthly credits",
        usedPercent: 58,
      });
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
            },
          }),
        ].join("\n"),
      );

      const limits = yield* readCopilotUsageLimits({ HOME: home }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
      );

      expect(limits.checkedAt).toBe(retrievedAt);
      expect(limits.windows[0]?.usedPercent).toBe(75);
    }),
  );

  it.effect("reports a missing cache as a probe failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheHome = yield* fileSystem.makeTempDirectoryScoped();

      const limits = yield* readCopilotUsageLimits({ COPILOT_CACHE_HOME: cacheHome });

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
