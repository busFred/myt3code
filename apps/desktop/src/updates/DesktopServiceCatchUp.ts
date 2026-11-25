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
import type { DesktopUpdateState } from "@t3tools/contracts";

import * as DesktopAppIdentity from "../app/DesktopAppIdentity.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { appCatchUpDecision, catchUpTargetMatches } from "../backend/DesktopServiceDecision.ts";
import type * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { reinstallWithConfirmation } from "./reinstallWithConfirmation.ts";

const { logInfo } = makeComponentLogger("desktop-service-catch-up");

/**
 * Keeps the app on the background service's build when the service moved ahead, as `t3 update`
 * run from a terminal does. A service build is done once an attempt ran or there is nothing to
 * do, so each one is tried at most once a launch; offline, nothing happens.
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

  const scope = yield* Effect.scope;
  const busy = (current: DesktopUpdateState) =>
    current.status === "checking" || current.status === "downloading";
  const untilIdle = Effect.scoped(
    Effect.suspend(() => updates.subscribe).pipe(
      Effect.flatMap(({ changes }) =>
        changes.pipe(
          Stream.filter((current) => !busy(current)),
          Stream.runHead,
        ),
      ),
    ),
  );

  const catchUp = Effect.fn("desktop.serviceCatchUp.run")(function* (
    service: DesktopState.AttachedServiceBuild,
  ) {
    const key = `${service.serverVersion}:${service.serverBuild ?? ""}`;
    if ((yield* Ref.get(seen)).has(key) || (yield* Ref.get(state.quitting))) return;
    const markSeen = Ref.update(seen, (keys) => new Set([...keys, key]));
    const decision = appCatchUpDecision({
      appVersion: environment.appVersion,
      appBuild: Option.getOrUndefined(yield* identity.commitHash),
      serviceVersion: service.serverVersion,
      serviceBuild: service.serverBuild,
    });
    if (decision === "none") return yield* markSeen;
    const current = yield* updates.getState;
    // Not seen yet: the caller tries once more when the updater is idle.
    if ((yield* updates.isActionActive) || busy(current)) return "busy" as const;
    yield* markSeen;
    // A downloaded update installs on restart, and that install moves the service with it.
    if (current.status === "downloaded") return;
    if (decision === "update") {
      const offered =
        current.status === "available" && current.availableVersion === service.serverVersion
          ? current
          : (yield* updates.check("service-newer")).state;
      if (
        !catchUpTargetMatches({
          decision,
          serviceVersion: service.serverVersion,
          serviceBuild: service.serverBuild,
          offeredVersion: offered.availableVersion,
        })
      )
        return;
      yield* logInfo("downloading the background service's version", {
        version: service.serverVersion,
      });
      yield* updates.downloadVersion(service.serverVersion);
      return;
    }
    // Another offer is on screen; Reinstall would refuse while it is.
    if (current.status === "available") return;
    const stillPublished = publishedBuild(service.serverVersion).pipe(
      Effect.map((published) =>
        catchUpTargetMatches({
          decision,
          serviceVersion: service.serverVersion,
          serviceBuild: service.serverBuild,
          offeredVersion: environment.appVersion,
          publishedBuild: published,
        }),
      ),
    );
    if (!(yield* stillPublished)) return;
    yield* logInfo("offering to reinstall the background service's build", {
      version: service.serverVersion,
    });
    // Checked again after the user confirms, in case the release was republished meanwhile.
    yield* reinstallWithConfirmation({ stillWanted: stillPublished });
  });

  yield* SubscriptionRef.changes(state.attachedService).pipe(
    Stream.runForEach((service) =>
      Option.isNone(service)
        ? Effect.void
        : catchUp(service.value).pipe(
            // After that, the next service publish tries again.
            Effect.flatMap((outcome) =>
              outcome === "busy"
                ? untilIdle.pipe(
                    Effect.andThen(catchUp(service.value)),
                    Effect.ignoreCause({ log: true }),
                    Effect.forkIn(scope),
                  )
                : Effect.void,
            ),
            Effect.ignoreCause({ log: true }),
          ),
    ),
    Effect.forkScoped,
  );
});
