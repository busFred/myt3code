import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { defaultBootServiceUnitPath } from "@t3tools/shared/bootServiceUnitPath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
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
import {
  launchDecision,
  quitDecision,
  serviceUpdateDecision,
  serviceUpdateResponse,
  type ServiceUpdateTrigger,
} from "./DesktopServiceDecision.ts";

export class DesktopServiceConnectionError extends Schema.TaggedError<DesktopServiceConnectionError>()(
  "DesktopServiceConnectionError",
  {
    operation: Schema.Literals([
      "status",
      "start",
      "stop",
      "pair",
      "connect",
      "update",
      "configure",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const detail =
      this.operation === "update" || this.operation === "configure"
        ? ` ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
        : "";
    return `Could not ${this.operation} the local T3 Code server.${detail}`;
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

const isServiceConnectionError = Schema.is(DesktopServiceConnectionError);
export const decodeServiceStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceStatus));
const decodePairResult = Schema.decodeUnknownEffect(Schema.fromJsonString(PairResult));

export const runBundledCli = Effect.fn("DesktopServiceConnection.runBundledCli")(function* (
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
      const [stdout, stderr, code] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* new DesktopServiceConnectionError({
          operation,
          cause: `${(stderr.trim() || stdout.trim()).slice(-4000)} (exit ${code})`,
        });
      return stdout;
    }),
  ).pipe(
    Effect.timeout(operation === "update" ? Duration.minutes(10) : Duration.seconds(130)),
    Effect.mapError((cause) =>
      isServiceConnectionError(cause)
        ? cause
        : new DesktopServiceConnectionError({ operation, cause }),
    ),
  );
});

const updateBackgroundService = Effect.fn("DesktopServiceConnection.updateBackgroundService")(
  function* (version: string, readOwner: Attachment["readOwner"]) {
    yield* runBundledCli("update", ["update", version, "--yes"]);
    return yield* readOwner.pipe(
      Effect.repeat({
        until: (owner) =>
          Option.isSome(owner) &&
          owner.value.serviceManaged === true &&
          owner.value.serverVersion === version,
        schedule: Schedule.spaced(Duration.millis(250)),
      }),
      Effect.timeout(Duration.minutes(2)),
      Effect.mapError(
        () =>
          new DesktopServiceConnectionError({
            operation: "update",
            cause: `Timed out waiting for the background service to run v${version}.`,
          }),
      ),
    );
  },
);

export const coordinateServiceUpdate = Effect.fn(
  "DesktopServiceConnection.coordinateServiceUpdate",
)(function* (input: {
  readonly trigger: ServiceUpdateTrigger;
  readonly version: string;
  readonly owner: DesktopHomeOwner.HomeOwner;
  readonly readOwner: Attachment["readOwner"];
  readonly showSplash?: Effect.Effect<void>;
}) {
  const owner = Option.getOrElse(yield* input.readOwner, () => input.owner);
  if (
    serviceUpdateDecision({
      trigger: input.trigger,
      serviceManaged: owner.serviceManaged === true,
      serviceVersion: owner.serverVersion,
      targetVersion: input.version,
    }) === "skip"
  )
    return "continue" as const;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const continueLabel =
    input.trigger === "install"
      ? "Update app only"
      : input.trigger === "required"
        ? "Quit"
        : `Continue with v${owner.serverVersion}`;
  const confirmation = yield* dialog.showMessageBox({
    type: "warning",
    title: "Update background service",
    message:
      input.trigger === "install"
        ? "Updating restarts the background service. Running agent turns, terminals and remote connections on it will be interrupted."
        : input.trigger === "required"
          ? `This app (v${input.version}) can't sign in to the background service v${owner.serverVersion}. Update the service to connect. This restarts the service.`
          : `The background service runs v${owner.serverVersion}, older than this app (v${input.version}). Update it now? This restarts the service.`,
    buttons:
      input.trigger === "install"
        ? ["Update and restart", "Cancel"]
        : ["Update service", continueLabel],
    defaultId: 0,
    cancelId: 1,
  });
  const decision = serviceUpdateResponse(input.trigger, "confirm", confirmation.response);
  if (decision !== "update") return decision;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* input.showSplash ?? Effect.void;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const window = yield* electronWindow.currentMainOrFirst;
      if (Option.isSome(window) && !window.value.isDestroyed()) {
        const target = window.value;
        const title = target.getTitle();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (target.isDestroyed()) return;
            target.setTitle(title);
            target.setProgressBar(-1);
          }),
        );
        yield* Effect.sync(() => {
          target.setTitle("Updating background service…");
          target.setProgressBar(2);
          target.show();
        });
      }
      while (true) {
        const result = yield* updateBackgroundService(input.version, input.readOwner).pipe(
          Effect.result,
        );
        if (Result.isSuccess(result)) return "continue" as const;
        const failure = yield* dialog.showMessageBox({
          type: "error",
          title: "Couldn't update the background service",
          message: "The background service update did not complete.",
          detail: result.failure.message,
          buttons:
            input.trigger === "install"
              ? ["Retry", continueLabel, "Cancel"]
              : ["Retry", continueLabel],
          defaultId: 0,
          cancelId: input.trigger === "install" ? 2 : 1,
        });
        const next = serviceUpdateResponse(input.trigger, "failure", failure.response);
        if (next !== "update") return next;
      }
    }),
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
      yield* desktopWindow.showConnectingServiceSplash;
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
    const connectedOwner = owner.value;
    if (action === "ask-connect") {
      const result = yield* dialog.showMessageBox({
        type: "question",
        title: "Connect to the local server",
        message: connectedOwner.serviceManaged
          ? `A T3 Code background service (v${connectedOwner.serverVersion ?? status.installedVersion ?? "unknown"}, port ${connectedOwner.port}) is running for this data folder. Connect to it?`
          : `Another T3 Code server, such as \`t3 serve\` or one started over SSH (${connectedOwner.serverVersion === undefined ? "" : `v${connectedOwner.serverVersion}, `}port ${connectedOwner.port}), is using this data folder. Connect to it? Quitting the app leaves that server running.`,
        buttons: ["Connect", "Quit"],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response !== 0) return "quit" as const;
      if (connectedOwner.serviceManaged) yield* settingsService.rememberServiceConnection;
    }
    if (action === "start-attach" && connectedOwner.serviceManaged)
      yield* settingsService.rememberServiceConnection;
    yield* coordinateServiceUpdate({
      trigger: "attach",
      version: environment.appVersion,
      owner: connectedOwner,
      readOwner,
      showSplash: desktopWindow.showUpdatingServiceSplash,
    });
    let initialOwner = Option.getOrElse(yield* readOwner, () => connectedOwner);
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
    // A newer app's CLI may need a database upgrade the older service refuses, so sign-in can fail.
    if (
      serviceUpdateDecision({
        trigger: "attach",
        serviceManaged: initialOwner.serviceManaged === true,
        serviceVersion: initialOwner.serverVersion,
        targetVersion: environment.appVersion,
      }) === "ask" &&
      Result.isFailure(yield* getBearerToken().pipe(Effect.result))
    ) {
      const outcome = yield* coordinateServiceUpdate({
        trigger: "required",
        version: environment.appVersion,
        owner: initialOwner,
        readOwner,
        showSplash: desktopWindow.showUpdatingServiceSplash,
      });
      if (outcome !== "continue") return "quit" as const;
      const updatedOwner = initialOwner;
      initialOwner = Option.getOrElse(yield* readOwner, () => updatedOwner);
    }
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
