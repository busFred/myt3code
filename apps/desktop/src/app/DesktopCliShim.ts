import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import {
  DESKTOP_CLI_SHIM_MARKER as MARKER,
  DESKTOP_CLI_SHIM_SERVER_ENTRY as SERVER_ENTRY,
  renderCliShim,
  type CliShimTarget,
} from "@t3tools/shared/desktopCliShim";

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
  const content = renderCliShim({ target, shimPath, t3Home: environment.baseDir });

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
