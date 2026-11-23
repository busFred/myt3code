import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  compareMuseVersions,
  enrichMuseSnapshot,
  museMaintenance,
  parseMuseVersion,
} from "./maintenance.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";

const maintenanceCapabilities = {
  ...makeManualOnlyProviderMaintenanceCapabilities({
    provider: ProviderDriverKind.make("muse"),
    packageName: null,
  }),
  compareVersions: compareMuseVersions,
};
const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("muse"),
  driver: ProviderDriverKind.make("muse"),
  enabled: true,
  installed: true,
  version: "1.0.3",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-09-10T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};

it.layer(NodeServices.layer)("Muse maintenance", (it) => {
  it.effect(
    "compares numeric native release revisions and preserves the CLI release identity",
    () =>
      Effect.sync(() => {
        expect(parseMuseVersion("Muse Code 1.1.1 (1.1.1-R2514.1)")).toBe("1.1.1-R2514.1");
        expect(compareMuseVersions("1.1.1-R9.1", "1.1.1-R10.1")).toBeLessThan(0);
        expect(compareMuseVersions("1.1.1-R2514.1", "1.1.1-R2514.2")).toBeLessThan(0);
        expect(compareMuseVersions("1.2.0-R1.1", "1.1.1-R2514.2")).toBeGreaterThan(0);
        expect(compareMuseVersions("1.4.3", "1.4.3-R5018.1")).toBe(0);
        expect(compareMuseVersions("1.4.2", "1.4.3-R5018.1")).toBeLessThan(0);
      }),
  );

  it.effect("tolerates invalid release manifests and unavailable channels", () =>
    Effect.gen(function* () {
      for (const response of [
        Response.json({ version: 12 }),
        Response.json({ version: "1.1.1" }),
        new Response("unavailable", { status: 503 }),
      ]) {
        const result = yield* enrichMuseSnapshot({
          snapshot,
          maintenanceCapabilities,
          enableProviderUpdateChecks: true,
          environment: {},
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            ),
          ),
          Effect.provide(ProviderLatestVersions.layer),
        );
        expect(result.status).toBe("ready");
        expect(result.versionAdvisory?.status).toBe("unknown");
      }
    }),
  );

  it.effect("updates only a recognized launcher at the resolved instance path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
      const binaryPath = `${directory}/custom muse`;
      const context = {
        binaryPath,
        resolvedCommandPath: binaryPath,
        realCommandPath: binaryPath,
        platform: "linux" as const,
        env: { MUSE_CHANNEL: "muse-canary" },
      };
      yield* fs.writeFileString(
        binaryPath,
        "#!/bin/bash\n# muse-code/launcher-2\n# MUSE_SYNC_UPDATE\n",
      );
      const result = yield* museMaintenance.resolve(context);
      expect(result.update).toMatchObject({
        executable: binaryPath,
        args: ["--version"],
        lockKey: `muse:${binaryPath}`,
        env: {
          MUSE_CHANNEL: "muse-canary",
          MUSE_LOGIN: "0",
          MUSE_NO_AUTO_UPDATE: "0",
          MUSE_SYNC_UPDATE: "1",
          MUSE_UPDATE_INTERVAL_SECONDS: "0",
        },
      });
      expect(result.update?.command).toBe(
        `MUSE_CHANNEL=muse-canary MUSE_LOGIN=0 MUSE_NO_AUTO_UPDATE=0 MUSE_SYNC_UPDATE=1 MUSE_UPDATE_INTERVAL_SECONDS=0 '${binaryPath}' --version`,
      );
      expect(result.compareVersions).toBe(compareMuseVersions);
      yield* fs.writeFileString(binaryPath, "standalone binary");
      expect((yield* museMaintenance.resolve(context)).update).toBeNull();
      expect((yield* museMaintenance.resolve(null)).update).toBeNull();
    }),
  );

  // Meta's Windows installer writes `muse.cmd`, which runs `.muse-launcher.ps1` beside it.
  it.effect("updates the Windows launcher through its cmd shim", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
      const shim = `${directory}/muse.cmd`;
      const context = {
        binaryPath: "muse",
        resolvedCommandPath: shim,
        realCommandPath: shim,
        platform: "win32" as const,
        env: {},
      };
      yield* fs.writeFileString(
        shim,
        '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*\r\n',
      );
      const launcherSource =
        '$user_agent = "muse-code/launcher-ps-$launcher_version"\n$env:MUSE_SYNC_UPDATE\n';
      for (const [launcher, updates] of [
        [launcherSource, true],
        ["# muse-code/launcher-4 MUSE_SYNC_UPDATE", false],
        ["unrelated script", false],
      ] as const) {
        yield* fs.writeFileString(`${directory}/.muse-launcher.ps1`, launcher);
        const result = yield* museMaintenance.resolve(context);
        expect(result.update !== null, launcher).toBe(updates);
      }
      yield* fs.writeFileString(`${directory}/.muse-launcher.ps1`, launcherSource);
      const result = yield* museMaintenance.resolve(context);
      expect(result.update).toMatchObject({
        executable: shim,
        args: ["--version"],
        lockKey: `muse:${shim}`,
        env: { MUSE_LOGIN: "0", MUSE_NO_AUTO_UPDATE: "0", MUSE_SYNC_UPDATE: "1" },
      });
      expect(result.update?.command).toBe(
        `cmd /d /c 'set MUSE_LOGIN=0&& set MUSE_NO_AUTO_UPDATE=0&& set MUSE_SYNC_UPDATE=1&& set MUSE_UPDATE_INTERVAL_SECONDS=0&& "${shim}" --version'`,
      );
      expect(
        (yield* museMaintenance.resolve({ ...context, env: { MUSE_CHANNEL: "it's & co" } })).update
          ?.command,
      ).toBe(
        `cmd /d /c 'set "MUSE_CHANNEL=it''s & co"&& set MUSE_LOGIN=0&& set MUSE_NO_AUTO_UPDATE=0&& set MUSE_SYNC_UPDATE=1&& set MUSE_UPDATE_INTERVAL_SECONDS=0&& "${shim}" --version'`,
      );
      // The bash launcher is not how Windows runs Muse, and a bare binary has no updater.
      expect((yield* museMaintenance.resolve({ ...context, platform: "linux" })).update).toBeNull();
      expect(
        (yield* museMaintenance.resolve({
          ...context,
          resolvedCommandPath: `${directory}/muse.exe`,
          realCommandPath: `${directory}/muse.exe`,
        })).update,
      ).toBeNull();
    }),
  );
});
