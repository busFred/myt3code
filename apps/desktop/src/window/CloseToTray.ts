/** The Dock keeps a macOS app running, so only Windows and Linux get a tray. */
export function supportsTray(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux";
}
