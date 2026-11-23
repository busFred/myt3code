import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveMiseProviderMaintenance,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";

const DRIVER = ProviderDriverKind.make("muse");
const MUSE_CHANNELS = new Set(["muse-stable", "muse-canary"]);
const ChannelManifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/)),
});

export function parseMuseVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+-R\d+(?:\.\d+)?\b/)?.[0] ?? parseGenericCliVersion(output);
}

function comparableMuseVersion(version: string): string {
  return version.replace(/-R(\d+)(?:\.(\d+))?$/, "-release.$1.$2").replace(/\.$/, ".0");
}

const MUSE_REVISION = /-R\d+(?:\.\d+)?$/;

export const compareMuseVersions = (current: string, latest: string) =>
  MUSE_REVISION.test(current) === MUSE_REVISION.test(latest)
    ? compareSemverVersions(comparableMuseVersion(current), comparableMuseVersion(latest))
    : compareSemverVersions(current.replace(MUSE_REVISION, ""), latest.replace(MUSE_REVISION, ""));

const LAUNCHER_MAX_BYTES = 128 * 1_024;

const readLauncher = Effect.fn("MuseMaintenance.readLauncher")(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(file);
    return Number(stat.size) > LAUNCHER_MAX_BYTES ? "" : yield* fs.readFileString(file);
  },
  Effect.orElseSucceed(() => ""),
);

/**
 * Mise upgrades a binary it installed. Otherwise only Meta's launcher owns an update
 * channel: the bash script on macOS and Linux, and on Windows the `muse.cmd` shim that
 * runs `.muse-launcher.ps1` beside it. A standalone binary cannot update itself.
 */
export const museMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("MuseMaintenance.resolve")(function* (context) {
    const manual = {
      ...makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
      compareVersions: compareMuseVersions,
    };
    if (!context) return manual;
    const mise = yield* resolveMiseProviderMaintenance(
      { provider: DRIVER, packageName: null },
      { tool: "muse" },
      context,
    );
    if (mise) return { ...mise, compareVersions: compareMuseVersions };
    const windows = context.platform === "win32";
    const isLauncher = windows
      ? /\.cmd$/i.test(context.realCommandPath) &&
        (yield* readLauncher(context.realCommandPath)).includes(".muse-launcher.ps1") &&
        isMuseLauncherSource(
          yield* readLauncher(context.realCommandPath.replace(/[^\\/]+$/, ".muse-launcher.ps1")),
          "muse-code/launcher-ps-",
        )
      : isMuseLauncherSource(yield* readLauncher(context.realCommandPath), "muse-code/launcher-");
    if (!isLauncher) return manual;
    // The launcher has no `update` subcommand. Its documented launch environment
    // forces a synchronous refresh of this executable's own installation.
    const updateEnv = {
      ...(context.env.MUSE_CHANNEL ? { MUSE_CHANNEL: context.env.MUSE_CHANNEL } : {}),
      MUSE_LOGIN: "0",
      MUSE_NO_AUTO_UPDATE: "0",
      MUSE_SYNC_UPDATE: "1",
      MUSE_UPDATE_INTERVAL_SECONDS: "0",
    };
    const variables = Object.entries(updateEnv);
    return {
      ...makeProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: ["--version"],
        // Windows terminals default to PowerShell, where `$env:` would outlive this run; a child
        // cmd keeps the variables to it.
        updateCommand: windows
          ? `cmd /d /c ${powerShellQuote(
              [
                ...variables.map(([key, value]) =>
                  /^[\w.:-]*$/.test(value) ? `set ${key}=${value}&&` : `set "${key}=${value}"&&`,
                ),
                `"${context.resolvedCommandPath}" --version`,
              ].join(" "),
            )}`
          : [
              ...variables.map(([key, value]) => `${key}=${shellQuote(value)}`),
              shellQuote(context.resolvedCommandPath),
              "--version",
            ].join(" "),
        updateLockKey: `muse:${context.realCommandPath}`,
        platform: context.platform,
        env: { ...context.env, ...updateEnv },
      }),
      compareVersions: compareMuseVersions,
    };
  }),
};

function isMuseLauncherSource(source: string, userAgent: string) {
  return source.includes(userAgent) && source.includes("MUSE_SYNC_UPDATE");
}

function shellQuote(word: string) {
  return /^[\w./:@=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(word: string) {
  return `'${word.replace(/['\u2018\u2019]/g, "$&$&")}'`;
}

export const latestMuseVersion = Effect.fn("latestMuseVersion")(function* (
  environment: NodeJS.ProcessEnv,
  options?: { readonly fresh?: boolean },
) {
  const channel = environment.MUSE_CHANNEL || "muse-stable";
  if (!MUSE_CHANNELS.has(channel)) return null;
  const channelUrl = `https://api.meta.ai/muse-code/channels/${channel}`;
  const client = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  return yield* latestVersions.cached(
    `muse:${channelUrl}`,
    client.execute(HttpClientRequest.get(channelUrl)).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ChannelManifest)),
              Effect.map((manifest) => parseMuseVersion(manifest.version)),
            )
          : Effect.succeed(null),
      ),
      Effect.timeout(4_000),
      Effect.orElseSucceed(() => null),
    ),
    options,
  );
});

export const enrichMuseSnapshot = Effect.fn("enrichMuseSnapshot")(function* (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { snapshot } = input;
  const options = { enableProviderUpdateChecks: input.enableProviderUpdateChecks };
  // Mise names the version it would install, so its answer alone counts.
  if (input.maintenanceCapabilities.lookupLatestVersion) {
    return yield* enrichProviderSnapshotWithVersionAdvisory(
      snapshot,
      input.maintenanceCapabilities,
      options,
    );
  }
  const latestVersion =
    input.enableProviderUpdateChecks && snapshot.enabled && snapshot.installed && snapshot.version
      ? yield* latestMuseVersion(input.environment)
      : null;
  return yield* enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    { ...input.maintenanceCapabilities, latestVersion },
    options,
  );
});
