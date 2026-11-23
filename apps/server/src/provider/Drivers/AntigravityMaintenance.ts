import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type * as Effect from "effect/Effect";

import type {
  AntigravityExecutable,
  AntigravityInstallationError,
} from "../AntigravityInstallation.ts";

const DRIVER = ProviderDriverKind.make("antigravity");

/** Where Google's install.sh and install.ps1 put the standalone CLI, which `agy update` replaces. */
function isStandaloneAgyPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/agy") ||
    /\/appdata\/local\/agy\/bin\/agy\.exe$/.test(normalized)
  );
}

export function makeAntigravityMaintenanceCapabilities(input: {
  readonly executable: (AntigravityExecutable & { readonly realPath: string }) | null;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly update: Effect.Effect<void, AntigravityInstallationError>;
  readonly latestVersion: Effect.Effect<string | null>;
}): ProviderMaintenanceCapabilities {
  const { executable } = input;
  if (executable === null) {
    return makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null });
  }
  const latest = { latestVersion: null, lookupLatestVersion: input.latestVersion } as const;
  if (executable.source === "managed") {
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER,
      packageName: null,
      updateExecutable: "antigravity",
      updateArgs: [],
      updateLockKey: "antigravity:managed",
      updateCommand: "Install the latest Antigravity runtime with T3 Code",
      run: input.update,
      ...latest,
    });
  }
  // A copy another tool installed, or a pinned managed release, is not this updater's to replace.
  if (executable.managedVersionDirectory !== null || !isStandaloneAgyPath(executable.realPath)) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER,
      packageName: null,
      installPath: executable.realPath,
      lookupLatestVersion: input.latestVersion,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: DRIVER,
    packageName: null,
    updateExecutable: executable.executablePath,
    updateArgs: ["update"],
    updateLockKey: `antigravity:${executable.realPath}`,
    platform: input.platform,
    env: input.env,
    ...latest,
  });
}
