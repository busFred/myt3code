import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  cliReleaseChannelOf,
  desktopAppAssetFileName,
  parseReleaseBuild,
} from "@t3tools/shared/cliRelease";
import { DESKTOP_APP_INVOKED_ENV, readCliShimTarget } from "@t3tools/shared/desktopCliShim";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { fetchReleaseChecksums, launcherOwnsVersionsDir } from "../cloud/pinnedRuntime.ts";
import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";
import * as ProcessRunner from "../processRunner.ts";

export class DesktopAppUpdateError extends Schema.TaggedError<DesktopAppUpdateError>()(
  "DesktopAppUpdateError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

export type DesktopAppInstall =
  | { readonly kind: "nsis"; readonly installDir: string; readonly executable?: string }
  | { readonly kind: "deb"; readonly installDir: string }
  | { readonly kind: "appimage"; readonly appImage: string }
  /** macOS, or a layout `t3 update` does not install over. */
  | { readonly kind: "other"; readonly asar: string };

export interface DesktopAppBuild {
  readonly version: string | undefined;
  readonly build: string | undefined;
}

const AsarHeader = Schema.fromJsonString(
  Schema.Struct({ files: Schema.Record(Schema.String, Schema.Unknown) }),
);
const AsarEntry = Schema.Struct({
  size: Schema.Int,
  offset: Schema.String,
  unpacked: Schema.optional(Schema.Boolean),
});
const AppPackageJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String, t3codeCommitHash: Schema.optional(Schema.String) }),
);
const decodeAsarHeader = Schema.decodeUnknownOption(AsarHeader);
const decodeAsarEntry = Schema.decodeUnknownOption(AsarEntry);
const decodeAppPackageJson = Schema.decodeUnknownOption(AppPackageJson);
const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024;

/**
 * A file at the root of an asar archive, per @electron/asar's disk.js: a pickle holding the
 * header pickle's size, the header pickle (payload size, string length, JSON), then the files.
 */
export const readAsarRootFile = Effect.fn("cli.desktop_app.read_asar_root_file")(function* (
  read: (
    position: number,
    length: number,
  ) => Effect.Effect<Uint8Array, PlatformError.PlatformError>,
  name: string,
) {
  const prefix = yield* read(0, 16);
  if (prefix.byteLength < 16) return undefined;
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const headerSize = view.getUint32(4, true);
  const jsonLength = view.getUint32(12, true);
  if (headerSize > MAX_ASAR_HEADER_BYTES || jsonLength > headerSize) return undefined;
  const header = decodeAsarHeader(new TextDecoder().decode(yield* read(16, jsonLength)));
  const entry = Option.flatMap(header, ({ files }) => decodeAsarEntry(files[name]));
  if (Option.isNone(entry) || entry.value.unpacked === true) return undefined;
  const offset = Number(entry.value.offset);
  if (!Number.isSafeInteger(offset)) return undefined;
  const bytes = yield* read(8 + headerSize + offset, entry.value.size);
  return bytes.byteLength === entry.value.size ? new TextDecoder().decode(bytes) : undefined;
});

const UNKNOWN_BUILD: DesktopAppBuild = { version: undefined, build: undefined };

const readAsarBuild = Effect.fn("cli.desktop_app.read_asar_build")(
  function* (asar: string) {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.open(asar, { flag: "r" });
    const text = yield* readAsarRootFile(
      (position, length) =>
        file
          .readAlloc(length, { position: BigInt(position) })
          .pipe(Effect.map(Option.getOrElse(() => new Uint8Array()))),
      "package.json",
    );
    const manifest = decodeAppPackageJson(text);
    if (Option.isNone(manifest)) return UNKNOWN_BUILD;
    return {
      version: manifest.value.version,
      build: parseReleaseBuild(manifest.value.t3codeCommitHash ?? ""),
    } satisfies DesktopAppBuild;
  },
  Effect.scoped,
  Effect.orElseSucceed(() => UNKNOWN_BUILD),
);

