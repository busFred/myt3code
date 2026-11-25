import { assert, it } from "@effect/vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopServiceCatchUp from "./DesktopServiceCatchUp.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const idle: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.2.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const service = (serverVersion: string) =>
  Option.some({ serverVersion, serverBuild: "bbbbbbbbbbbb" });

it.effect("follows a newer service once the busy updater is idle, once per build", () =>
  Effect.gen(function* () {
    const updateState = yield* SubscriptionRef.make<DesktopUpdateState>({
      ...idle,
      status: "downloading",
    });
    const attachedService = yield* SubscriptionRef.make(
      Option.none<DesktopState.AttachedServiceBuild>(),
    );
    const waiting = yield* Deferred.make<void>();
    // What each feed check offers, in order: the service's version, then one past the next.
    const offers = yield* Ref.make(["0.3.0", "0.4.1", "0.5.0"]);
    const checked = yield* Queue.unbounded<string>();
    const downloads = yield* Queue.unbounded<string>();
    const updates = {
      getState: SubscriptionRef.get(updateState),
      isActionActive: Effect.succeed(false),
      subscribe: Deferred.succeed(waiting, undefined).pipe(
        Effect.as({ latest: idle, changes: SubscriptionRef.changes(updateState) }),
      ),
      check: () =>
        Ref.modify(offers, ([next, ...rest]) => [next!, rest]).pipe(
          Effect.tap((version) => Queue.offer(checked, version)),
          Effect.map((version) => ({
            checked: true,
            state: { ...idle, status: "available" as const, availableVersion: version },
          })),
        ),
      downloadVersion: (version: string) =>
        Queue.offer(downloads, version).pipe(
          Effect.as({ accepted: true, completed: true, state: idle }),
        ),
    } as unknown as DesktopUpdates.DesktopUpdates["Service"];

    yield* DesktopServiceCatchUp.listen.pipe(
      Effect.provideService(DesktopUpdates.DesktopUpdates, updates),
      Effect.provideService(DesktopState.DesktopState, {
        quitting: yield* Ref.make(false),
        attachedService,
      } as DesktopState.DesktopState["Service"]),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        appVersion: "0.2.0",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provideService(DesktopAppIdentity.DesktopAppIdentity, {
        commitHash: Effect.succeedSome("aaaaaaaaaaaa"),
      } as DesktopAppIdentity.DesktopAppIdentity["Service"]),
      Effect.provideService(
        ElectronDialog.ElectronDialog,
        {} as ElectronDialog.ElectronDialog["Service"],
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected release lookup")),
      ),
    );

    // The app's own download is running, so the catch-up waits for it instead of dropping out.
    yield* SubscriptionRef.set(attachedService, service("0.3.0"));
    yield* Deferred.await(waiting);
    assert.isTrue(Option.isNone(yield* Queue.poll(checked)));
    yield* SubscriptionRef.set(updateState, idle);
    assert.equal(yield* Queue.take(checked), "0.3.0");
    assert.equal(yield* Queue.take(downloads), "0.3.0");

    // The same build again is done; a feed that moved past the next service is not followed.
    yield* SubscriptionRef.set(attachedService, service("0.3.0"));
    yield* SubscriptionRef.set(attachedService, service("0.4.0"));
    assert.equal(yield* Queue.take(checked), "0.4.1");
    yield* SubscriptionRef.set(attachedService, service("0.5.0"));
    assert.equal(yield* Queue.take(checked), "0.5.0");
    assert.equal(yield* Queue.take(downloads), "0.5.0");
    assert.isTrue(Option.isNone(yield* Queue.poll(downloads)));
  }),
);
