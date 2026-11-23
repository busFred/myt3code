/**
 * DesktopUpstreamRelease - tells the user when upstream T3 Code has a stable release newer than
 * this fork's build. It only reads the release's version; nothing from upstream is ever
 * downloaded or installed.
 *
 * @module DesktopUpstreamRelease
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { msg } from "gt-i18n";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { m } from "../i18n/messages.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import {
  isUpstreamNewer,
  parseUpstreamRelease,
  shouldNotifyUpstream,
  UPSTREAM_LATEST_RELEASE_API_URL,
  type UpstreamRelease,
} from "./upstreamRelease.ts";

const { logInfo } = makeComponentLogger("desktop-upstream-release");

const STARTUP_DELAY = Duration.seconds(30);
const CHECK_INTERVAL = Duration.hours(24);
// Opening Settings checks again, but not so often that GitHub's anonymous rate limit is at risk.
const OPEN_CHECK_MIN_AGE = Duration.minutes(10);
const REQUEST_TIMEOUT = Duration.seconds(8);

export class DesktopUpstreamRelease extends Context.Service<
  DesktopUpstreamRelease,
  {
    /** Checks once at startup and then daily; failures are silent. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** The newer upstream release, if any. Checks again when the last check is not recent. */
    readonly newerRelease: Effect.Effect<Option.Option<UpstreamRelease>>;
  }
>()("@t3tools/desktop/updates/DesktopUpstreamRelease") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const shell = yield* ElectronShell.ElectronShell;
  const httpClient = yield* HttpClient.HttpClient;
  const lastCheck = yield* Ref.make<{
    readonly at: number;
    readonly release: Option.Option<UpstreamRelease>;
  } | null>(null);

  const fetchLatest = httpClient
    .get(UPSTREAM_LATEST_RELEASE_API_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "t3code-desktop" },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => Option.fromNullishOr(parseUpstreamRelease(body))),
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.orElseSucceed(() => Option.none<UpstreamRelease>()),
    );

  const notifyOnce = Effect.fn("desktop.upstreamRelease.notifyOnce")(function* (
    release: UpstreamRelease,
  ) {
    const current = yield* settings.get;
    if (
      !shouldNotifyUpstream(release, environment.appVersion, current.lastNotifiedUpstreamVersion)
    ) {
      return;
    }
    // Recorded first so a failed notification is not repeated on every check.
    yield* settings.setLastNotifiedUpstreamVersion(release.version);
    yield* shell.showNotification({
      title: m(msg("Upstream T3 Code v{version} is out"), { version: release.version }),
      body: m(msg("Update your fork to get it.")),
    });
  });

  const check = Effect.fn("desktop.upstreamRelease.check")(function* (minAge: Duration.Duration) {
    // The same switch as app updates: a disabled or managed updater means no update traffic.
    if (Option.isSome(yield* updates.disabledReason)) return Option.none<UpstreamRelease>();
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(lastCheck);
    const release =
      previous !== null && now - previous.at < Duration.toMillis(minAge)
        ? previous.release
        : yield* fetchLatest.pipe(
            Effect.tap((fetched) => Ref.set(lastCheck, { at: now, release: fetched })),
          );
    const newer = Option.filter(release, (found) =>
      isUpstreamNewer(found.version, environment.appVersion),
    );
    if (Option.isSome(newer)) {
      yield* logInfo("upstream release is newer than this build", { version: newer.value.version });
      yield* notifyOnce(newer.value).pipe(Effect.ignore);
    }
    return newer;
  });

  return DesktopUpstreamRelease.of({
    start: Effect.sleep(STARTUP_DELAY).pipe(
      Effect.andThen(
        check(Duration.zero).pipe(Effect.andThen(Effect.sleep(CHECK_INTERVAL)), Effect.forever),
      ),
      Effect.ignoreCause,
      Effect.forkScoped,
      Effect.asVoid,
    ),
    newerRelease: check(OPEN_CHECK_MIN_AGE),
  });
});

export const layer = Layer.effect(DesktopUpstreamRelease, make);
