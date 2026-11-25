import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_BUILD_FILE,
  CLI_RELEASE_CHANNELS,
  cliReleaseAssetUrl,
  cliReleaseIndexPageUrl,
  cliReleaseChannelOf,
  newestCliReleaseVersion,
  parseReleaseBuild,
  releaseAssetUrl,
  updateFeedFileName,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import { BUILD_COMMIT } from "../buildCommit.ts";
import * as BootService from "../cloud/bootService.ts";
import {
  downloadVerifiedReleaseAsset,
  ensurePinnedRuntimeInstalled,
  findPosixLauncher,
  generatedWindowsShimTarget,
  launcherOwnsVersionsDir,
  isUnpublishedRelease,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
  type PinnedRuntimeProgress,
  PinnedRuntimePreflightBlockedError,
  pinnedRuntimeVersionsDir,
  prunePinnedRuntimes,
  recordPinnedRuntimeLauncher,
  readPosixLauncherTarget,
  resolveLauncherPath,
  windowsLauncherScript,
  windowsShimTarget,
  writePosixLauncher,
} from "../cloud/pinnedRuntime.ts";
import {
  compareExactServiceVersions,
  decodeServiceUnit,
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_UNIT_ENV,
} from "../cloud/serviceProtocol.ts";
import { runStagedServicePreflight } from "../cloud/servicePreflight.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { managedUpdateMirror, managedUpdateRefusal } from "../policy/managedUpdates.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  type DesktopAppPlan,
  installDesktopApp,
  isWindowsAppRunning,
  planDesktopAppUpdate,
  readDesktopAppBuild,
} from "./desktopApp.ts";
import { createUpdateProgress } from "./updateProgress.ts";
import * as CliService from "./service.ts";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
const RELEASE_INDEX_MAX_PAGES = 10;

export const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  channel: CliReleaseChannel,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const githubToken = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
    );
    const authenticatedRequest =
      githubToken === undefined
        ? request
        : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
    const body = yield* httpClient.execute(authenticatedRequest).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.mapError(() => new CliUpdateError({ reason: "Could not list t3 releases." })),
      Effect.timeoutOrElse({
        duration: RELEASE_INDEX_TIMEOUT,
        orElse: () => Effect.fail(new CliUpdateError({ reason: "Timed out listing t3 releases." })),
      }),
    );
    const releases = yield* decodeReleaseIndex(body).pipe(
      Effect.mapError(
        () => new CliUpdateError({ reason: "The t3 release index had an unexpected shape." }),
      ),
    );
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return yield* new CliUpdateError({ reason: `No published ${channel} release was found.` });
});

/** The version an update mirror's feed file for this platform offers on `channel`. */
export const resolveMirrorVersion = Effect.fn("cli.update.resolve_mirror")(function* (
  mirror: { readonly organization: string; readonly feedUrl: string },
  channel: CliReleaseChannel,
) {
  if (channel === "preview") {
    return yield* new CliUpdateError({
      reason: `${mirror.organization}'s update mirror has no preview builds.`,
    });
  }
  const httpClient = yield* HttpClient.HttpClient;
  const fileName = updateFeedFileName(
    channel === "nightly" ? "nightly" : "latest",
    yield* HostProcess.Platform,
    yield* HostProcess.Architecture,
  );
  const url = releaseAssetUrl(mirror.feedUrl, fileName);
  // Not the URL, whose query can hold the mirror's access token.
  const unreadable = new CliUpdateError({
    reason: `Could not read ${fileName} from ${mirror.organization}'s update mirror.`,
  });
  const body = yield* httpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.mapError(() => unreadable),
    Effect.timeoutOrElse({
      duration: RELEASE_INDEX_TIMEOUT,
      orElse: () => Effect.fail(unreadable),
    }),
  );
  const version = /^version:\s*["']?([^"'\s]+)/m.exec(body)?.[1];
  if (
    version === undefined ||
    !isExactServiceVersion(version) ||
    cliReleaseChannelOf(version) !== channel
  ) {
    return yield* unreadable;
  }
  return version;
});

/** The commit release `version` was built from, from its BUILD asset; undefined for older releases. */
const fetchReleaseBuild = Effect.fn("cli.update.fetch_release_build")(function* (
  version: string,
  releaseBaseUrl: string | undefined,
) {
  const httpClient = yield* HttpClient.HttpClient;
  return yield* httpClient
    .get(cliReleaseAssetUrl(version, CLI_RELEASE_BUILD_FILE, releaseBaseUrl))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.map(parseReleaseBuild),
      Effect.timeout(RELEASE_INDEX_TIMEOUT),
      Effect.orElseSucceed(() => undefined),
    );
});