/** An AppImage is one file, so the release's checksum names its build. */
const readAppImageBuild = Effect.fn("cli.desktop_app.read_appimage_build")(function* (input: {
  readonly appImage: string;
  readonly checksum: string | undefined;
  readonly targetVersion: string;
  readonly publishedBuild: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const bytes = yield* fs.readFile(input.appImage).pipe(Effect.option);
  if (Option.isSome(bytes) && input.checksum !== undefined) {
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes.value));
    if (Hex.encode(new Uint8Array(digest)) === input.checksum) {
      return {
        version: input.targetVersion,
        build: input.publishedBuild,
      } satisfies DesktopAppBuild;
    }
  }
  const version = yield* runner
    .run({ command: input.appImage, args: ["--version"], timeout: Duration.seconds(30) })
    .pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
      Effect.orElseSucceed(() => ""),
    );
  return {
    version: isExactServiceVersion(version) ? version : undefined,
    build: undefined,
  } satisfies DesktopAppBuild;
});

/** Which release the installed app is, read the same way before and after an install. */
export const readDesktopAppBuild = Effect.fn("cli.desktop_app.read_build")(function* (
  app: DesktopAppInstall,
  input: {
    readonly checksum: string | undefined;
    readonly targetVersion: string;
    readonly publishedBuild: string | undefined;
  },
) {
  const path = yield* Path.Path;
  if (app.kind === "appimage")
    return yield* readAppImageBuild({ appImage: app.appImage, ...input });
  return yield* readAsarBuild(
    app.kind === "other" ? app.asar : path.join(app.installDir, "resources", "app.asar"),
  );
});

/** Where the `t3code` package put the app, when a .deb installed it. */
const debInstallDir = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const result = yield* runner
    .run({ command: "dpkg-query", args: ["-L", "t3code"], timeout: Duration.seconds(10) })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) return undefined;
  const asar = result.value.stdout
    .split("\n")
    .find((line) => line.startsWith("/opt/") && line.endsWith("/resources/app.asar"));
  return asar === undefined ? undefined : path.dirname(path.dirname(asar));
});

const found = (install: DesktopAppInstall) => install;

/**
 * The app rewrites `<T3 home>/bin/t3` with its own path on every launch; an app that was never
 * opened is found where its installer puts it.
 */
const locateDesktopApp = Effect.fn("cli.desktop_app.locate")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const shim = yield* fs
    .readFileString(path.join(baseDir, "bin", platform === "win32" ? "t3.cmd" : "t3"))
    .pipe(Effect.option);
  const target = Option.isSome(shim) ? readCliShimTarget(shim.value) : undefined;
  if (target?.kind === "windows" && (yield* exists(target.executable))) {
    const installDir = path.dirname(target.executable);
    return found({ kind: "nsis", installDir, executable: target.executable });
  }
  if (target?.kind === "appimage" && (yield* exists(target.appImage))) {
    return found({ kind: "appimage", appImage: target.appImage });
  }
  if (target?.kind === "direct" && (yield* exists(target.executable))) {
    const dir = path.dirname(target.executable);
    if (platform === "darwin") {
      return found({ kind: "other", asar: path.join(path.dirname(dir), "Resources", "app.asar") });
    }
    return platform === "linux" && (yield* debInstallDir) === dir
      ? found({ kind: "deb", installDir: dir })
      : found({ kind: "other", asar: path.join(dir, "resources", "app.asar") });
  }
  if (platform === "win32") {
    const localAppData = (yield* HostProcess.Environment).LOCALAPPDATA?.trim();
    // electron-builder's per-user NSIS folder, named after the staged package name.
    const installDir = localAppData ? path.join(localAppData, "Programs", "t3code") : undefined;
    if (
      installDir !== undefined &&
      (yield* exists(path.join(installDir, "resources", "app.asar")))
    ) {
      // The executable is named after the product name each channel builds with.
      for (const productName of ["T3 Code (Beta)", "T3 Code (Nightly)", "T3 Code (Alpha)"]) {
        const executable = path.join(installDir, `${productName}.exe`);
        if (yield* exists(executable)) return found({ kind: "nsis", installDir, executable });
      }
      return found({ kind: "nsis", installDir });
    }
  }
  if (platform === "linux") {
    const installDir = yield* debInstallDir;
    if (installDir !== undefined) return found({ kind: "deb", installDir });
  }
  return undefined;
});

export type DesktopAppDecision =
  | { readonly action: "install" }
  | { readonly action: "current" }
  | { readonly action: "skip"; readonly note: string };

