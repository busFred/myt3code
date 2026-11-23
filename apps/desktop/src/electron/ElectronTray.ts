import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export interface ElectronTrayInput {
  readonly iconPath: string;
  readonly tooltip: string;
  readonly menu: readonly Electron.MenuItemConstructorOptions[];
  readonly onClick: () => void;
}

// Linux trays draw the icon at its native size, and the app icon is 1024px.
const LINUX_TRAY_ICON_SIZE = 32;

export class ElectronTray extends Context.Service<
  ElectronTray,
  {
    /** Creates the tray icon, or updates the existing one in place. */
    readonly show: (input: ElectronTrayInput) => Effect.Effect<void>;
    readonly hide: Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronTray") {}

/** @public */
export const make = Effect.gen(function* () {
  let tray: Electron.Tray | null = null;
  let onClick: (() => void) | null = null;

  const hide = Effect.sync(() => {
    tray?.destroy();
    tray = null;
    onClick = null;
  });

  yield* Effect.addFinalizer(() => hide);

  return ElectronTray.of({
    show: Effect.fn("ElectronTray.show")(function* (input) {
      yield* Effect.sync(() => {
        const loaded = Electron.nativeImage.createFromPath(input.iconPath);
        const image =
          input.iconPath.endsWith(".png") && !loaded.isEmpty()
            ? loaded.resize({ width: LINUX_TRAY_ICON_SIZE, height: LINUX_TRAY_ICON_SIZE })
            : loaded;
        onClick = input.onClick;
        if (tray === null) {
          tray = new Electron.Tray(image);
          tray.on("click", () => onClick?.());
        } else {
          tray.setImage(image);
        }
        tray.setToolTip(input.tooltip);
        // Linux needs the menu set again after it changes.
        tray.setContextMenu(Electron.Menu.buildFromTemplate([...input.menu]));
      });
    }),
    hide,
  });
});

export const layer = Layer.effect(ElectronTray, make);