const RELEASE_CHANGED = "the release changed during the update. Run `t3 update` again.";

const describeBuild = (build: {
  readonly version?: string | undefined;
  readonly build?: string | undefined;
}) => `${build.version ?? "an unknown version"} (build ${build.build ?? "unknown"})`;

/**
 * Only a launcher that already points into this home's `runtime/versions` tree is touched; a
 * plain copy of the executable, or a launcher for some other install, is left alone. It is
 * recorded before it moves, so prune never meets a repointed launcher it does not know about.
 */
export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly baseDir: string;
  readonly targetEntryPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return Option.none<string>();
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const ownsTarget = (candidate: string) => launcherOwnsVersionsDir(path, versionsDir, candidate);
  const remember = (launcher: string) =>
    recordPinnedRuntimeLauncher({ baseDir: input.baseDir, launcher }).pipe(
      Effect.mapError(
        () => new CliUpdateError({ reason: `Could not record the t3 launcher at ${launcher}.` }),
      ),
    );

  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs, versionsDir);
    if (shimPath === undefined) return Option.none<string>();
    const current = yield* fs.readFileString(shimPath).pipe(Effect.option);
    const quoted = Option.isSome(current) ? windowsShimTarget(current.value) : undefined;
    if (quoted === undefined || !ownsTarget(quoted)) return Option.none<string>();
    yield* remember(shimPath);
    yield* fs
      .writeFileString(shimPath, windowsLauncherScript(input.targetEntryPath))
      .pipe(
        Effect.mapError(
          () => new CliUpdateError({ reason: `Could not rewrite the t3 launcher at ${shimPath}.` }),
        ),
      );
    return Option.some(shimPath);
  }

  const launcher = yield* findPosixLauncher({ launchedAs: input.launchedAs, versionsDir });
  if (launcher === undefined) return Option.none<string>();
  yield* remember(launcher);
  yield* writePosixLauncher({
    launcher,
    executable: input.targetEntryPath,
    exclusive: false,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CliUpdateError({ reason: `Could not repoint the t3 launcher at ${launcher}.`, cause }),
    ),
  );
  return Option.some(launcher);
});

const readRecordedLaunchers = Effect.fn("cli.update.read_recorded_launchers")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const records = yield* fs
    .readFileString(path.join(baseDir, "runtime", "launchers"))
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Console.warn(`Could not read recorded t3 launchers: ${error}`).pipe(Effect.as("")),
      ),
    );
  return [...new Set(records.split(/\r?\n/).filter((entry) => path.isAbsolute(entry)))];
});

/** Where a recorded launcher points, when that is inside this home's `runtime/versions`. */
const ownedLauncherTarget = Effect.fn("cli.update.owned_launcher_target")(function* (
  launcher: string,
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  let target: string | undefined;
  if (platform === "win32") {
    const contents = yield* fs.readFileString(launcher).pipe(Effect.option);
    target = Option.isSome(contents) ? windowsShimTarget(contents.value) : undefined;
  } else {
    const link = yield* fs.readLink(launcher).pipe(Effect.option);
    target = Option.isSome(link)
      ? path.resolve(path.dirname(launcher), link.value)
      : yield* readPosixLauncherTarget(launcher);
  }
  return target !== undefined && launcherOwnsVersionsDir(path, versionsDir, target)
    ? target
    : undefined;
});

/** Whether a recorded launcher of this home points at a runtime version older than `version`. */
const hasLauncherOnOlderVersion = Effect.fn("cli.update.has_launcher_on_older_version")(
  function* (input: { readonly baseDir: string; readonly version: string }) {
    const path = yield* Path.Path;
    const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
    for (const launcher of yield* readRecordedLaunchers(input.baseDir)) {
      const target = yield* ownedLauncherTarget(launcher, versionsDir).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const launcherVersion =
        target === undefined ? undefined : path.relative(versionsDir, target).split(/[\\/]/)[0];
      if (
        launcherVersion !== undefined &&
        isExactServiceVersion(launcherVersion) &&
        compareExactServiceVersions(launcherVersion, input.version) < 0
      ) {
        return true;
      }
    }
    return false;
  },
);

