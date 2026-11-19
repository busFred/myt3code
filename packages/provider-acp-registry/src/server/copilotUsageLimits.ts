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
  percent_remaining: Schema.optional(Schema.NullOr(Schema.Number)),
  unlimited: Schema.optional(Schema.NullOr(Schema.Boolean)),
  overage_permitted: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const CopilotUserCacheEntry = Schema.Struct({
  retrievedAt: Schema.String,
  response: Schema.Struct({
    login: Schema.optional(Schema.NullOr(Schema.String)),
    token_based_billing: Schema.optional(Schema.NullOr(Schema.Boolean)),
    quota_reset_date_utc: Schema.optional(Schema.NullOr(Schema.String)),
    quota_snapshots: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          premium_interactions: Schema.optional(Schema.NullOr(CopilotQuotaSnapshot)),
        }),
      ),
    ),
  }),
});
const CopilotUserCache = Schema.Struct({
  copilotUserCache: Schema.Record(Schema.String, Schema.Unknown),
});
const CopilotConfig = Schema.Struct({
  lastLoggedInUser: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        host: Schema.optional(Schema.NullOr(Schema.String)),
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

type CopilotUserCacheEntry = typeof CopilotUserCacheEntry.Type;

const decodeCopilotUserCache = Schema.decodeUnknownEffect(Schema.fromJsonString(CopilotUserCache));
const decodeCopilotUserCacheEntry = Schema.decodeUnknownOption(CopilotUserCacheEntry);
const decodeCopilotConfig = Schema.decodeUnknownOption(Schema.fromJsonString(CopilotConfig));

function stripLeadingComments(contents: string): string {
  const lines = contents.split(/\r?\n/);
  const firstJsonLine = lines.findIndex((line) => !line.trimStart().startsWith("//"));
  return lines.slice(firstJsonLine < 0 ? lines.length : firstJsonLine).join("\n");
}

function copilotUserCacheEntries(cache: typeof CopilotUserCache.Type): CopilotUserCacheEntry[] {
  return Object.values(cache.copilotUserCache).flatMap((candidate) => {
    const decoded = decodeCopilotUserCacheEntry(candidate);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
}

function signedInLogin(contents: string): string | undefined {
  const config = decodeCopilotConfig(stripLeadingComments(contents));
  if (Option.isNone(config)) return undefined;
  const login = config.value.lastLoggedInUser?.login?.trim();
  return login || undefined;
}

function monthlyWindowDurationMins(resetsAt: string): number | undefined {
  const reset = DateTime.make(resetsAt);
  if (Option.isNone(reset)) return undefined;
  const previous = DateTime.subtract(reset.value, { months: 1 });
  return Math.round(
    (DateTime.toEpochMillis(reset.value) - DateTime.toEpochMillis(previous)) / 60_000,
  );
}

function formatIsoDateTime(value: string): string | undefined {
  const date = DateTime.make(value);
  return Option.isNone(date) ? undefined : DateTime.formatIso(date.value);
}

export function copilotUsageEntryToLimits(
  entry: CopilotUserCacheEntry,
  now: number,
): ServerProviderUsageLimits {
  const checkedAt = formatIsoDateTime(entry.retrievedAt) ?? entry.retrievedAt;
  const snapshot = entry.response.quota_snapshots?.premium_interactions;
  if (
    snapshot === undefined ||
    snapshot === null ||
    snapshot.unlimited === true ||
    snapshot.percent_remaining === undefined ||
    snapshot.percent_remaining === null ||
    !Number.isFinite(snapshot.percent_remaining)
  ) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const tokenBilling = entry.response.token_based_billing === true;
  const window = {
    id: tokenBilling ? "monthly_credits" : "premium_requests",
    kind: "monthly" as const,
    label: tokenBilling ? "Monthly credits" : "Premium requests",
  };
  const resetDate =
    typeof entry.response.quota_reset_date_utc === "string"
      ? DateTime.make(entry.response.quota_reset_date_utc)
      : Option.none();
  // The allowance has renewed since this snapshot; Copilot's next run refreshes the cache.
  if (Option.isSome(resetDate) && DateTime.toEpochMillis(resetDate.value) <= now) {
    return makeUsageLimits({ checkedAt, windows: [{ ...window, usedPercent: 0 }] });
  }
  const resetsAt = Option.isSome(resetDate) ? DateTime.formatIso(resetDate.value) : undefined;
  const windowDurationMins =
    resetsAt === undefined ? undefined : monthlyWindowDurationMins(resetsAt);
  const usedPercent = clampPercent(100 - snapshot.percent_remaining);
  return makeUsageLimits({
    checkedAt,
    windows: [
      {
        ...window,
        // Copilot remains usable through overage billing, or without a known hard-limit reset.
        usedPercent:
          snapshot.overage_permitted === true || resetsAt === undefined
            ? Math.min(usedPercent, 99.9)
            : usedPercent,
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      },
    ],
  });
}

function copilotUsageCacheToLimits(
  cache: typeof CopilotUserCache.Type,
  login: string | undefined,
  now: number,
): ServerProviderUsageLimits | undefined {
  const entries = copilotUserCacheEntries(cache);
  const candidates =
    login === undefined
      ? entries
      : entries.filter((entry) => entry.response.login?.toLowerCase() === login.toLowerCase());
  const newest = candidates.reduce<CopilotUserCacheEntry | undefined>((current, entry) => {
    const retrievedAt = DateTime.make(entry.retrievedAt);
    if (Option.isNone(retrievedAt)) return current;
    const currentRetrievedAt =
      current === undefined ? Option.none() : DateTime.make(current.retrievedAt);
    return Option.isNone(currentRetrievedAt) ||
      DateTime.toEpochMillis(retrievedAt.value) > DateTime.toEpochMillis(currentRetrievedAt.value)
      ? entry
      : current;
  }, undefined);
  return newest === undefined ? undefined : copilotUsageEntryToLimits(newest, now);
}

function absoluteHome(environment: NodeJS.ProcessEnv, path: Path.Path, hostHome: string): string {
  const configured = environment.HOME || environment.USERPROFILE || hostHome;
  return path.isAbsolute(configured) ? configured : path.resolve(hostHome, configured);
}

function copilotCacheDirectory(
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (environment.COPILOT_CACHE_HOME) return environment.COPILOT_CACHE_HOME;
  const cacheRoot =
    platform === "darwin"
      ? path.join(home, "Library", "Caches")
      : platform === "win32"
        ? environment.LOCALAPPDATA || path.join(home, ".cache")
        : environment.XDG_CACHE_HOME || path.join(home, ".cache");
  return path.join(cacheRoot, "copilot");
}

export const readCopilotUsageLimits = Effect.fn("readCopilotUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const currentTime = yield* DateTime.now;
  const now = DateTime.toEpochMillis(currentTime);
  const checkedAt = DateTime.formatIso(currentTime);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const hostHome = yield* HostProcess.HomeDirectory;
  const home = absoluteHome(environment, path, hostHome);
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Start a Copilot session to load its quota.",
  });
  const configHome = environment.COPILOT_HOME || path.join(home, ".copilot");
  const login = yield* fileSystem.readFileString(path.join(configHome, "config.json")).pipe(
    Effect.map(signedInLogin),
    Effect.orElseSucceed(() => undefined),
  );
  return yield* fileSystem
    .readFileString(
      path.join(
        copilotCacheDirectory(environment, path, platform, home),
        "copilot-user-cache.json",
      ),
    )
    .pipe(
      Effect.flatMap((contents) => decodeCopilotUserCache(stripLeadingComments(contents))),
      Effect.map((cache) => copilotUsageCacheToLimits(cache, login, now)),
      Effect.map((limits) => limits ?? probeFailed),
      Effect.orElseSucceed(() => probeFailed),
    );
});
