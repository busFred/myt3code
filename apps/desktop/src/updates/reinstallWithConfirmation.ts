import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { msg } from "gt-i18n";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { m } from "../i18n/messages.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

/** Shared by the Help menu item and the Settings → About button. */
export const reinstallWithConfirmation = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: m(msg("Updates unavailable")),
      message: m(msg("Automatic updates are not available right now.")),
      detail: disabledReason.value,
      buttons: [m(msg("OK"))],
    });
    return;
  }
  const { response } = yield* electronDialog.showMessageBox({
    type: "warning",
    title: m(msg("Reinstall this version")),
    message: m(msg("Download and reinstall this version of T3 Code?")),
    detail: m(
      msg(
        "This restarts the background service, if there is one, and then relaunches T3 Code. Any running tasks will be interrupted.",
      ),
    ),
    buttons: [m(msg("Reinstall")), m(msg("Cancel"))],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  yield* updates.reinstallCurrent.pipe(
    Effect.catchTags({
      DesktopReinstallError: (error) =>
        electronDialog.showMessageBox({
          type: "error",
          title: m(msg("Reinstall failed")),
          message: m(msg("T3 Code could not be reinstalled.")),
          detail: error.reason,
          buttons: [m(msg("OK"))],
        }),
    }),
  );
}).pipe(Effect.withSpan("desktop.updates.reinstallWithConfirmation"));