/** Whether `t3 update` should install the target release over the desktop app it found. */
export function decideDesktopAppUpdate(input: {
  readonly kind: DesktopAppInstall["kind"];
  readonly current: DesktopAppBuild;
  readonly targetVersion: string;
  readonly publishedBuild: string | undefined;
  readonly allowDowngrade: boolean;
  readonly installerChecksum: string | undefined;
  readonly serviceInsideApp: boolean;
}): DesktopAppDecision {
  const { current, targetVersion, publishedBuild } = input;
  if (current.version === undefined) {
    return { action: "skip", note: "Could not tell which version the desktop app is on." };
  }
  if (cliReleaseChannelOf(current.version) !== cliReleaseChannelOf(targetVersion)) {
    return {
      action: "skip",
      note: `The desktop app follows ${cliReleaseChannelOf(current.version)}, not ${cliReleaseChannelOf(targetVersion)}, so it was left on ${current.version}.`,
    };
  }
  const order = compareExactServiceVersions(current.version, targetVersion);
  if (order > 0 && !input.allowDowngrade) {
    return {
      action: "skip",
      note: `The desktop app is on ${current.version}, newer than ${targetVersion}, so it was left as is.`,
    };
  }
  if (order === 0 && (publishedBuild === undefined || current.build === publishedBuild)) {
    return { action: "current" };
  }
  if (publishedBuild === undefined) {
    return {
      action: "skip",
      note: `The ${targetVersion} release does not name its build, so the desktop app was left on ${current.version}.`,
    };
  }
  const wanted = `T3 Code ${targetVersion} (build ${publishedBuild})`;
  if (input.kind === "other") {
    return {
      action: "skip",
      note: `Install ${wanted} to bring the desktop app to the same build.`,
    };
  }
  if (input.serviceInsideApp) {
    return {
      action: "skip",
      note: `The background service runs from the desktop app's folder, so the app was left as is. Install ${wanted} yourself.`,
    };
  }
  if (input.installerChecksum === undefined) {
    return {
      action: "skip",
      note: `The release lists no checksum for this machine's app installer, so the desktop app was left as is. Install ${wanted} yourself.`,
    };
  }
  return { action: "install" };
}

export interface DesktopAppPlan {
  readonly install: Exclude<DesktopAppInstall, { readonly kind: "other" }> | undefined;
  readonly current: DesktopAppBuild;
  readonly fileName: string | undefined;
  readonly checksum: string | undefined;
  readonly decision: DesktopAppDecision;
  /** This t3 runs from the app's own executable, which its Windows installer closes. */
  readonly handoff: boolean;
}

/**
 * Whether the desktop app ran this t3 itself, for its own update or Reinstall. The app's `t3`
 * launcher runs the same Electron executable, but always sets T3CODE_CLI_PATH.
 */
