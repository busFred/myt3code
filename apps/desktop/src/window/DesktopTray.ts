import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { msg } from "gt-i18n";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import { m, onLocaleChange } from "../i18n/messages.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { supportsTray } from "./CloseToTray.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    /** Creates or removes the tray icon to match the close-to-tray setting. */
    readonly sync: Effect.Effect<void>;
    /** Syncs now and again after each UI language change. */
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logWarning } = makeComponentLogger("desktop-tray");

/** @public */
export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopState = yield* DesktopState.DesktopState;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTray = yield* ElectronTray.ElectronTray;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const showWindow = desktopWindow.activate.pipe(
    Effect.catchCause((cause) => logWarning("failed to show the window from the tray", { cause })),
  );

  const sync = Effect.gen(function* () {
    const wasActive = yield* Ref.get(desktopState.trayActive);
    const enabled = supportsTray(environment.platform) && (yield* desktopSettings.get).closeToTray;
    const icons = yield* assets.iconPaths;
    // Windows scales an .ico to the tray size; Linux needs the png.
    const iconPath = Option.orElse(environment.platform === "win32" ? icons.ico : icons.png, () =>
      environment.platform === "win32" ? icons.png : icons.ico,
    );

    if (enabled && Option.isSome(iconPath)) {
      const shown = yield* electronTray
        .show({
          iconPath: iconPath.value,
          tooltip: environment.displayName,
          menu: [
            { label: m(msg("Show T3 Code")), click: () => runFork(showWindow) },
            { type: "separator" },
            {
              label: m(msg("Quit", { $context: "tray menu item, quits the app" })),
              click: () => runFork(electronApp.quit),
            },
          ],
          onClick: () => runFork(showWindow),
        })
        .pipe(
          Effect.as(true),
          // A native failure must not block startup; closing the window quits instead.
          Effect.catchCause((cause) =>
            logWarning("failed to create the tray; closing the window will quit", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      if (shown) {
        yield* Ref.set(desktopState.trayActive, true);
        return;
      }
    } else if (enabled) {
      yield* logWarning("no icon found for the tray; closing the window will quit");
    }

    yield* Ref.set(desktopState.trayActive, false);
    yield* electronTray.hide;
    // A window hidden by the tray has no other way back.
    if (wasActive) yield* showWindow;
  }).pipe(Effect.withSpan("desktop.tray.sync"));

  let rebuildsOnLocaleChange = false;
  return DesktopTray.of({
    sync,
    configure: sync.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (rebuildsOnLocaleChange) return;
          rebuildsOnLocaleChange = true;
          onLocaleChange(() => runFork(sync));
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopTray, make);
