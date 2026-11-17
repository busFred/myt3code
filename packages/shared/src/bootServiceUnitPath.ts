/** Where each platform's service manager keeps the T3 Code service definition by default. */

interface PathOps {
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly isAbsolute: (path: string) => boolean;
}

const BOOT_SERVICE_NAME = "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.t3tools.t3code), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
/** Task Scheduler keeps its own copy; this one lets status and repair read the task back. */
export const BOOT_SERVICE_TASK_FILE = `${BOOT_SERVICE_NAME}-task.xml`;

export const defaultSystemdUnitDir = (path: PathOps, homeDir: string, xdgConfigHome: string) =>
  path.join(
    path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(homeDir, ".config"),
    "systemd",
    "user",
  );

export const scheduledTaskPath = (path: PathOps, localAppData: string) =>
  path.join(localAppData, "t3code", BOOT_SERVICE_TASK_FILE);

export const launchdPlistPath = (path: PathOps, homeDir: string) =>
  path.join(homeDir, "Library", "LaunchAgents", BOOT_SERVICE_PLIST_FILE);

/**
 * The default unit path, without asking systemd for a relocated unit directory. A miss here
 * does not prove no service exists; callers use it only to skip a slower check.
 */
export const defaultBootServiceUnitPath = (input: {
  readonly path: PathOps;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string | undefined => {
  if (input.homeDir === "") return undefined;
  if (input.platform === "darwin") return launchdPlistPath(input.path, input.homeDir);
  if (input.platform === "win32") {
    const localAppData = input.environment.LOCALAPPDATA ?? "";
    return localAppData === "" ? undefined : scheduledTaskPath(input.path, localAppData);
  }
  if (input.platform !== "linux") return undefined;
  return input.path.join(
    defaultSystemdUnitDir(input.path, input.homeDir, input.environment.XDG_CONFIG_HOME ?? ""),
    BOOT_SERVICE_UNIT_FILE,
  );
};