export const invokedByDesktopApp = (input: {
  readonly electron: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) =>
  input.environment[DESKTOP_APP_INVOKED_ENV] === "1" ||
  (input.electron && !input.environment.T3CODE_CLI_PATH?.trim());

/** Undefined when there is no desktop app here, or the app itself ran this t3. */
export const planDesktopAppUpdate = Effect.fn("cli.desktop_app.plan")(function* (input: {
  readonly baseDir: string;
  readonly targetVersion: string;
  readonly publishedBuild: string | undefined;
  readonly allowDowngrade: boolean;
  readonly releaseBaseUrl: string | undefined;
  readonly serviceProgram: string | undefined;
}) {
  const environment = yield* HostProcess.Environment;
  if (invokedByDesktopApp({ electron: process.versions.electron !== undefined, environment })) {
    yield* Effect.logDebug("The desktop app ran this t3, so it updates itself.");
    return undefined;
  }
  const path = yield* Path.Path;
  const arch = yield* HostProcess.Architecture;
  const httpClient = yield* HttpClient.HttpClient;
  const app = yield* locateDesktopApp(input.baseDir);
  if (app === undefined) {
    yield* Effect.logDebug("No desktop app found.", { baseDir: input.baseDir });
    return undefined;
  }
  const fileName =
    app.kind === "other" ? undefined : desktopAppAssetFileName(input.targetVersion, app.kind, arch);
  const checksum =
    fileName === undefined
      ? undefined
      : yield* fetchReleaseChecksums(httpClient, input.targetVersion, input.releaseBaseUrl).pipe(
          Effect.map((checksums) => checksums.get(fileName)),
          Effect.orElseSucceed(() => undefined),
        );
  const current = yield* readDesktopAppBuild(app, { ...input, checksum });
  const appDir =
    app.kind === "appimage"
      ? undefined
      : app.kind === "other"
        ? path.dirname(app.asar)
        : app.installDir;
  return {
    install: app.kind === "other" ? undefined : app,
    current,
    fileName,
    checksum,
    handoff:
      app.kind === "nsis" &&
      launcherOwnsVersionsDir(path, app.installDir, yield* HostProcess.ExecutablePath),
    decision: decideDesktopAppUpdate({
      kind: app.kind,
      current,
      targetVersion: input.targetVersion,
      publishedBuild: input.publishedBuild,
      allowDowngrade: input.allowDowngrade,
      installerChecksum: checksum,
      serviceInsideApp:
        appDir !== undefined &&
        input.serviceProgram !== undefined &&
        launcherOwnsVersionsDir(path, appDir, input.serviceProgram),
    }),
  } satisfies DesktopAppPlan;
});

/** Whether a desktop app process from this executable is running, so its installer reopens it. */
export const isWindowsAppRunning = Effect.fn("cli.desktop_app.is_running")(function* (
  executable: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const byPath = yield* runner
    .run({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "if (Get-Process | Where-Object { $_.Path -eq $env:T3CODE_APP_EXECUTABLE -and $_.Id -ne $env:T3CODE_SELF_PID }) { 'running' }",
      ],
      // Passed by environment so the path needs no PowerShell quoting. This t3 may run from the
      // app's executable through its launcher, so it never counts itself.
      env: { T3CODE_APP_EXECUTABLE: executable, T3CODE_SELF_PID: String(process.pid) },
      timeout: Duration.seconds(15),
    })
    .pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.includes("running") : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
  if (byPath !== undefined) return byPath;
  const name = path.basename(executable);
  return yield* runner
    .run({
      command: "tasklist",
      args: ["/FI", `IMAGENAME eq ${name}`, "/FI", `PID ne ${process.pid}`, "/FO", "CSV", "/NH"],
      timeout: Duration.seconds(10),
    })
    .pipe(
      Effect.map((result) => result.stdout.toLowerCase().includes(`"${name.toLowerCase()}"`)),
      Effect.orElseSucceed(() => false),
    );
});

const HANDOFF_PREFIX = "handoff-";
const HANDOFF_RESULT = "result";
const HANDOFF_SCRIPT = "install.cmd";
// Long enough for an installer another update handed off to have started and finished.
const HANDOFF_GRACE = Duration.hours(1);

/**
 * Exit codes of installers earlier updates handed off that failed. Each finished handoff is read
 * once and its folder removed.
 */
export const readDesktopAppHandoffFailures = Effect.fn("cli.desktop_app.read_handoff_failures")(
  function* (baseDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = path.join(baseDir, "runtime", "desktop");
    const entries = yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []));
    const failures: Array<number> = [];
    for (const entry of entries.filter((name) => name.startsWith(HANDOFF_PREFIX))) {
      const result = yield* fs
        .readFileString(path.join(parent, entry, HANDOFF_RESULT))
        .pipe(Effect.option);
      if (Option.isNone(result)) continue;
      const code = Number.parseInt(result.value.trim(), 10);
      if (code !== 0) failures.push(Number.isNaN(code) ? -1 : code);
      yield* fs
        .remove(path.join(parent, entry), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
    return failures;
  },
);

const failed = (reason: string) => (cause: unknown) => new DesktopAppUpdateError({ reason, cause });

/**
 * Installs verified installer bytes over the app. Returns the command still to run when a .deb
 * needs a password and there is no terminal to ask for it. A handoff starts the Windows installer
 * detached and returns while it runs, since it closes every process in the app's folder.
 */