export const repointRecordedLaunchers = Effect.fn("cli.update.repoint_recorded_launchers")(
  function* (input: { readonly baseDir: string; readonly targetEntryPath: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
    let repointed = false;
    for (const launcher of yield* readRecordedLaunchers(input.baseDir)) {
      const result = yield* Effect.gen(function* () {
        if ((yield* ownedLauncherTarget(launcher, versionsDir)) === undefined) return false;
        if (platform === "win32") {
          yield* fs.writeFileString(launcher, windowsLauncherScript(input.targetEntryPath));
        } else {
          yield* writePosixLauncher({
            launcher,
            executable: input.targetEntryPath,
            exclusive: false,
          });
        }
        return true;
      }).pipe(
        Effect.catch((error) =>
          Console.warn(`Could not repoint the t3 launcher at ${launcher}: ${error}`).pipe(
            Effect.as(false),
          ),
        ),
      );
      repointed ||= result;
    }
    return repointed;
  },
);

/** Windows executables see their own path, so locate the installer shim by matching its target. */
export const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
  executablePath: string,
  versionsDir?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const candidates = [
    ...(environment["T3CODE_INSTALL_BIN_DIR"] ? [environment["T3CODE_INSTALL_BIN_DIR"]] : []),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(";"),
  ]
    .filter((entry) => entry.trim().length > 0)
    .map((directory) => ({
      shimPath: path.join(directory, "t3.cmd"),
      parseTarget: windowsShimTarget,
    }));
  if (versionsDir !== undefined) {
    const recorded = yield* fs
      .readFileString(path.join(path.dirname(versionsDir), "launchers"))
      .pipe(Effect.orElseSucceed(() => ""));
    for (const shimPath of recorded.split(/\r?\n/)) {
      if (path.isAbsolute(shimPath) && path.basename(shimPath).toLowerCase() === "t3.cmd") {
        candidates.push({ shimPath, parseTarget: generatedWindowsShimTarget });
      }
    }
  }
  for (const { shimPath, parseTarget } of candidates) {
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const target = parseTarget(contents.value);
    if (
      target !== undefined &&
      path.resolve(target).toLowerCase() === path.resolve(executablePath).toLowerCase()
    ) {
      return shimPath;
    }
  }
  return undefined;
});

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.Literals("channel", CLI_RELEASE_CHANNELS).pipe(
    Flag.withDescription(
      "Release channel to follow. Defaults to the channel this t3 was published on.",
    ),
    Flag.optional,
  ),
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow moving to an older version than the one running."),
    Flag.withDefault(false),
  ),
  reinstall: Flag.Boolean("reinstall").pipe(
    Flag.withDescription(
      "Download and verify the target version again even when it is installed, and replace it.",
    ),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Restart the background service and update the desktop app without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.String("version").pipe(
  Argument.withDescription(
    "Exact version to install. Defaults to the newest release on the channel.",
  ),
  Argument.optional,
);

export const updateCommand = Command.make("update", {
  ...updateFlags,
  version: versionArgument,
}).pipe(
  Command.withDescription(
    "Download a newer t3 and switch this machine to it, including the background service when one is installed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUpdate({
        baseDir: config.baseDir,
        logsDir: config.logsDir,
        databasePath: config.dbPath,
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        channel: Option.getOrUndefined(flags.channel),
        requestedVersion: Option.getOrUndefined(flags.version),
        allowDowngrade: flags.allowDowngrade,
        assumeYes: flags.yes,
        reinstall: flags.reinstall,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CliService.layer(config),
            ProcessRunner.layer,
            FetchHttpClient.layer,
            ManagedPolicy.layer,
          ),
        ),
      );
    }),
  ),
);

const findForegroundServer = Effect.fn("cli.update.find_foreground_server")(function* (input: {
  readonly serverRuntimeStatePath: string;
  readonly serviceInstalled: boolean;
}) {
  const state = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
  if (Option.isNone(state) || state.value.serviceManaged || !isProcessAlive(state.value.pid)) {
    return undefined;
  }
  if (input.serviceInstalled && (yield* belongsToBootService(state.value.pid))) return undefined;
  return state.value;
});

const belongsToBootService = Effect.fn("cli.update.belongs_to_boot_service")(function* (
  pid: number,
) {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  if (platform === "linux") {
    const cgroup = yield* fs.readFileString(`/proc/${pid}/cgroup`).pipe(Effect.option);
    return Option.isSome(cgroup) && cgroup.value.includes("/t3code.service");
  }
  if (platform === "darwin") {
    const parent = yield* runner
      .run({
        command: "ps",
        args: ["-o", "ppid=", "-p", String(pid)],
        timeout: Duration.seconds(5),
      })
      .pipe(Effect.option);
    const ppid = Option.isSome(parent) && parent.value.code === 0 ? parent.value.stdout.trim() : "";
    if (!/^\d+$/.test(ppid)) return false;
    const command = yield* runner
      .run({ command: "ps", args: ["-o", "command=", "-p", ppid], timeout: Duration.seconds(5) })
      .pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout : "")),
        Effect.orElseSucceed(() => ""),
      );
    return /__service-launcher/.test(command);
  }
  return false;
});

