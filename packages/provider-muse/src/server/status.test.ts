import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost } from "./sdk.ts";
import type { MuseSubscriptionUsage } from "./protocol.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus } from "./status.ts";

const settings = Schema.decodeSync(MuseSettings);
type ReadUsage = () => Record<string, unknown> | Promise<Record<string, unknown>>;
const makeHost = (catalog: Record<string, unknown>, readUsage: ReadUsage = () => ({})) => {
  const host: MuseSdkHost = {
    initializeResult: { grantedCapabilities: [] },
    connection: {
      request: vi.fn(async (method) => (method === "usage/read" ? readUsage() : catalog)),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-wonder-1.0",
      displayLabel: "muse-wonder-1.0",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};
const subscriptionUsage = {
  observedAtMs: 1791447762610,
  tier: "tier-1",
  window: { usedPercent: 20, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
} satisfies MuseSubscriptionUsage;

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.gen(function* () {
      const binaryPath = yield* fakeCli(
        'process.stderr.write("secret-test-value");process.exit(2);',
      );
      const createHost = vi.fn(async () => makeHost(metaCatalog));
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath }),
        undefined,
        undefined,
        createHost,
      );
      expect(snapshot.snapshot.installed).toBe(true);
      expect(snapshot.snapshot.status).toBe("error");
      expect(snapshot.snapshot.message).not.toContain("secret-test-value");
      expect(createHost).not.toHaveBeenCalled();
    }),
  );

  it.effect("tells the user to finish setup when the launcher has not installed its runtime", () =>
    Effect.gen(function* () {
      // What Muse's launcher prints when a fresh install runs under MUSE_NO_AUTO_UPDATE=1.
      const binaryPath = yield* fakeCli(
        'process.stderr.write("muse: installed binary is missing; rerun the installer\\n");process.exit(1);',
      );
      const snapshot = yield* checkMuseProviderStatus(settings({ enabled: true, binaryPath }));
      expect(snapshot.snapshot.status).toBe("error");
      expect(snapshot.snapshot.message).toContain("muse --version");
    }),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.gen(function* () {
      const binaryPath = yield* fakeCli();
      const host = makeHost(metaCatalog, () => ({ usage: subscriptionUsage }));
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
        undefined,
        undefined,
        async () => host,
      );
      expect(snapshot.snapshot.status).toBe("ready");
      expect(snapshot.snapshot.message).toBeUndefined();
      expect(snapshot.snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
      expect(snapshot.snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot.snapshot.version).toBe("1.0.3-R2198.1");
      expect(snapshot.snapshot.models.map((model) => model.slug)).toEqual([
        "muse-wonder-1.0",
        "muse-custom",
      ]);
      expect(snapshot.snapshot.models.map((model) => model.name)).toEqual([
        "Muse Wonder 1.0",
        "muse-custom",
      ]);
      const descriptor = snapshot.snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
      expect(
        descriptor?.type === "select" && descriptor.options.map((option) => option.id),
      ).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
      expect(host.connection.request).toHaveBeenCalledWith("usage/read", {});
      expect(host.connection.command).not.toHaveBeenCalled();
      expect(host.close).toHaveBeenCalledOnce();
      expect(snapshot.usage).toEqual(subscriptionUsage);
    }),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.gen(function* () {
      const binaryPath = yield* fakeCli();
      const host = makeHost({ providerId: "meta", models: [] });
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath }),
        undefined,
        undefined,
        async () => host,
      );
      expect(snapshot.snapshot.status).toBe("warning");
      expect(snapshot.snapshot.models).toEqual([]);
      expect(host.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect.each([
    ["omits usage", () => ({})],
    ["fails to read usage", () => Promise.reject(new Error("usage unavailable"))],
  ] as const)("stays ready when the host %s", ([_label, readUsage]) =>
    Effect.gen(function* () {
      const binaryPath = yield* fakeCli();
      const host = makeHost(metaCatalog, readUsage);
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath }),
        undefined,
        undefined,
        async () => host,
      );
      expect(snapshot.snapshot.status).toBe("ready");
      expect(snapshot.snapshot.models).toHaveLength(1);
      expect(snapshot.usage).toBeUndefined();
    }),
  );
});
