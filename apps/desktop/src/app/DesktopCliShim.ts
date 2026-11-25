import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import {
  DESKTOP_CLI_SHIM_MARKER as MARKER,
  DESKTOP_CLI_SHIM_SERVER_ENTRY as SERVER_ENTRY,
  renderCliShim,
  standaloneLauncherTarget,
  type CliShimTarget,
} from "@t3tools/shared/desktopCliShim";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-cli-shim");

export { MARKER, renderCliShim, type CliShimTarget };

export const launcherPath = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.path.join(
    environment.baseDir,
    "bin",
    environment.platform === "win32" ? "t3.cmd" : "t3",
  );

/** The newest standalone t3 this home's recorded launchers run, which this launcher then runs too. */
export const installedRuntime = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  const versionsDir = path.join(environment.baseDir, "runtime", "versions");
  const records = yield* fs
    .readFileString(path.join(environment.baseDir, "runtime", "launchers"))
    .pipe(Effect.orElseSucceed(() => ""));
  let newest: { readonly version: string; readonly executable: string } | undefined;
  for (const launcher of new Set(records.split(/\r?\n/).filter((line) => path.isAbsolute(line)))) {
    const link = yield* fs.readLink(launcher).pipe(Effect.option);
    // Stat first so a runtime binary recorded by mistake is never read whole.
    const small = yield* fs.stat(launcher).pipe(
      Effect.map((info) => info.type === "File" && info.size <= 4096n),
      Effect.orElseSucceed(() => false),
    );
    const executable = Option.isSome(link)
      ? path.resolve(path.dirname(launcher), link.value)
      : small
        ? standaloneLauncherTarget(
            yield* fs.readFileString(launcher).pipe(Effect.orElseSucceed(() => "")),
            environment.platform,
          )
        : undefined;
    if (executable === undefined) continue;
    const [version, name, ...rest] = path.relative(versionsDir, executable).split(/[\\/]/);
    if (
      version === undefined ||
      parseSemver(version) === null ||
      !/^t3(?:\.exe)?$/i.test(name ?? "") ||
      rest.length > 0 ||
      !(yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false)))
    ) {
      continue;
    }
    if (newest === undefined || compareSemverVersions(version, newest.version) > 0) {
      newest = { version, executable };
    }
  }
  return newest?.executable;
});

export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const shimPath = launcherPath(environment);
  const entry = path.join(environment.serverRoot, SERVER_ENTRY);
  const target: CliShimTarget = windows
    ? { kind: "windows", executable: process.execPath, entry }
    : Option.match(environment.appImagePath, {
        onSome: (appImage) => ({
          kind: "appimage" as const,
          appImage,
          executableName: path.basename(process.execPath),
        }),
        onNone: () => ({ kind: "direct" as const, executable: process.execPath, entry }),
      });
  const runtime = yield* installedRuntime;
  const content = renderCliShim({ target, shimPath, t3Home: environment.baseDir, runtime });

  return yield* Effect.gen(function* () {
    const existing = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isSome(existing) && !existing.value.includes(MARKER)) {
      yield* logWarning("leaving a t3 launcher the app did not write", { shimPath });
      return Option.none<string>();
    }
    if (Option.getOrUndefined(existing) !== content) {
      yield* fs.makeDirectory(path.dirname(shimPath), { recursive: true });
      // Unique per call: backend startup and the first-launch command install can race here.
      const staging = `${shimPath}.${process.pid}.${yield* Random.nextIntBetween(0, 0xffffff)}.tmp`;
      yield* fs.writeFileString(staging, content, { mode: 0o755 });
      yield* fs.rename(staging, shimPath);
      yield* logInfo("installed t3 launcher", { shimPath });
    }
    return Option.some(shimPath);
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("could not install t3 launcher", { shimPath, cause: Cause.pretty(cause) }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
    Effect.withSpan("desktop.cliShim.install"),
  );
});
