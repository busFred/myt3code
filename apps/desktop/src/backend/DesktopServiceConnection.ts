import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { defaultBootServiceUnitPath } from "@t3tools/shared/bootServiceUnitPath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";
import { launchDecision, quitDecision } from "./DesktopServiceDecision.ts";

export class DesktopServiceConnectionError extends Schema.TaggedError<DesktopServiceConnectionError>()(
  "DesktopServiceConnectionError",
  {
    operation: Schema.Literals(["status", "start", "stop", "pair", "connect"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not ${this.operation} the local T3 Code server.`;
  }
}

export interface Attachment {
  readonly owner: DesktopHomeOwner.HomeOwner;
  readonly readOwner: Effect.Effect<Option.Option<DesktopHomeOwner.HomeOwner>>;
  readonly getBearerToken: Effect.Effect<string, DesktopServiceConnectionError>;
  readonly confirmQuit: (isUserQuit: () => boolean) => Effect.Effect<boolean>;
}

const ServiceStatus = Schema.Struct({
  installed: Schema.Boolean,
  running: Schema.Boolean,
  current: Schema.Boolean,
  installedVersion: Schema.optional(Schema.String),
  installedBaseDir: Schema.optional(Schema.String),
  otherBaseDir: Schema.optional(Schema.String),
  problems: Schema.Array(Schema.String),
});
const PairResult = Schema.Struct({
  credential: Schema.String,
  expiresAt: Schema.String,
  httpBaseUrl: Schema.String,
});

const decodeServiceStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceStatus));
const decodePairResult = Schema.decodeUnknownEffect(Schema.fromJsonString(PairResult));

const runBundledCli = Effect.fn("DesktopServiceConnection.runBundledCli")(function* (
  operation: DesktopServiceConnectionError["operation"],
  args: ReadonlyArray<string>,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            environment.path.join(environment.serverRoot, "apps/server/dist/bin.mjs"),
            ...args,
            "--base-dir",
            environment.baseDir,
          ],
          {
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              T3_BOOT_SERVICE_UNIT: undefined,
              T3_SERVICE_LAUNCHER_CONTEXT: undefined,
              T3CODE_DESKTOP_CLI_LAUNCHER: undefined,
            },
            extendEnv: true,
            stdin: "ignore",
            stderr: "pipe",
          },
        ),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.runDrain),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0) return yield* new DesktopServiceConnectionError({ operation, cause: code });
      return stdout;
    }),
  ).pipe(
    Effect.timeout(Duration.seconds(130)),
    Effect.mapError((cause) => new DesktopServiceConnectionError({ operation, cause })),
  );
});

export const prepareLocalBackend = Effect.fn("DesktopServiceConnection.prepareLocalBackend")(
  function* () {
    const settingsService = yield* DesktopAppSettings.DesktopAppSettings;
    const settings = yield* settingsService.get;
    if (!settings.localEnvironmentEnabled || (settings.wslOnly && settings.wslBackendEnabled))
      return "own" as const;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    // Spawning the bundled CLI costs about a second, so skip it when nothing can be attached.
    const defaultUnitPath = defaultBootServiceUnitPath({
      path: environment.path,
      platform: environment.platform,
      homeDir: environment.homeDirectory,
      environment: yield* HostProcess.Environment,
    });
    const unitMayExist =
      defaultUnitPath === undefined ||
      (yield* fileSystem.exists(defaultUnitPath).pipe(Effect.orElseSucceed(() => true)));
    if (!unitMayExist && !(yield* DesktopHomeOwner.isHomeOwnershipLocked())) return "own" as const;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const state = yield* DesktopState.DesktopState;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const context = yield* Effect.context<
      DesktopEnvironment.DesktopEnvironment | ChildProcessSpawner.ChildProcessSpawner
    >();
    const cli = (
      operation: DesktopServiceConnectionError["operation"],
      args: ReadonlyArray<string>,
    ) => runBundledCli(operation, args).pipe(Effect.provide(context));
    const homeContext = yield* Effect.context<
      DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | Path.Path
    >();
    const readOwner = DesktopHomeOwner.readLockedHomeOwner().pipe(Effect.provide(homeContext));
    const status = yield* cli("status", ["service", "status", "--json"]).pipe(
      Effect.flatMap(decodeServiceStatus),
      Effect.mapError((cause) => new DesktopServiceConnectionError({ operation: "status", cause })),
    );
    let owner = yield* readOwner;
    let locked = yield* DesktopHomeOwner.isHomeOwnershipLocked();
    if (locked && Option.isNone(owner) && (yield* DesktopHomeOwner.awaitHomeOwnershipRelease()))
      locked = false;
    owner = yield* readOwner;
    let action = launchDecision({
      enabled: settings.localEnvironmentEnabled,
      wslOnly: settings.wslOnly && settings.wslBackendEnabled,
      ...status,
      remembered: settings.serviceConnectionRemembered,
      quitBehavior: settings.serviceQuitBehavior,
      owner: Option.isSome(owner)
        ? owner.value.serviceManaged
          ? "service"
          : "other"
        : locked
          ? "unknown"
          : "none",
    });
    if (action === "own") return "own" as const;
    if (action === "unavailable") {
      yield* dialog.showErrorBox(
        "This T3 home is unavailable",
        DesktopHomeOwner.homeOwnedMessage(owner),
      );
      return "quit" as const;
    }
    if (action === "ask-start") {
      const result = yield* dialog.showMessageBox({
        type: "question",
        title: "T3 Code background service",
        message:
          "A T3 Code background service is installed for this data folder but is stopped or unavailable.",
        buttons: ["Start service and connect", "Use the app's own server this time", "Quit"],
        defaultId: 0,
        cancelId: 2,
      });
      if (result.response === 1) return "own" as const;
      if (result.response !== 0) return "quit" as const;
      action = "start-attach";
    }
    if (action === "start-attach") {
      yield* desktopWindow.showConnectingSplash;
      yield* cli("start", ["service", "start"]);
      owner = yield* readOwner.pipe(
        Effect.repeat({
          until: (current) => Option.isSome(current) && current.value.serviceManaged === true,
          schedule: Schedule.spaced(Duration.millis(250)),
        }),
        Effect.timeout(Duration.minutes(2)),
        Effect.mapError(
          (cause) => new DesktopServiceConnectionError({ operation: "start", cause }),
        ),
      );
    }
    if (Option.isNone(owner))
      return yield* new DesktopServiceConnectionError({
        operation: "connect",
        cause: "Missing live owner",
      });
    const initialOwner = owner.value;
    if (action === "ask-connect") {
      const result = yield* dialog.showMessageBox({
        type: "question",
        title: "Connect to the local server",
        message: initialOwner.serviceManaged
          ? `A T3 Code background service (v${initialOwner.serverVersion ?? status.installedVersion ?? "unknown"}, port ${initialOwner.port}) is running for this data folder. Connect to it?`
          : DesktopHomeOwner.homeOwnedMessage(owner),
        buttons: ["Connect", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response !== 0) return "quit" as const;
      if (initialOwner.serviceManaged) yield* settingsService.rememberServiceConnection;
    }
    if (action === "start-attach" && initialOwner.serviceManaged)
      yield* settingsService.rememberServiceConnection;
    const httpClient = yield* HttpClient.HttpClient;
    // Each mint spawns the CLI and adds a session, so reuse the bearer until the server changes.
    const bearer = yield* Ref.make(
      Option.none<{ readonly owner: string; readonly token: string }>(),
    );
    const getBearerToken = Effect.fn("DesktopServiceConnection.getBearerToken")(
      function* () {
        const current = yield* readOwner;
        if (Option.isNone(current))
          return yield* new DesktopServiceConnectionError({
            operation: "pair",
            cause: "Server unavailable",
          });
        const ownerKey = `${current.value.pid}:${DesktopHomeOwner.ownerOrigin(current.value)}`;
        const cached = yield* Ref.get(bearer);
        if (Option.isSome(cached) && cached.value.owner === ownerKey) return cached.value.token;
        const result = yield* cli("pair", ["pair", "--json", "--label", "T3 Code Desktop"]).pipe(
          Effect.flatMap(decodePairResult),
        );
        if (
          new URL(result.httpBaseUrl).origin !==
          new URL(DesktopHomeOwner.ownerOrigin(current.value)).origin
        ) {
          return yield* new DesktopServiceConnectionError({
            operation: "pair",
            cause: "Server changed during pairing",
          });
        }
        const session = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: result.httpBaseUrl,
          credential: result.credential,
          clientMetadata: { label: "T3 Code Desktop", deviceType: "desktop" },
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        yield* Ref.set(bearer, Option.some({ owner: ownerKey, token: session.access_token }));
        return session.access_token;
      },
      Effect.retry({ times: 1, while: (error) => error._tag === "EnvironmentAuthInvalidError" }),
      Effect.mapError((cause) => new DesktopServiceConnectionError({ operation: "pair", cause })),
    );
    const confirmQuit = Effect.fn("DesktopServiceConnection.confirmQuit")(
      function* (isUserQuit: () => boolean) {
        const behavior = (yield* settingsService.get).serviceQuitBehavior;
        let decision = quitDecision(initialOwner.serviceManaged === true, behavior, "user");
        if (decision === "ask") {
          const result = yield* dialog.showMessageBox({
            type: "question",
            title: "Quit T3 Code",
            message: "Quit the app only, or also stop the background service?",
            buttons: ["Quit app only", "Quit app and stop service", "Cancel"],
            defaultId: 0,
            cancelId: 2,
            checkboxLabel: "Remember my decision",
            checkboxChecked: false,
          });
          if (!isUserQuit() || result.response === 2) return false;
          decision = result.response === 1 ? "stop-quit" : "quit";
          if (result.checkboxChecked)
            yield* settingsService.setServiceQuitBehavior(
              result.response === 1 ? "app-and-service" : "app-only",
            );
        }
        if (!isUserQuit()) return false;
        if (decision === "stop-quit") {
          yield* desktopWindow.activate.pipe(Effect.ignore);
          yield* Ref.set(state.quitting, true);
          const window = yield* electronWindow.currentMainOrFirst;
          yield* Effect.sync(() => {
            if (Option.isSome(window) && !window.value.isDestroyed()) {
              window.value.setTitle("Stopping T3 Code background service…");
              window.value.setProgressBar(2);
            }
          });
          yield* Effect.gen(function* () {
            const latest = yield* cli("status", ["service", "status", "--json"]).pipe(
              Effect.flatMap(decodeServiceStatus),
            );
            if (!latest.installed || latest.otherBaseDir !== undefined)
              return yield* new DesktopServiceConnectionError({
                operation: "stop",
                cause: "The installed service no longer serves this data folder",
              });
            yield* cli("stop", ["service", "stop"]);
          }).pipe(
            Effect.catch(() =>
              dialog.showErrorBox(
                "Couldn't stop the background service",
                "The app will quit. The background service may still be running. You can stop it from a terminal with t3 service stop.",
              ),
            ),
          );
        }
        return true;
      },
      Effect.catch(() =>
        Ref.set(state.quitting, false).pipe(
          Effect.andThen(
            dialog.showErrorBox(
              "Couldn't complete quit",
              "The app is still open. Try quitting again.",
            ),
          ),
          Effect.as(false),
        ),
      ),
    );
    yield* Ref.set(
      state.localBackendAttachment,
      Option.some({
        owner: initialOwner,
        readOwner: readOwner.pipe(
          Effect.map(
            Option.filter((current) => !!current.serviceManaged === !!initialOwner.serviceManaged),
          ),
        ),
        getBearerToken: getBearerToken(),
        confirmQuit,
      }),
    );
    return "attach" as const;
  },
);

export const prepareOrQuit = prepareLocalBackend().pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      const dialog = yield* ElectronDialog.ElectronDialog;
      yield* dialog.showErrorBox(
        "Couldn't connect to the local server",
        `${error.message}\nThe app has not started its own server. Check the background service and reopen the app.`,
      );
      return "quit" as const;
    }),
  ),
);
