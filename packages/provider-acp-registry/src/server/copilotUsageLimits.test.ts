import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copilotUsageEntryToLimits, readCopilotUsageLimits } from "./copilotUsageLimits.ts";

const retrievedAt = "2026-11-18T23:37:24.815Z";
const resetsAt = "2026-12-01T00:00:00.000Z";
const entry = (input: {
  readonly retrievedAt?: string;
  readonly tokenBasedBilling?: boolean;
  readonly percentRemaining?: number;
  readonly unlimited?: boolean;
}) => ({
  retrievedAt: input.retrievedAt ?? retrievedAt,
  response: {
    token_based_billing: input.tokenBasedBilling ?? true,
    quota_reset_date_utc: resetsAt,
    quota_snapshots: {
      premium_interactions: {
        percent_remaining: input.percentRemaining ?? 42,
        unlimited: input.unlimited ?? false,
      },
    },
  },
});

describe("copilotUsageEntryToLimits", () => {
  it.effect.each([
    ["Monthly credits", true],
    ["Premium requests", false],
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
});

it.layer(NodeServices.layer)("readCopilotUsageLimits", (it) => {
  it.effect("parses comments and selects the newest cache entry", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheHome = yield* fileSystem.makeTempDirectoryScoped();
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
            },
          }),
        ].join("\n"),
      );

      const limits = yield* readCopilotUsageLimits({ COPILOT_CACHE_HOME: cacheHome });

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
