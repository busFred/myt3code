import type { DesktopCloseWindowBehavior } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTray from "./DesktopTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/home/alice",
  platform: "linux",
  processArch: "x64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

interface Recorded {
  shown: ElectronTray.ElectronTrayInput[];
  hides: number;
  activations: number;
  quits: number;
  forkedDone: Deferred.Deferred<void>;
}

const harness = (
  platform: "linux" | "win32" | "darwin",
  closeWindowBehavior: DesktopCloseWindowBehavior,
  show?: () => Effect.Effect<void>,
) => {
  const recorded: Recorded = {
    shown: [],
    hides: 0,
    activations: 0,
    quits: 0,
    forkedDone: Deferred.makeUnsafe<void>(),
  };
  // Completes once the three forked tray callbacks (two shows, one quit) have run.
  const settle = () => {
    if (recorded.activations >= 2 && recorded.quits >= 1) {
      Deferred.doneUnsafe(recorded.forkedDone, Effect.void);
    }
  };
  const layer = DesktopTray.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(ElectronTray.ElectronTray, {
        show: (input) => show?.() ?? Effect.sync(() => void recorded.shown.push(input)),
        hide: Effect.sync(() => void (recorded.hides += 1)),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(DesktopWindow.DesktopWindow)({
        activate: Effect.sync(() => {
          recorded.activations += 1;
          settle();
        }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ElectronApp.ElectronApp)({
        quit: Effect.sync(() => {
          recorded.quits += 1;
          settle();
        }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(DesktopAssets.DesktopAssets, {
        iconPaths: Effect.succeed({
          ico: Option.some("/icons/icon.ico"),
          icns: Option.none(),
          png: Option.some("/icons/icon.png"),
        }),
        resolveResourcePath: () => Effect.succeedNone,
      }),
    ),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        closeWindowBehavior,
      }),
    ),
    Layer.provideMerge(
      DesktopEnvironment.layer({ ...environmentInput, platform }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
      ),
    ),
  );
  return { recorded, layer };
};

describe("DesktopTray", () => {
  it.effect.each([
    { platform: "linux", icon: "/icons/icon.png" },
    { platform: "win32", icon: "/icons/icon.ico" },
  ] as const)("shows a tray with Show and Quit on $platform", ({ platform, icon }) => {
    const { recorded, layer } = harness(platform, "tray");
    return Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      const state = yield* DesktopState.DesktopState;
      yield* tray.sync;

      assert.isTrue(yield* Ref.get(state.trayActive));
      const shown = recorded.shown[0];
      assert.equal(recorded.shown.length, 1);
      assert.equal(shown?.iconPath, icon);
      const items = (shown?.menu ?? []).filter((item) => item.type !== "separator");
      assert.deepEqual(
        items.map((item) => item.label),
        ["Show T3 Code", "Quit app"],
      );

      items[0]?.click?.({} as never, undefined, {} as never);
      shown?.onClick();
      items[1]?.click?.({} as never, undefined, {} as never);
      yield* Deferred.await(recorded.forkedDone);
      assert.equal(recorded.activations, 2);
      assert.equal(recorded.quits, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { platform: "linux", closeWindowBehavior: "app-only" },
    { platform: "linux", closeWindowBehavior: "app-and-service" },
    { platform: "darwin", closeWindowBehavior: "tray" },
  ] as const)(
    "creates no tray on $platform when closeWindowBehavior=$closeWindowBehavior",
    ({ platform, closeWindowBehavior }) => {
      const { recorded, layer } = harness(platform, closeWindowBehavior);
      return Effect.gen(function* () {
        const tray = yield* DesktopTray.DesktopTray;
        const state = yield* DesktopState.DesktopState;
        yield* tray.sync;

        assert.isFalse(yield* Ref.get(state.trayActive));
        assert.equal(recorded.shown.length, 0);
        assert.equal(recorded.activations, 0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("removes the tray and shows the window when turned off at runtime", () => {
    const { recorded, layer } = harness("linux", "tray");
    return Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      const state = yield* DesktopState.DesktopState;
      yield* tray.sync;
      yield* settings.setCloseWindowBehavior("app-only");
      yield* tray.sync;

      assert.isFalse(yield* Ref.get(state.trayActive));
      assert.equal(recorded.hides, 1);
      assert.equal(recorded.activations, 1);

      yield* settings.setCloseWindowBehavior("ask");
      yield* tray.sync;
      assert.isTrue(yield* Ref.get(state.trayActive));
      assert.equal(recorded.shown.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps closing the window quitting when the native tray fails", () => {
    const { recorded, layer } = harness("linux", "tray", () => Effect.die(new Error("no tray")));
    return Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      const state = yield* DesktopState.DesktopState;
      yield* tray.sync;

      assert.isFalse(yield* Ref.get(state.trayActive));
      assert.equal(recorded.hides, 1);
    }).pipe(Effect.provide(layer));
  });
});
