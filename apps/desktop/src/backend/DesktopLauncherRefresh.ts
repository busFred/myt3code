import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { decodeServiceStatus, runBundledCli } from "./DesktopServiceConnection.ts";

export const launcherRefreshDecision = (input: {
  readonly launchersRecorded: boolean;
  readonly installComplete: boolean;
  readonly service?:
    | {
        readonly installed: boolean;
        readonly otherBaseDir?: string | undefined;
        readonly installedVersion?: string | undefined;
      }
    | undefined;
  readonly appVersion: string;
}) => {
  if (!input.launchersRecorded || input.installComplete) return "skip";
  if (input.service === undefined) return "check-service";
  const serviceHere = input.service.installed && input.service.otherBaseDir === undefined;
  // An older service is the app's update prompt's to move; this never restarts one.
  return serviceHere && input.service.installedVersion !== input.appVersion ? "skip" : "refresh";
};

/** Brings an installed `t3` command up to this app's version in the background. */
export const refreshInstalledCommand = Effect.fn("DesktopLauncherRefresh.refreshInstalledCommand")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged) return;
    const fs = yield* FileSystem.FileSystem;
    const runtimeDir = environment.path.join(environment.baseDir, "runtime");
    const state = {
      launchersRecorded: yield* fs.exists(environment.path.join(runtimeDir, "launchers")),
      installComplete: yield* fs.exists(
        environment.path.join(runtimeDir, "versions", environment.appVersion, ".install-complete"),
      ),
      appVersion: environment.appVersion,
    };
    if (launcherRefreshDecision(state) !== "check-service") return;
    const service = yield* runBundledCli("status", ["service", "status", "--json"]).pipe(
      Effect.flatMap(decodeServiceStatus),
    );
    if (launcherRefreshDecision({ ...state, service }) !== "refresh") return;
    yield* runBundledCli("update", ["update", environment.appVersion, "--yes"]);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not bring the installed t3 command up to this app's version.", {
      cause,
    }),
  ),
);
