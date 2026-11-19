import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CopilotQuotaSnapshot = Schema.Struct({
  percent_remaining: Schema.Number,
  unlimited: Schema.Boolean,
});
const CopilotUserCache = Schema.Struct({
  copilotUserCache: Schema.Record(
    Schema.String,
    Schema.Struct({
      retrievedAt: Schema.String,
      response: Schema.Struct({
        token_based_billing: Schema.Boolean,
        quota_reset_date_utc: Schema.String,
        quota_snapshots: Schema.Struct({
          premium_interactions: Schema.optional(CopilotQuotaSnapshot),
        }),
      }),
    }),
  ),
});

type CopilotUserCacheEntry = (typeof CopilotUserCache.Type)["copilotUserCache"][string];

const decodeCopilotUserCache = Schema.decodeUnknownEffect(Schema.fromJsonString(CopilotUserCache));

function stripLeadingComments(contents: string): string {
  const lines = contents.split(/\r?\n/);
  const firstJsonLine = lines.findIndex((line) => !line.trimStart().startsWith("//"));
  return lines.slice(firstJsonLine < 0 ? lines.length : firstJsonLine).join("\n");
}

function monthlyWindowDurationMins(resetsAt: string): number | undefined {
  const reset = DateTime.make(resetsAt);
  if (Option.isNone(reset)) return undefined;
  const previous = DateTime.subtract(reset.value, { months: 1 });
  return Math.round(
    (DateTime.toEpochMillis(reset.value) - DateTime.toEpochMillis(previous)) / 60_000,
  );
}

export function copilotUsageEntryToLimits(entry: CopilotUserCacheEntry): ServerProviderUsageLimits {
  const checkedAt = entry.retrievedAt;
  const snapshot = entry.response.quota_snapshots.premium_interactions;
  if (snapshot === undefined || snapshot.unlimited) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const resetsAt = entry.response.quota_reset_date_utc;
  const windowDurationMins = monthlyWindowDurationMins(resetsAt);
  return makeUsageLimits({
    checkedAt,
    windows: [
      {
        id: "premium_interactions",
        kind: "monthly",
        label: entry.response.token_based_billing ? "Monthly credits" : "Premium requests",
        usedPercent: clampPercent(100 - snapshot.percent_remaining),
        resetsAt,
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      },
    ],
  });
}

function copilotUsageCacheToLimits(
  cache: typeof CopilotUserCache.Type,
): ServerProviderUsageLimits | undefined {
  const entries = Object.values(cache.copilotUserCache);
  const newest = entries.reduce<CopilotUserCacheEntry | undefined>(
    (current, entry) =>
      current === undefined || Date.parse(entry.retrievedAt) > Date.parse(current.retrievedAt)
        ? entry
        : current,
    undefined,
  );
  return newest === undefined ? undefined : copilotUsageEntryToLimits(newest);
}

function copilotCacheDirectory(
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  platform: string = HostProcess.Platform.defaultValue(),
): string {
  if (environment.COPILOT_CACHE_HOME) return environment.COPILOT_CACHE_HOME;
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const cacheRoot =
    platform === "darwin"
      ? path.join(home, "Library", "Caches")
      : platform === "win32"
        ? (environment.LOCALAPPDATA ?? path.join(home, ".cache"))
        : (environment.XDG_CACHE_HOME ?? path.join(home, ".cache"));
  return path.join(cacheRoot, "copilot");
}

export const readCopilotUsageLimits = Effect.fn("readCopilotUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Start a Copilot session to load its quota.",
  });
  return yield* fileSystem
    .readFileString(path.join(copilotCacheDirectory(environment, path), "copilot-user-cache.json"))
    .pipe(
      Effect.flatMap((contents) => decodeCopilotUserCache(stripLeadingComments(contents))),
      Effect.map(copilotUsageCacheToLimits),
      Effect.map((limits) => limits ?? probeFailed),
      Effect.orElseSucceed(() => probeFailed),
    );
});
