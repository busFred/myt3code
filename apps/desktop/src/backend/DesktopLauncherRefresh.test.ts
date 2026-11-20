import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { launcherRefreshDecision, refreshInstalledCommand } from "./DesktopLauncherRefresh.ts";

const base = { launchersRecorded: true, installComplete: false, appVersion: "1.2.3" };

it("decides from the cheap file checks first, then the service", () => {
  assert.equal(launcherRefreshDecision({ ...base, launchersRecorded: false }), "skip");
  assert.equal(launcherRefreshDecision({ ...base, installComplete: true }), "skip");
  assert.equal(launcherRefreshDecision(base), "check-service");
  const service = { installed: true, installedVersion: "1.2.3" };
  assert.equal(launcherRefreshDecision({ ...base, service: { installed: false } }), "refresh");
  assert.equal(launcherRefreshDecision({ ...base, service }), "refresh");
  assert.equal(
    launcherRefreshDecision({ ...base, service: { installed: true, installedVersion: "1.2.2" } }),
    "skip",
  );
  assert.equal(
    launcherRefreshDecision({
      ...base,
      service: { installed: true, installedVersion: "1.2.2", otherBaseDir: "/other" },
    }),
    "refresh",
  );
});

it.layer(NodeServices.layer)("desktop launcher refresh", (it) => {
  const run = (input: { readonly installComplete: boolean; readonly isPackaged: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-refresh-" });
      yield* fs.makeDirectory(path.join(baseDir, "runtime", "versions", "1.2.3"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "launchers"),
        "/home/u/.local/bin/t3\n",
      );
      if (input.installComplete) {
        yield* fs.writeFileString(
          path.join(baseDir, "runtime", "versions", "1.2.3", ".install-complete"),
          "1.2.3\n",
        );
      }
      let spawned = 0;
      yield* refreshInstalledCommand().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              path,
              baseDir,
              serverRoot: "/bundled",
              appVersion: "1.2.3",
              isPackaged: input.isPackaged,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.sync(() => (spawned += 1)).pipe(Effect.andThen(Effect.die("stop"))),
              ),
            ),
          ),
        ),
      );
      return spawned;
    });

  it.effect("spawns nothing once this version's runtime is installed", () =>
    Effect.gen(function* () {
      assert.equal(yield* run({ installComplete: true, isPackaged: true }), 0);
    }),
  );

  it.effect("spawns nothing for an unpackaged app", () =>
    Effect.gen(function* () {
      assert.equal(yield* run({ installComplete: false, isPackaged: false }), 0);
    }),
  );

  it.effect("asks the bundled CLI about the service when the runtime is missing", () =>
    Effect.gen(function* () {
      assert.equal(yield* run({ installComplete: false, isPackaged: true }), 1);
    }),
  );
});