export const runUpdate = Effect.fn("cli.update.run")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly databasePath: string;
  readonly serverRuntimeStatePath: string;
  readonly channel: CliReleaseChannel | undefined;
  readonly requestedVersion: string | undefined;
  readonly allowDowngrade: boolean;
  readonly assumeYes: boolean;
  readonly reinstall?: boolean;
}) {
  const reinstall = input.reinstall === true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const httpClient = yield* HttpClient.HttpClient;
  const service = yield* BootService.BootService;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const mirror = managedUpdateMirror(policy.document);

  const currentVersion = packageJson.version;
  const channel = input.channel ?? cliReleaseChannelOf(currentVersion);
  const refusal = managedUpdateRefusal(
    policy.document,
    input.requestedVersion === undefined ? channel : cliReleaseChannelOf(input.requestedVersion),
  );
  if (refusal !== undefined) {
    return yield* new CliUpdateError({ reason: refusal });
  }
  if (input.requestedVersion !== undefined && !isExactServiceVersion(input.requestedVersion)) {
    return yield* new CliUpdateError({
      reason: `'${input.requestedVersion}' is not an exact t3 version.`,
    });
  }
  const progress = createUpdateProgress();
  progress.status("Checking for updates...");
  const targetVersion = yield* (
    input.requestedVersion !== undefined
      ? Effect.succeed(input.requestedVersion)
      : mirror === undefined
        ? resolveNewestVersion(channel)
        : resolveMirrorVersion(mirror, channel)
  ).pipe(Effect.ensuring(Effect.sync(progress.finish)));
  const targetChannel = cliReleaseChannelOf(targetVersion);

  const currentChannel = cliReleaseChannelOf(currentVersion);
  if (targetChannel === "preview" && currentChannel !== "preview") {
    yield* Console.log(
      [
        `t3@${targetVersion} is a preview build.`,
        "  Preview builds are cut by maintainers from unreleased branches to exercise the release",
        "  pipeline. They can be broken, receive no fixes, and are never offered as updates; you",
        `  will have to switch back to ${currentChannel} yourself with \`t3 update --channel ${currentChannel} --allow-downgrade\`.`,
      ].join("\n"),
    );
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUpdateError({
        reason:
          "Refusing to install a preview build without confirmation. Run this from a terminal to confirm, or pass --channel preview from an interactive shell.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Install the preview build anyway?", initial: false }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  const releaseBaseUrl =
    mirror?.feedUrl ?? (environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined);
  const publishedBuild = yield* fetchReleaseBuild(targetVersion, releaseBaseUrl);

  const status = yield* service.status;
  // Service names are per user, so another home's unit belongs to a different install.
  const servesThisHome = status.installedBaseDir !== undefined && status.otherBaseDir === undefined;
  const serviceInstalled = status.supported && status.installed && servesThisHome;
  const foreground = yield* findForegroundServer({
    serverRuntimeStatePath: input.serverRuntimeStatePath,
    serviceInstalled,
  });
  const serviceVersion = serviceInstalled ? status.installedVersion : undefined;
  const executableCurrent = targetVersion === currentVersion;
  const restartPending = status.problems?.includes("restart-pending") === true;

  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, targetVersion, platform);
  const alreadyOnDisk = yield* fs.readFileString(runtimePaths.sentinelPath).pipe(
    Effect.map((sentinel) => sentinel.trim() === targetVersion),
    Effect.orElseSucceed(() => false),
  );
  const runningFromTarget = launcherOwnsVersionsDir(
    path,
    runtimePaths.versionDir,
    yield* HostProcess.ExecutablePath,
  );
  const runtimeBuild = alreadyOnDisk
    ? ((yield* fs.readFileString(path.join(runtimePaths.versionDir, CLI_RELEASE_BUILD_FILE)).pipe(
        Effect.map(parseReleaseBuild),
        Effect.orElseSucceed(() => undefined),
      )) ?? (runningFromTarget ? BUILD_COMMIT : undefined))
    : undefined;
  // Releases are republished under the same version with new commits; a runtime from before
  // BUILD files existed counts as an older build.
  let rebuilt =
    !reinstall && alreadyOnDisk && publishedBuild !== undefined && runtimeBuild !== publishedBuild;
  // Set when the runtime keeps its old build this run; the app then waits too, never ahead of it.
  let rebuildHeldBack = false;
  if ((reinstall || rebuilt) && platform === "win32" && runningFromTarget) {
    if (reinstall) {
      return yield* new CliUpdateError({
        reason: `This t3 is running from the t3@${targetVersion} runtime being replaced. Run the reinstall from the desktop app or another t3 version.`,
      });
    }
    yield* Console.log(
      `A newer build of ${targetVersion} is published (build ${publishedBuild}), but this t3 runs from the runtime it would replace. Use T3 Code → Help → Reinstall This Version.`,
    );
    rebuilt = false;
    rebuildHeldBack = true;
  }
  let replace = reinstall || rebuilt;

  const isServiceCurrent = () =>
    !serviceInstalled ||
    (!replace &&
      serviceVersion === targetVersion &&
      (executableCurrent ? status.current : (status.problems ?? []).length === 0));
  let serviceCurrent = isServiceCurrent();
  const newestInstalled =
    serviceVersion !== undefined && compareExactServiceVersions(serviceVersion, currentVersion) > 0
      ? serviceVersion
      : currentVersion;
  const serviceProgram = serviceInstalled
    ? yield* fs.readFile(status.unitPath).pipe(
        Effect.map((unit) => BootService.bootServiceProgramOf(decodeServiceUnit(unit))),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  const appPlan = yield* planDesktopAppUpdate({
    baseDir: input.baseDir,
    targetVersion,
    publishedBuild,
    allowDowngrade: input.allowDowngrade,
    releaseBaseUrl,
    serviceProgram: serviceProgram ?? undefined,
  });
  const appHeldBackNote =
    "The desktop app was left as is so it stays on the runtime's build. T3 Code → Help → Reinstall This Version moves both.";
  let appStale = appPlan?.decision.action === "install" && !rebuildHeldBack;
  let appNote =
    appPlan?.decision.action === "skip"
      ? appPlan.decision.note
      : appPlan?.decision.action === "install" && rebuildHeldBack
        ? appHeldBackNote
        : undefined;

  // The desktop app's bundled CLI is always on the app's version, so a stale `t3` launcher
  // is the only sign that an installed copy still needs to move.
  const launcherOnOlderVersion =
    executableCurrent &&
    (yield* hasLauncherOnOlderVersion({ baseDir: input.baseDir, version: targetVersion }));
  let launcherStale = launcherOnOlderVersion && serviceCurrent && !replace;
  if (executableCurrent && serviceCurrent && !replace && !launcherStale && !appStale) {
    const build = runtimeBuild === undefined ? "" : `, build ${runtimeBuild}`;
    yield* Console.log(
      serviceVersion !== undefined
        ? `t3 and its background service are already on ${targetVersion} (${targetChannel}${build}).`
        : `t3 is already on ${targetVersion} (${targetChannel}${build}).`,
    );
    if (appNote !== undefined) yield* Console.log(`  ${appNote}`);
    return;
  }
  if (!input.allowDowngrade && compareExactServiceVersions(targetVersion, newestInstalled) < 0) {
    return yield* new CliUpdateError({
      reason: `t3@${targetVersion} is older than the installed ${newestInstalled}. Pass --allow-downgrade to install it anyway.`,
    });
  }

  progress.heading(
    reinstall
      ? `Reinstalling T3 Code ${targetVersion} (${targetChannel}).`
      : rebuilt
        ? `A newer build of ${targetVersion} is published.`
        : executableCurrent && restartPending
          ? `The background service is still running the version before ${targetVersion} (${targetChannel}).`
          : executableCurrent && serviceInstalled && !serviceCurrent
            ? `Updating the background service ${serviceVersion ?? "(unknown version)"} -> ${targetVersion} (${targetChannel}).`
            : executableCurrent && !launcherStale
              ? `Updating the desktop app to ${targetVersion} (${targetChannel}).`
              : alreadyOnDisk
                ? "Switching T3 Code"
                : "Updating T3 Code",
    rebuilt
      ? `build ${runtimeBuild ?? "unknown"} → ${publishedBuild}`
      : executableCurrent || reinstall
        ? ""
        : `${currentVersion} → ${targetVersion}${targetChannel === "stable" ? "" : ` (${targetChannel})`}`,
  );
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  let restartService = false;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      "  A background service is installed for this T3 home. Restarting it interrupts anything running in it: agent turns, terminals, remote clients.",
    );
    if (input.assumeYes) {
      restartService = true;
    } else if (interactive) {
      restartService = yield* Prompt.run(
        Prompt.Confirm({
          message: "Restart the background service once the download is verified?",
          initial: true,
        }),
      ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    } else {
      yield* Console.log(
        "  Not a terminal, so the service keeps running its current version. Rerun with --yes to restart it now, or run `t3 service restart` later.",
      );
    }
  }
  // Replacing a runtime on Windows stops the service, which the user just declined.
  if (rebuilt && platform === "win32" && serviceInstalled && !restartService) {
    yield* Console.log(
      `  A newer build of ${targetVersion} is published (build ${publishedBuild}), but replacing the runtime stops the background service, so both were left as is. Rerun with --yes when the service can restart.`,
    );
    rebuilt = false;
    rebuildHeldBack = true;
    replace = reinstall;
    serviceCurrent = isServiceCurrent();
    launcherStale = launcherOnOlderVersion && serviceCurrent && !replace;
    if (appStale) appNote = appHeldBackNote;
    appStale = false;
  }
  let updateApp = false;
  if (appStale && appPlan !== undefined) {
    yield* Console.log(
      `  The desktop app is on ${describeBuild(appPlan.current)}; this release is ${targetVersion} (build ${publishedBuild}).${platform === "win32" ? " Its installer closes T3 Code while it runs." : ""}`,
    );
    if (input.assumeYes) {
      updateApp = true;
    } else if (interactive) {
      updateApp = yield* Prompt.run(
        Prompt.Confirm({
          message: "Update the desktop app once its installer is verified?",
          initial: true,
        }),
      ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
      if (!updateApp) appNote = "The desktop app was left as is.";
    } else {
      yield* Console.log(
        "  Not a terminal, so the desktop app was left as is. Rerun with --yes to update it.",
      );
    }
  }
  // Only the app had anything to do here, so the runtime and launchers stay as they are.
  const appOnly = executableCurrent && serviceCurrent && !replace && !launcherStale;
  if (appOnly && !updateApp) {
    yield* Console.log(appNote === undefined ? "Left as is." : `  ${appNote}`);
    return;
  }

  const runtime = yield* ensurePinnedRuntimeInstalled({
    onProgress: progress.report,
    baseDir: input.baseDir,
    version: targetVersion,
    fs,
    path,
    runner,
    httpClient,
    platform,
    arch,
    releaseBaseUrl,
    requirePublishedRelease: mirror !== undefined,
    replaceExisting: replace,
    aroundReplace:
      platform === "win32"
        ? (swap) =>
            service.withStopped(swap).pipe(
              Effect.mapError((error) =>
                error._tag === "PinnedRuntimeInstallError"
                  ? error
                  : new PinnedRuntimeInstallError({
                      step: "stopping the background service to replace the runtime",
                      cause: error,
                    }),
              ),
            )
        : undefined,
    validate: (runtime) =>
      runStagedServicePreflight({
        runner,
        runtime,
        targetVersion,
        databasePath: input.databasePath,
        // The target then runs under its own launcher, so only its database check matters. Older
        // builds may predate protocol 4; every stable release since 0.0.43 accepts 3.
        launcherProtocol:
          compareExactServiceVersions(targetVersion, currentVersion) < 0
            ? 3
            : SERVICE_LAUNCHER_PROTOCOL,
      }).pipe(
        Effect.catchTags({
          PinnedRuntimeInstallError: (error) =>
            Effect.fail(
              error.exitCode === undefined
                ? error
                : new PinnedRuntimePreflightBlockedError({
                    version: targetVersion,
                    reason: `t3@${targetVersion} could not confirm it supports this database (its check exited with code ${error.exitCode}), so t3 did not switch to it.`,
                  }),
            ),
        }),
      ),
  }).pipe(
    Effect.ensuring(Effect.sync(progress.finish)),
    Effect.catchTags({
      PinnedRuntimePreflightBlockedError: (error) =>
        Effect.fail(new CliUpdateError({ reason: error.reason })),
    }),
    Effect.catchIf(isUnpublishedRelease, () =>
      Effect.fail(
        new CliUpdateError({
          reason:
            mirror === undefined
              ? `No release archive was published for t3@${targetVersion}.`
              : `${mirror.organization}'s update mirror has no t3@${targetVersion} for this machine.`,
        }),
      ),
    ),
  );

  // The release may be republished between the BUILD lookup and the download.
  const installedBuild = yield* fs
    .readFileString(path.join(runtimePaths.versionDir, CLI_RELEASE_BUILD_FILE))
    .pipe(
      Effect.map(parseReleaseBuild),
      Effect.orElseSucceed(() => undefined),
    );
  const releaseChanged =
    publishedBuild !== undefined &&
    installedBuild !== undefined &&
    installedBuild !== publishedBuild;

  // An app-only run would otherwise move launchers on a newer runtime back to this one.
  const launchedAs =
    !appOnly && (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const repointed = yield* repointLauncher({
    launchedAs,
    baseDir: input.baseDir,
    targetEntryPath: runtime.entryPath,
  });

  const recordedRepointed =
    !appOnly && Option.isNone(repointed)
      ? yield* repointRecordedLaunchers({
          baseDir: input.baseDir,
          targetEntryPath: runtime.entryPath,
        })
      : false;

  // The app's installer closes it; reopen it only when it was open and the service switches now.
  const appStep =
    updateApp && !releaseChanged && appPlan?.install !== undefined && appPlan.fileName !== undefined
      ? runDesktopAppStep({
          plan: { ...appPlan, install: appPlan.install },
          fileName: appPlan.fileName,
          baseDir: input.baseDir,
          targetVersion,
          publishedBuild,
          releaseBaseUrl,
          reopen:
            appPlan.install.kind === "nsis" &&
            appPlan.install.executable !== undefined &&
            !(restartService && Boolean(environment[SERVICE_UNIT_ENV])) &&
            (yield* isWindowsAppRunning(appPlan.install.executable)),
          onProgress: progress.report,
        }).pipe(Effect.ensuring(Effect.sync(progress.finish)))
      : undefined;
  // Run from the app's own executable on Windows, its installer would close this t3, so it runs last.
  const appOutcome = appPlan?.handoff === true ? undefined : appStep && (yield* appStep);

  // Use today's service manager for the target version. Inside the service it hands off to
  // the target CLI, so stopping this process cannot interrupt the switch.
  let servicePlan: BootService.BootServicePlan | undefined;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      restartService
        ? "Restarting the background service..."
        : "Updating the background service...",
    );
    servicePlan = yield* BootService.BootService.pipe(
      Effect.flatMap((target) =>
        target.install({ allowDowngrade: input.allowDowngrade, start: restartService }),
      ),
      Effect.provide(
        BootService.layer({
          baseDir: input.baseDir,
          logsDir: input.logsDir,
          cliVersion: targetVersion,
        }),
      ),
      Effect.mapError(
        (error) =>
          new CliUpdateError({
            reason: `t3@${targetVersion} is installed but the background service could not be ${restartService ? "updated" : "pointed at it"}: ${error.message}`,
          }),
      ),
    );
  }

  // A handed-off service install rewrites the unit later, while the old launcher may be stopped.
  if (servicePlan?.handedOff !== true) {
    // A stopped service's unit still names the launcher runtime it will start.
    const unit = yield* fs
      .readFile(status.unitPath)
      .pipe(Effect.map(decodeServiceUnit), Effect.option);
    yield* prunePinnedRuntimes({
      baseDir: input.baseDir,
      keep: [currentVersion, targetVersion],
      references: Option.toArray(Option.flatMapNullishOr(unit, BootService.bootServiceProgramOf)),
    });
  }

  progress.success(`Installed T3 Code ${targetVersion}`);
  if (appOnly) {
    // Nothing new to run: the runtime and launchers were already current.
  } else if (Option.isSome(repointed) || recordedRepointed) {
    yield* Console.log("  Run t3 to get started.\n");
  } else {
    yield* Console.log(`  Run ${runtime.entryPath}\n`);
  }
  if (installedBuild !== undefined || publishedBuild !== undefined) {
    yield* Console.log(
      `  t3 runtime: ${describeBuild({ version: targetVersion, build: installedBuild })}`,
    );
  }
  let appFailure: string | undefined;
  if (appOutcome?._tag === "failed") {
    appFailure = appOutcome.reason;
  } else if (appOutcome?._tag === "pending") {
    yield* Console.log(
      `  The desktop app installer needs administrator rights and there is no terminal to ask for a password. To finish, run: ${appOutcome.command}`,
    );
  } else if (appOutcome?._tag === "installed") {
    if (appOutcome.after.version === targetVersion && appOutcome.after.build === publishedBuild) {
      yield* Console.log(
        `  Desktop app: ${describeBuild(appOutcome.after)}${platform === "win32" ? "" : ". Quit and reopen T3 Code to start it."}`,
      );
    } else if (appOutcome.after.version === targetVersion && appOutcome.after.build !== undefined) {
      appFailure = `it reports build ${appOutcome.after.build}, not ${publishedBuild}: ${RELEASE_CHANGED}`;
    } else {
      appFailure = `it still reports ${describeBuild(appOutcome.after)} after installing ${targetVersion} (build ${publishedBuild}).`;
    }
  } else if (updateApp && releaseChanged) {
    yield* Console.log("  The desktop app was left as is, so it does not mix builds.");
  } else if (appPlan?.decision.action === "current") {
    yield* Console.log(`  Desktop app: ${describeBuild(appPlan.current)}`);
  } else if (appNote !== undefined) {
    yield* Console.log(`  ${appNote}`);
  }
  if (servicePlan?.handedOff === true) {
    yield* Console.log(
      `  Background service switching to ${targetVersion} outside this session, since this session runs inside it and disconnects when it restarts. Result: ${servicePlan.logPath}`,
    );
  } else if (servicePlan !== undefined && restartService) {
    yield* Console.log(`  Background service restarted on ${targetVersion}`);
  } else if (serviceInstalled && serviceCurrent) {
    yield* Console.log(`  Background service already on ${targetVersion}`);
  } else if (serviceInstalled) {
    // A pending restart means the service already points at serviceVersion but runs an older one.
    const running =
      serviceVersion === undefined
        ? "an unknown version"
        : restartPending
          ? `the version before ${serviceVersion}`
          : serviceVersion;
    yield* Console.log(
      `  Background service still running ${running}. Run \`t3 service restart\` when you are ready to switch it to ${targetVersion}.`,
    );
  } else if (status.installed && !servesThisHome) {
    yield* Console.log(
      `  The background service serves ${status.installedBaseDir ?? "another T3 home"} and was left unchanged.`,
    );
  }
  if (foreground !== undefined) {
    yield* Console.log(
      `  A server started by hand is still running at ${foreground.origin} (pid ${foreground.pid}). Stop it and start it again to pick up ${targetVersion}.`,
    );
  }
  if (releaseChanged) {
    return yield* new CliUpdateError({
      reason: `t3@${targetVersion} installed build ${installedBuild}, not the ${publishedBuild} it looked up: ${RELEASE_CHANGED}`,
    });
  }
  if (appPlan?.handoff === true && appStep !== undefined) {
    const handoff = yield* appStep;
    if (handoff._tag === "failed") {
      appFailure = handoff.reason;
    } else {
      yield* Console.log(
        handoff.reopen
          ? "  The desktop app installer is running in the background; T3 Code reopens when it's done."
          : "  The desktop app installer finishes in the background.",
      );
    }
  }
  if (appFailure !== undefined) {
    return yield* new CliUpdateError({
      reason: `t3@${targetVersion} is installed, but the desktop app was not updated: ${appFailure} Run \`t3 update\` again to retry the app.`,
    });
  }
});

