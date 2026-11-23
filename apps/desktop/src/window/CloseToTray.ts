/** Closing the main window hides it only while a tray icon can bring it back. */
export function shouldHideMainWindowOnClose(state: {
  readonly trayActive: boolean;
  readonly quitting: boolean;
}): boolean {
  return state.trayActive && !state.quitting;
}

/** The Dock keeps a macOS app running, so only Windows and Linux get a tray. */
export function supportsTray(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux";
}
