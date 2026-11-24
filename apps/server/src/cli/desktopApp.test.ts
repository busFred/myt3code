import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { encodeAsar } from "../testUtils/asar.ts";
import { decideDesktopAppUpdate, readAsarRootFile } from "./desktopApp.ts";

const decide = (overrides: Partial<Parameters<typeof decideDesktopAppUpdate>[0]>) =>
  decideDesktopAppUpdate({
    kind: "nsis",
    current: { version: "1.2.3", build: "aaaaaaaaaaaa" },
    targetVersion: "1.2.3",
    publishedBuild: "bbbbbbbbbbbb",
    allowDowngrade: false,
    installerChecksum: "c".repeat(64),
    serviceInsideApp: false,
    ...overrides,
  }).action;

it.each([
  { name: "a rebuild of the same version", overrides: {}, action: "install" },
  {
    name: "an older version",
    overrides: { current: { version: "1.2.2", build: "bbbbbbbbbbbb" } },
    action: "install",
  },
  {
    name: "an app with no recorded build",
    overrides: { current: { version: "1.2.3", build: undefined } },
    action: "install",
  },
  {
    name: "the published build",
    overrides: { current: { version: "1.2.3", build: "bbbbbbbbbbbb" } },
    action: "current",
  },
  {
    name: "a release without BUILD, same version",
    overrides: { publishedBuild: undefined },
    action: "current",
  },
  {
    name: "a release without BUILD, older app",
    overrides: { publishedBuild: undefined, current: { version: "1.2.2", build: undefined } },
    action: "skip",
  },
  {
    name: "an unreadable app",
    overrides: { current: { version: undefined, build: undefined } },
    action: "skip",
  },
  {
    name: "another channel",
    overrides: { current: { version: "1.2.4-nightly.20261101.1", build: "aaaaaaaaaaaa" } },
    action: "skip",
  },
  {
    name: "a newer app",
    overrides: { current: { version: "1.3.0", build: "aaaaaaaaaaaa" } },
    action: "skip",
  },
  {
    name: "a newer app with --allow-downgrade",
    overrides: { current: { version: "1.3.0", build: "aaaaaaaaaaaa" }, allowDowngrade: true },
    action: "install",
  },
  {
    name: "no checksum for the installer",
    overrides: { installerChecksum: undefined },
    action: "skip",
  },
  { name: "a service running from the app", overrides: { serviceInsideApp: true }, action: "skip" },
  { name: "an install t3 cannot replace", overrides: { kind: "other" as const }, action: "skip" },
])("decides $action for $name", ({ overrides, action }) => {
  assert.equal(decide(overrides), action);
});

it.effect("reads a root file out of an asar archive", () =>
  Effect.gen(function* () {
    const manifest = JSON.stringify({ version: "1.2.3", t3codeCommitHash: "abcdef123456" });
    const archive = encodeAsar({ "index.js": "console.log(1)\n", "package.json": manifest });
    const read = (position: number, length: number) =>
      Effect.succeed(archive.subarray(position, position + length));
    assert.equal(yield* readAsarRootFile(read, "package.json"), manifest);
    assert.isUndefined(yield* readAsarRootFile(read, "missing.json"));
    assert.isUndefined(
      yield* readAsarRootFile(() => Effect.succeed(new Uint8Array(4)), "package.json"),
    );
  }),
);