const runDesktopAppStep = Effect.fn("cli.update.desktop_app")(
  function* (input: {
    readonly plan: DesktopAppPlan & { readonly install: NonNullable<DesktopAppPlan["install"]> };
    readonly fileName: string;
    readonly baseDir: string;
    readonly targetVersion: string;
    readonly publishedBuild: string | undefined;
    readonly releaseBaseUrl: string | undefined;
    readonly reopen: boolean;
    readonly onProgress: (progress: PinnedRuntimeProgress) => void;
  }) {
    const { plan } = input;
    yield* Console.log("Updating the desktop app...");
    const checksum = plan.checksum;
    if (checksum === undefined) {
      return {
        _tag: "failed",
        reason: "the release lists no checksum for its installer.",
      } as const;
    }
    const installer = yield* downloadVerifiedReleaseAsset({
      httpClient: yield* HttpClient.HttpClient,
      version: input.targetVersion,
      fileName: input.fileName,
      expected: checksum,
      releaseBaseUrl: input.releaseBaseUrl,
      label: "desktop app installer",
      onProgress: input.onProgress,
    });
    const pending = yield* installDesktopApp({
      install: plan.install,
      installer,
      fileName: input.fileName,
      baseDir: input.baseDir,
      reopen: input.reopen,
      handoff: plan.handoff,
    });
    if (pending !== undefined) return { _tag: "pending", command: pending } as const;
    // The installer is still running and closes this t3 when it replaces the app.
    if (plan.handoff) return { _tag: "handedOff", reopen: input.reopen } as const;
    const after = yield* readDesktopAppBuild(plan.install, {
      checksum,
      targetVersion: input.targetVersion,
      publishedBuild: input.publishedBuild,
    });
    return { _tag: "installed", after } as const;
  },
  Effect.catchTags({
    PinnedRuntimeInstallError: (error) =>
      Effect.succeed({
        _tag: "failed",
        reason: error.step.endsWith("checksum")
          ? `its installer did not match the release checksum; ${RELEASE_CHANGED}`
          : `could not finish ${error.step}.`,
      } as const),
    DesktopAppUpdateError: (error) =>
      Effect.succeed({ _tag: "failed", reason: error.reason } as const),
  }),
);
