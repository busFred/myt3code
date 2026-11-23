import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { AntigravityExecutable } from "../AntigravityInstallation.ts";
import { makeAntigravityMaintenanceCapabilities } from "./AntigravityMaintenance.ts";

const update = Effect.void;
const latestVersion = Effect.succeed("1.6.0");

const resolve = (
  executable: (AntigravityExecutable & { readonly realPath: string }) | null,
  platform: NodeJS.Platform = "linux",
) =>
  makeAntigravityMaintenanceCapabilities({
    executable,
    platform,
    env: { PATH: "/usr/bin" },
    update,
    latestVersion,
  });

const external = (executablePath: string, realPath = executablePath) => ({
  executablePath,
  realPath,
  source: "path" as const,
  version: null,
  managedVersionDirectory: null,
});

describe("Antigravity maintenance", () => {
  it("installs T3's managed runtime in the server", () => {
    const managedPath = "/t3/tools/antigravity-acp/linux-x64/versions/abc/antigravity";
    const capabilities = resolve({
      executablePath: managedPath,
      realPath: managedPath,
      source: "managed",
      version: "1.5.7",
      managedVersionDirectory: "/t3/tools/antigravity-acp/linux-x64/versions/abc",
    });
    expect(capabilities.update).toMatchObject({ lockKey: "antigravity:managed", args: [] });
    expect(capabilities.update?.run).toBe(update);
    expect(capabilities.lookupLatestVersion).toBe(latestVersion);
  });

  it.each([
    ["linux", "/home/me/.local/bin/agy", "/home/me/.local/bin/agy"],
    ["darwin", "/Users/me/.local/bin/agy", "/Users/me/.local/bin/agy"],
    [
      "win32",
      "C:\\Users\\Me\\AppData\\Local\\agy\\bin\\agy.exe",
      "C:\\Users\\Me\\AppData\\Local\\agy\\bin\\agy.exe",
    ],
  ] as const)("runs `agy update` for Google's standalone CLI on %s", (platform, path, command) => {
    const capabilities = resolve(external(path), platform);
    expect(capabilities.update).toMatchObject({
      executable: path,
      args: ["update"],
      lockKey: `antigravity:${path}`,
      env: { PATH: "/usr/bin" },
    });
    expect(capabilities.update?.run).toBeUndefined();
    expect(capabilities.update?.command).toContain(command);
  });

  it.each([
    [
      "another tool's copy",
      external("/opt/homebrew/bin/agy", "/opt/homebrew/Cellar/agy/1/bin/agy"),
    ],
    [
      "a custom path to one managed release",
      {
        ...external("/t3/tools/antigravity-acp/linux-x64/versions/abc/antigravity"),
        source: "override" as const,
        managedVersionDirectory: "/t3/tools/antigravity-acp/linux-x64/versions/abc",
      },
    ],
  ])("leaves %s manual, naming what T3 Code runs", (_name, executable) => {
    const capabilities = resolve(executable);
    expect(capabilities.update).toBeNull();
    expect(capabilities.installPath).toBe(executable.realPath);
    expect(capabilities.lookupLatestVersion).toBe(latestVersion);
  });

  it("stays manual without an installation", () => {
    expect(resolve(null).update).toBeNull();
  });
});
