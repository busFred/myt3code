import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_BUILD_FILE,
  cliReleaseAssetUrl,
  parseReleaseBuild,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { appCatchUpDecision, sameBuild } from "../backend/DesktopServiceDecision.ts";
import type * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { reinstallWithConfirmation } from "./reinstallWithConfirmation.ts";

const { logInfo } = makeComponentLogger("desktop-service-catch-up");

/**
 * Keeps the app on the background service's build when the service moved ahead, as `t3 update`
 * run from a terminal does. Once per service build each launch, and quiet when offline.
 */
export const listen: Effect.Effect<
  void,
  never,
  | DesktopUpdates.DesktopUpdates
  | DesktopState.DesktopState
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAppIdentity.DesktopAppIdentity
  | ElectronDialog.ElectronDialog
  | HttpClient.HttpClient
  | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const state = yield* DesktopState.DesktopState;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = (yield* HostProcess.Environment)[CLI_RELEASE_BASE_URL_ENV];
  const seen = yield* Ref.make(new Set<string>());

  const publishedBuild = (version: string) =>
    httpClient.get(cliReleaseAssetUrl(version, CLI_RELEASE_BUILD_FILE, releaseBaseUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.map(parseReleaseBuild),
      Effect.timeout(Duration.seconds(15)),
      Effect.orElseSucceed(() => undefined),
    );

  const catchUp = Effect.fn("desktop.serviceCatchUp.run")(function* (
    service: DesktopState.AttachedServiceBuild,
  ) {
    const key = `${service.serverVersion}:${service.serverBuild ?? ""}`;
    const first = yield* Ref.modify(seen, (keys) =>
      keys.has(key) ? [false, keys] : [true, new Set([...keys, key])],
    );
    if (!first || (yield* Ref.get(state.quitting))) return;
    const decision = appCatchUpDecision({
      appVersion: environment.appVersion,
      appBuild: Option.getOrUndefined(yield* identity.commitHash),
      serviceVersion: service.serverVersion,
      serviceBuild: service.serverBuild,
    });
    if (decision === "none" || (yield* updates.isActionActive)) return;
    const current = yield* updates.getState;
    // The app's own update or Reinstall moves the service first; that run finishes the job.
    if (current.status === "downloading" || current.status === "downloaded") return;
    if (decision === "update") {
      const offered =
        current.status === "available" && current.availableVersion === service.serverVersion
          ? current
          : (yield* updates.check("service-newer")).state;
      if (offered.status !== "available" || offered.availableVersion !== service.serverVersion)
        return;
      yield* logInfo("downloading the background service's version", {
        version: service.serverVersion,
      });
      yield* updates.download;
      return;
    }
    if (current.status === "available" || service.serverBuild === undefined) return;
    const published = yield* publishedBuild(service.serverVersion);
    if (published === undefined || !sameBuild(published, service.serverBuild)) return;
    yield* logInfo("offering to reinstall the background service's build", {
      version: service.serverVersion,
      build: published,
    });
    yield* reinstallWithConfirmation;
  });

  yield* SubscriptionRef.changes(state.attachedService).pipe(
    Stream.runForEach((service) =>
      Option.isNone(service)
        ? Effect.void
        : catchUp(service.value).pipe(Effect.ignoreCause({ log: true })),
    ),
    Effect.forkScoped,
  );
});
