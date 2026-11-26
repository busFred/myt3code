import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopHomeOwner from "./DesktopHomeOwner.ts";

const ServiceDescriptor = Schema.fromJsonString(
  Schema.Struct({ serverVersion: Schema.String, serverBuild: Schema.optional(Schema.String) }),
);
const decodeServiceDescriptor = Schema.decodeUnknownOption(ServiceDescriptor);

// The owner read opens SQLite on the main thread, so a healthy ready tick skips it for this long.
const OWNER_RECHECK_INTERVAL_MILLIS = Duration.toMillis(Duration.seconds(30));

export const make = Effect.fn("DesktopAttachedBackend.make")(function* (input: {
  readonly onReady: (origin: URL, reconnecting: boolean) => Effect.Effect<void>;
  readonly onShutdown: Effect.Effect<void>;
}) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const { localBackendAttachment, attachedService } = yield* DesktopState.DesktopState;
  const httpClient = yield* HttpClient.HttpClient;
  const monitor = yield* FiberHandle.make<void>();
  const ready = yield* SubscriptionRef.make(false);
  const desired = yield* Ref.make(false);
  const config = yield* Ref.make(Option.none<DesktopBackendManager.DesktopBackendStartConfig>());
  let lastOwner: string | undefined;
  let lastOrigin: URL | undefined;
  let lastOwnerReadAt = 0;
  let wasReady = false;
  const fetchDescriptor = (origin: URL) =>
    httpClient.get(new URL("/.well-known/t3/environment", origin)).pipe(
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((text) => (response.status === 200 ? text : undefined))),
      ),
      Effect.timeout(Duration.seconds(2)),
      Effect.orElseSucceed(() => undefined),
    );
  // Health checks run continuously; per-tick spans flood desktop traces.
  const check = Effect.fnUntraced(function* () {
    const attachment = yield* Ref.get(localBackendAttachment);
    if (Option.isNone(attachment)) return;
    const now = yield* Clock.currentTimeMillis;
    // A server still answering at its known origin keeps its identity until the next owner read.
    if (
      lastOrigin !== undefined &&
      now - lastOwnerReadAt < OWNER_RECHECK_INTERVAL_MILLIS &&
      (yield* SubscriptionRef.get(ready)) &&
      (yield* fetchDescriptor(lastOrigin)) !== undefined
    ) {
      return;
    }
    lastOwnerReadAt = now;
    const owner = yield* attachment.value.readOwner;
    const origin = Option.map(owner, (current) => new URL(DesktopHomeOwner.ownerOrigin(current)));
    const descriptor = Option.isNone(origin) ? undefined : yield* fetchDescriptor(origin.value);
    const healthy = descriptor !== undefined;
    if (!healthy || Option.isNone(owner) || Option.isNone(origin)) {
      if (yield* SubscriptionRef.get(ready)) {
        yield* SubscriptionRef.set(ready, false);
        yield* input.onShutdown;
      }
      return;
    }
    const identity = `${owner.value.pid}:${origin.value.href}`;
    if ((yield* SubscriptionRef.get(ready)) && identity === lastOwner) return;
    yield* Ref.set(
      config,
      Option.some({
        executablePath: "",
        entryPath: "",
        args: [],
        cwd: environment.backendCwd,
        env: {},
        extendEnv: false,
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          host: origin.value.hostname,
          desktopBootstrapToken: "",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          port: owner.value.port,
          t3Home: environment.baseDir,
        },
        bootstrapDelivery: "fd3",
        httpBaseUrl: origin.value,
        captureOutput: false,
        preflightFailure: Option.none(),
      }),
    );
    lastOwner = identity;
    lastOrigin = origin.value;
    yield* SubscriptionRef.set(
      attachedService,
      Option.map(decodeServiceDescriptor(descriptor), (service) => ({
        serverVersion: service.serverVersion,
        serverBuild: service.serverBuild,
      })),
    );
    yield* SubscriptionRef.set(ready, true);
    yield* input.onReady(origin.value, wasReady);
    wasReady = true;
  });
  const stop = Effect.fn("DesktopAttachedBackend.stop")(function* () {
    yield* Ref.set(desired, false);
    yield* FiberHandle.clear(monitor);
    if (yield* SubscriptionRef.get(ready)) {
      yield* SubscriptionRef.set(ready, false);
      yield* input.onShutdown;
    }
  });
  yield* Effect.addFinalizer(() => stop());
  return {
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Local"),
    start: Effect.gen(function* () {
      if (yield* Ref.getAndSet(desired, true)) return;
      // Publish the endpoint before the renderer's synchronous bootstrap IPC runs.
      yield* check();
      yield* FiberHandle.run(
        monitor,
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.seconds((yield* SubscriptionRef.get(ready)) ? 5 : 1));
            yield* check();
          }
        }),
        { onlyIfMissing: true },
      );
    }),
    stop,
    currentConfig: Ref.get(config),
    snapshot: Effect.gen(function* () {
      return {
        desiredRunning: yield* Ref.get(desired),
        ready: yield* SubscriptionRef.get(ready),
        activePid: Option.none<number>(),
        restartAttempt: 0,
        restartScheduled: false,
      };
    }),
    waitForReady: (timeout: Duration.Duration) =>
      SubscriptionRef.changes(ready).pipe(
        Stream.filter(Boolean),
        Stream.runHead,
        Effect.timeoutOption(timeout),
        Effect.map((result) => Option.isSome(result) && Option.isSome(result.value)),
      ),
  } satisfies DesktopBackendManager.DesktopBackendInstance;
});