export const installDesktopApp = Effect.fn("cli.desktop_app.install")(function* (input: {
  readonly install: Exclude<DesktopAppInstall, { readonly kind: "other" }>;
  readonly installer: Uint8Array;
  readonly fileName: string;
  readonly baseDir: string;
  readonly reopen: boolean;
  readonly handoff: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const { install } = input;
  if (install.kind === "appimage") {
    const staging = `${install.appImage}.${process.pid}.download`;
    yield* fs.writeFile(staging, input.installer, { mode: 0o755 }).pipe(
      Effect.andThen(fs.chmod(staging, 0o755)),
      Effect.andThen(fs.rename(staging, install.appImage)),
      Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(failed(`Could not replace ${install.appImage}.`)),
    );
    return undefined;
  }
  // Its own folder per run, so concurrent updates never run each other's installer.
  const parent = path.join(input.baseDir, "runtime", "desktop");
  // A handed-off installer outlives its run, and another update's may not have started yet.
  const settledBefore = (yield* Clock.currentTimeMillis) - Duration.toMillis(HANDOFF_GRACE);
  for (const entry of yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []))) {
    if (!entry.startsWith(HANDOFF_PREFIX)) continue;
    const folder = path.join(parent, entry);
    const createdAt = yield* fs.stat(folder).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
      Effect.orElseSucceed(() => undefined),
    );
    if (createdAt === undefined || createdAt >= settledBefore) continue;
    yield* fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore);
  }
  const directory = yield* fs.makeDirectory(parent, { recursive: true }).pipe(
    Effect.andThen(
      fs.makeTempDirectory({
        directory: parent,
        prefix: input.handoff && install.kind === "nsis" ? HANDOFF_PREFIX : "install-",
      }),
    ),
    Effect.mapError(failed(`Could not prepare ${parent}.`)),
  );
  const removeDirectory = fs
    .remove(directory, { recursive: true, force: true })
    .pipe(Effect.ignore);
  const file = path.join(directory, input.fileName);
  yield* fs.writeFile(file, input.installer).pipe(
    Effect.mapError(failed(`Could not save ${file}.`)),
    Effect.tapError(() => removeDirectory),
  );
  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: Duration.minutes(10) }).pipe(
      Effect.mapError(failed(`Could not run ${command}.`)),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new DesktopAppUpdateError({
            reason: `${command} exited with code ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}.`,
          }),
      ),
    );
  const passwordless =
    install.kind === "deb" &&
    (yield* runner
      .run({ command: "sudo", args: ["-n", "true"], timeout: Duration.seconds(10) })
      .pipe(
        Effect.map((result) => result.code === 0),
        Effect.orElseSucceed(() => false),
      ));
  if (install.kind === "deb" && !passwordless && !(process.stdin.isTTY && process.stdout.isTTY)) {
    // Kept for the command printed below.
    return `sudo dpkg -i '${file.replaceAll("'", `'"'"'`)}'`;
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const args = ["/S", ...(input.reopen ? ["--force-run"] : [])];
  if (install.kind === "nsis" && input.handoff) {
    // Run from its own folder, so no path needs cmd quoting; the next `t3 update` reads the result.
    yield* fs
      .writeFileString(
        path.join(directory, HANDOFF_SCRIPT),
        [
          "@echo off",
          `"%~dp0${input.fileName}" ${args.join(" ")}`,
          `>"%~dp0${HANDOFF_RESULT}" echo %ERRORLEVEL%`,
          "",
        ].join("\r\n"),
      )
      .pipe(
        Effect.mapError(failed(`Could not save ${directory}.`)),
        Effect.tapError(() => removeDirectory),
      );
    const comspec = (yield* HostProcess.Environment).ComSpec?.trim() || "cmd.exe";
    yield* Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make(comspec, ["/d", "/c", HANDOFF_SCRIPT], {
            cwd: directory,
            detached: true,
            windowsHide: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(
          Effect.flatMap((handle) => handle.unref),
          Effect.asVoid,
        ),
    ).pipe(
      Effect.mapError(failed(`Could not start ${file}.`)),
      Effect.tapError(() => removeDirectory),
    );
    return undefined;
  }
  yield* Effect.gen(function* () {
    if (install.kind === "nsis") {
      // The installer closes the app processes under its folder; `--force-run` reopens it.
      return yield* run(file, args);
    }
    if (passwordless) return yield* run("sudo", ["-n", "dpkg", "-i", file]);
    // Effect detaches POSIX children by default; sudo then cannot ask for a password.
    const exitCode = yield* spawner
      .exitCode(
        ChildProcess.make("sudo", ["dpkg", "-i", file], {
          detached: false,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      )
      .pipe(Effect.mapError(failed("Could not run sudo dpkg -i.")));
    if (exitCode !== 0) {
      return yield* new DesktopAppUpdateError({
        reason: `sudo dpkg -i exited with code ${exitCode}.`,
      });
    }
  }).pipe(Effect.ensuring(removeDirectory));
  return undefined;
});
