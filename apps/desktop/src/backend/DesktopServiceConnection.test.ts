// @effect-diagnostics nodeBuiltinImport:off -- Exercises the ownership lock in an isolated temporary home.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { prepareLocalBackend } from "./DesktopServiceConnection.ts";

it.layer(NodeServices.layer)("desktop service connection", (it) => {
  it.effect("starts its own server without the bundled CLI when no service can exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-no-service-" });
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir);
      const result = yield* prepareLocalBackend().pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopState.layer,
            DesktopAppSettings.layerTest(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              path,
              baseDir,
              stateDir,
              serverRoot: "/bundled",
              platform: "linux",
              homeDirectory: baseDir,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.die("the bundled CLI must not run")),
            ),
            Layer.mock(ElectronDialog.ElectronDialog, {}),
            Layer.mock(ElectronWindow.ElectronWindow, {}),
            Layer.mock(DesktopWindow.DesktopWindow, {}),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("no request expected")),
            ),
          ),
        ),
        Effect.provideService(HostProcess.Environment, {}),
      );
      assert.equal(result, "own");
    }),
  );

  it.effect.each([
    {
      response: 0,
      remember: true,
      expected: "app-only",
      stopped: false,
      accepted: true,
      stopFails: false,
    },
    {
      response: 1,
      remember: true,
      expected: "app-and-service",
      stopped: true,
      accepted: true,
      stopFails: false,
    },
    {
      response: 2,
      remember: true,
      expected: "ask",
      stopped: false,
      accepted: false,
      stopFails: false,
    },
    {
      response: 1,
      remember: false,
      expected: "ask",
      stopped: true,
      accepted: true,
      stopFails: true,
    },
  ])("quit choice $response, remember=$remember, stop failure=$stopFails", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-service-" });
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir);
      const runtime = {
        pid: process.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        serviceManaged: true,
        serverVersion: "1.2.3",
      };
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        JSON.stringify(runtime),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const db = new NodeSqlite.DatabaseSync(path.join(stateDir, "server-owner.sqlite"));
          db.exec("BEGIN EXCLUSIVE");
          return db;
        }),
        (db) => Effect.sync(() => db.close()),
      );
      const calls: ReadonlyArray<string>[] = [];
      const errors: string[] = [];
      let exchanges = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand")
          return Effect.die("expected direct bundled CLI invocation");
        const args = command.args.map((arg) => {
          if (typeof arg !== "string") throw new Error("unexpected redacted CLI argument");
          return arg;
        });
        calls.push(args);
        assert.equal(command.command, process.execPath);
        assert.equal(args[0], "/bundled/apps/server/dist/bin.mjs");
        assert.deepEqual(args.slice(-2), ["--base-dir", baseDir]);
        assert.equal(command.options.env?.ELECTRON_RUN_AS_NODE, "1");
        const stdout = args.includes("status")
          ? JSON.stringify({
              installed: true,
              running: true,
              current: true,
              installedBaseDir: baseDir,
              problems: [],
            })
          : args.includes("pair")
            ? JSON.stringify({
                credential: `PAIR${calls.length}`,
                expiresAt: "2026-11-17T00:00:00Z",
                httpBaseUrl: runtime.origin,
              })
            : "Stopped.";
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(456),
            exitCode: Effect.succeed(
              ChildProcessSpawner.ExitCode(input.stopFails && args.includes("stop") ? 1 : 0),
            ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.die("must never signal the attached server"),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const layer = Layer.mergeAll(
        DesktopState.layer,
        DesktopAppSettings.layerTest({
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          serviceConnectionRemembered: true,
        }),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          path,
          baseDir,
          stateDir,
          serverRoot: "/bundled",
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.mock(ElectronDialog.ElectronDialog, {
          showMessageBox: () =>
            Effect.succeed({ response: input.response, checkboxChecked: input.remember }),
          showErrorBox: (title) =>
            Effect.sync(() => {
              errors.push(title);
            }),
        }),
        Layer.mock(ElectronWindow.ElectronWindow, { currentMainOrFirst: Effect.succeedNone }),
        Layer.mock(DesktopWindow.DesktopWindow, { activate: Effect.void }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            exchanges++;
            if (exchanges === 1)
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      _tag: "EnvironmentAuthInvalidError",
                      code: "auth_invalid",
                      reason: "missing_credential",
                      traceId: "test",
                    }),
                    { status: 401, headers: { "content-type": "application/json" } },
                  ),
                ),
              );

            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: `bearer-${exchanges}`,
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              ),
            );
          }),
        ),
      );
      yield* Effect.gen(function* () {
        assert.equal(yield* prepareLocalBackend(), "attach");
        const state = yield* DesktopState.DesktopState;
        const attachment = Option.getOrThrow(yield* Ref.get(state.localBackendAttachment));
        assert.equal(yield* attachment.getBearerToken, "bearer-2");
        assert.equal(yield* attachment.getBearerToken, "bearer-2");
        assert.equal(calls.filter((args) => args.includes("pair")).length, 2);
        assert.equal(yield* attachment.confirmQuit(() => true), input.accepted);
        assert.equal(
          (yield* (yield* DesktopAppSettings.DesktopAppSettings).get).serviceQuitBehavior,
          input.expected,
        );
        assert.equal(
          calls.some((args) => args.includes("stop")),
          input.stopped,
        );
        assert.equal(errors.length, input.stopFails ? 1 : 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
