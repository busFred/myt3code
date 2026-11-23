import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthEnvironmentBootstrapTokenType,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthSessionLifetime,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  isNeverExpiring,
  MAX_APP_INVITE_TTL_MILLIS,
  mcpClientScopes,
} from "@t3tools/contracts";
import {
  isLocalLoopbackHost,
  isTailnetHost,
  isWildcardHost,
} from "@t3tools/shared/hostClassification";
import { encodeOAuthScope, parseOAuthScope } from "@t3tools/shared/oauthScope";
import { buildTailscaleHttpsBaseUrl, readTailscaleStatus } from "@t3tools/tailscale";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import * as RunningServer from "./runningServer.ts";

export class EnvironmentBothWaysError extends Schema.TaggedError<EnvironmentBothWaysError>()(
  "EnvironmentBothWaysError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const isEnvironmentBothWaysError = Schema.is(EnvironmentBothWaysError);

export class EnvironmentBothWaysIncompleteError extends Schema.TaggedError<EnvironmentBothWaysIncompleteError>()(
  "EnvironmentBothWaysIncompleteError",
  { failed: Schema.Number },
) {
  override get message(): string {
    return `${this.failed} step${this.failed === 1 ? "" : "s"} did not finish. Run the command again with a new pairing code to retry them; finished steps are left as they are.`;
  }
}

/** The session the CLI holds on the other environment only lasts while it works there. */
const REMOTE_SESSION_LIFETIME: AuthSessionLifetime = {
  _tag: "duration",
  millis: Duration.toMillis(Duration.minutes(10)),
};

const isMissingEndpoint = (error: unknown) =>
  HttpClientError.isHttpClientError(error) && error.response?.status === 404;

const olderPeer = (label: string) =>
  new EnvironmentBothWaysError({
    detail: `${label} runs an older T3 Code that cannot link both ways. Update it, then run this again.`,
  });

/**
 * Where the other environment can reach this one: over Tailscale, its Serve HTTPS name and,
 * when the server listens beyond loopback, its tailnet addresses. The other side keeps only
 * those that answer as this environment.
 */
const detectSelfUrls = Effect.fn("environment.detectSelfUrls")(function* () {
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  const running = yield* readLiveServerRuntimeState(serverRuntimeStatePath);
  if (Option.isNone(running)) {
    return yield* new EnvironmentBothWaysError({
      detail:
        "This environment's server is not running, so the other one cannot reach it. Start it (`t3 up`), then run this again.",
    });
  }
  const status = yield* readTailscaleStatus.pipe(Effect.option);
  if (Option.isNone(status)) return [];
  const listensBeyondLoopback =
    isWildcardHost(running.value.host) ||
    (running.value.host !== undefined && !isLocalLoopbackHost(running.value.host));
  return [
    ...(status.value.magicDnsName === null
      ? []
      : [buildTailscaleHttpsBaseUrl({ magicDnsName: status.value.magicDnsName })]),
    ...(listensBeyondLoopback
      ? status.value.tailnetIpv4Addresses.map((ip) => `http://${ip}:${running.value.port}`)
      : []),
  ];
});

/** The other environment's origin, refused when the pairing code would cross the network in the clear. */
const remoteOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new EnvironmentBothWaysError({ detail: "That address is not an http or https address." }),
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  ) {
    return Effect.fail(
      new EnvironmentBothWaysError({
        detail: `${parsed.origin} is plain http, which would send the pairing code unencrypted. Use its https or Tailscale address.`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

interface StepOutcome {
  readonly ok: boolean;
  readonly text: string;
}

/** When a link ends, for printing. */
export const describeExpiry = (expiresAt: DateTime.Utc) =>
  isNeverExpiring(expiresAt) ? "never expires" : `until ${DateTime.formatIso(expiresAt)}`;

const wantsInvite = (input: {
  readonly access: AuthMcpClientAccess;
  readonly inviteApp: boolean;
}) => input.inviteApp && input.access === "full-access";

/**
 * The scopes the pairing code is spent for there: managing access and settings, the link's own,
 * and, when an invite may follow, every standard scope, which leaving an invite requires.
 */
export const bothWaysScopes = (input: {
  readonly access: AuthMcpClientAccess;
  readonly inviteApp: boolean;
}): ReadonlyArray<AuthEnvironmentScope> => [
  ...new Set<AuthEnvironmentScope>([
    AuthAccessWriteScope,
    AuthSettingsWriteScope,
    ...mcpClientScopes(input.access),
    ...(wantsInvite(input) ? AuthStandardClientScopes : []),
  ]),
];

/**
 * Why no invite is left, or null to leave one: only with full access, when the other side links
 * here at full access after this run, made now or before, and when the session there may leave
 * one. A code that cannot is a failure, so a rerun with one that can retries it.
 */
export const inviteSkipReason = (input: {
  readonly access: AuthMcpClientAccess;
  readonly inviteApp: boolean;
  readonly granted: ReadonlyArray<string>;
  readonly peerLinkAccess: AuthMcpClientAccess | undefined;
  readonly peerLabel: string;
}): StepOutcome | null => {
  const skipped = (why: string) => ({ ok: true, text: `skipped: ${why}` });
  if (!input.inviteApp) return skipped("--no-invite-app");
  if (input.access !== "full-access") {
    return skipped("only a full-access link invites the desktop app");
  }
  if (input.peerLinkAccess === undefined) return skipped(`${input.peerLabel} has no link here`);
  if (input.peerLinkAccess !== "full-access") {
    return skipped(
      `${input.peerLabel} keeps its ${input.peerLinkAccess} link here, and the invite would give its app more`,
    );
  }
  if (AuthStandardClientScopes.some((scope) => !input.granted.includes(scope))) {
    return {
      ok: false,
      text: `not possible with that pairing code, which cannot give every standard access on ${input.peerLabel}. Rerun with a code from \`t3 pair\` there to leave the invite`,
    };
  }
  return null;
};

const describeFailure = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "it failed";

/**
 * Links this environment and the one at `url` in both directions, turns on Linked environments
 * on each side where it is off, and with full access leaves the other side's desktop app an
 * invite to connect here. The pairing code is spent once for a short session there that must
 * manage access.
 */
export const linkBothWays = Effect.fn("environment.linkBothWays")(function* (input: {
  readonly url: string;
  readonly alternateUrls: ReadonlyArray<string>;
  readonly pairingCode: string;
  readonly access: AuthMcpClientAccess;
  readonly lifetime: Option.Option<AuthSessionLifetime>;
  readonly selfUrls: ReadonlyArray<string>;
  readonly inviteApp: boolean;
}) {
  const links = yield* PeerLinks.PeerLinks;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const self = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
  const origin = yield* remoteOrigin(input.url);
  const selfUrls = input.selfUrls.length > 0 ? input.selfUrls : yield* detectSelfUrls();
  const [selfUrl, ...selfAlternates] = selfUrls;
  if (selfUrl === undefined) {
    return yield* new EnvironmentBothWaysError({
      detail:
        "Found no address of this machine that the other one could reach. Pass --self-url with this environment's https or Tailscale address.",
    });
  }
  const lifetime = Option.getOrUndefined(input.lifetime);
  // A redirect could send the code or token anywhere.
  const httpClient = HttpClient.transform(yield* HttpClient.HttpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
  const anonymous = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
  const notT3 = () =>
    new EnvironmentBothWaysError({ detail: `${origin} did not answer as T3 Code.` });
  const peer = yield* anonymous.metadata.descriptor().pipe(Effect.mapError(notT3));
  // Only a server with renew can keep the session the code is spent on short, so ask before
  // spending it: a newer one refuses the unauthenticated call, an older one has no such route.
  const renewProbe = yield* httpClient
    .execute(
      HttpClientRequest.post(`${origin}/api/auth/clients/renew`).pipe(
        HttpClientRequest.setBody(HttpBody.text("{}", "application/json")),
      ),
    )
    .pipe(Effect.mapError(notT3));
  if (renewProbe.status === 404) return yield* olderPeer(peer.label);
  const issued = yield* anonymous.auth
    .token({
      headers: {},
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: input.pairingCode,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        // A code can delegate only scopes its minting session holds; it grants those it has.
        scope: encodeOAuthScope(bothWaysScopes(input)),
        client_label: `t3 environment link from ${self.label}`,
        client_device_type: "bot",
      },
    })
    .pipe(
      Effect.mapError(
        () =>
          new EnvironmentBothWaysError({
            detail: `${peer.label} refused the pairing code. Create a new one there with \`t3 pair\`, which can manage access.`,
          }),
      ),
    );
  const granted = parseOAuthScope(issued.scope) ?? [];
  if (!granted.includes(AuthAccessWriteScope)) {
    return yield* new EnvironmentBothWaysError({
      detail: `That pairing code cannot manage access on ${peer.label}. Create one with \`t3 pair\` there, which can.`,
    });
  }
  const sessionId = PeerLinks.peerSessionIdOf(issued.access_token);
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(issued.access_token)),
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  const endSession = Effect.fnUntraced(function* (millis: number) {
    if (Option.isNone(sessionId)) return;
    yield* client.auth.renewClient({
      headers: {},
      payload: { sessionId: sessionId.value, lifetime: { _tag: "duration", millis } },
    });
  });
  yield* endSession(REMOTE_SESSION_LIFETIME.millis).pipe(
    Effect.catchIf(isMissingEndpoint, () => Effect.fail(olderPeer(peer.label))),
    Effect.mapError((error) =>
      isEnvironmentBothWaysError(error)
        ? error
        : new EnvironmentBothWaysError({ detail: `${peer.label}: ${describeFailure(error)}` }),
    ),
  );

  const outcomes: Array<StepOutcome> = [];
  // The access of the other side's link here after this run, which decides the invite.
  let peerLinkAccess: AuthMcpClientAccess | undefined;
  // Through a running server, which then takes the change at once; the link back needs it on.
  const turnOnHere = RunningServer.changeState({
    scopes: [AuthSettingsWriteScope],
    viaServer: (server) =>
      server.access
        .enableLinkedEnvironments({ headers: {} })
        .pipe(Effect.map((result) => result.enabledLinkedEnvironments)),
    locally: links.turnOn,
  }).pipe(Effect.catchIf(isMissingEndpoint, () => links.turnOn));
  const step = <E, R>(
    name: string,
    effect: Effect.Effect<string, E, R>,
  ): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.result,
      Effect.map((result) => {
        outcomes.push(
          Result.isSuccess(result)
            ? { ok: true, text: `${name}: ${result.success}` }
            : {
                ok: false,
                text: `${name}: failed: ${isMissingEndpoint(result.failure) ? olderPeer(peer.label).message : describeFailure(result.failure)}`,
              },
        );
      }),
    );

  // Linking back first turns Linked environments on at both ends, which each link needs.
  yield* step(
    `${peer.label} → ${self.label}`,
    Effect.gen(function* () {
      const turnedOn = yield* turnOnHere;
      const code = yield* auth.issuePairingCredential({
        access: input.access,
        purpose: "peer-link",
        ...(lifetime ? { lifetime } : {}),
      });
      const linked = yield* client.access
        .linkPeer({
          headers: {},
          payload: {
            url: selfUrl,
            alternateUrls: selfAlternates,
            pairingCode: code.credential,
            access: input.access,
            expectedEnvironmentId: self.environmentId,
            expectedLabel: self.label,
            enableLinkedEnvironments: true,
          },
        })
        .pipe(Effect.tapError(() => auth.revokePairingLink(code.id).pipe(Effect.ignore)));
      peerLinkAccess = linked.link.access;
      if (linked.alreadyLinked) {
        yield* auth.revokePairingLink(code.id).pipe(Effect.ignore);
        return `already linked with ${linked.link.access} access, left as it is`;
      }
      const enabled = [
        ...(turnedOn ? [self.label] : []),
        ...(linked.enabledLinkedEnvironments ? [peer.label] : []),
      ];
      return `linked with ${linked.link.access} access, ${describeExpiry(linked.link.expiresAt)}${enabled.length > 0 ? `; turned on Linked environments on ${enabled.join(" and ")}` : ""}`;
    }),
  );

  yield* step(
    `${self.label} → ${peer.label}`,
    Effect.gen(function* () {
      const current = yield* links.get(peer.environmentId);
      const now = yield* DateTime.now;
      if (Option.isSome(current) && DateTime.isGreaterThan(current.value.expiresAt, now)) {
        return "already linked, left as it is";
      }
      const code = yield* client.auth.pairingCredential({
        headers: {},
        payload: {
          access: input.access,
          purpose: "peer-link",
          ...(lifetime ? { lifetime } : {}),
        },
      });
      // A code left unused there is revoked, as the other step does here.
      const revokeCode = client.auth
        .revokePairingLink({ headers: {}, payload: { id: code.id } })
        .pipe(Effect.ignore);
      const linked = yield* links
        .linkEnabling(
          {
            url: origin,
            alternateUrls: input.alternateUrls,
            pairingCode: code.credential,
            access: input.access,
            expectedEnvironmentId: peer.environmentId,
            expectedLabel: peer.label,
          },
          false,
        )
        .pipe(Effect.tapError(() => revokeCode));
      if (linked.alreadyLinked) {
        yield* revokeCode;
        return "already linked, left as it is";
      }
      return `linked with ${linked.link.access} access, ${describeExpiry(linked.link.expiresAt)}${lifetime && code.lifetime === undefined ? ` (${peer.label} ignored --expire)` : ""}`;
    }),
  );

  // The invite's code gives that app full use of this environment, more than a narrower link.
  const inviteLabel = `${peer.label} desktop app`;
  const skipInvite = inviteSkipReason({
    access: input.access,
    inviteApp: input.inviteApp,
    granted,
    peerLinkAccess,
    peerLabel: peer.label,
  });
  if (skipInvite !== null) {
    outcomes.push({ ...skipInvite, text: `${inviteLabel}: ${skipInvite.text}` });
  } else {
    yield* step(
      inviteLabel,
      Effect.gen(function* () {
        const app = yield* auth.createPairingLink({
          scopes: AuthStandardClientScopes,
          subject: "one-time-token",
          label: `${peer.label} desktop app`,
          ttl: Duration.millis(MAX_APP_INVITE_TTL_MILLIS),
          ...(lifetime ? { lifetime } : {}),
        });
        const invite = yield* client.access
          .createAppInvite({
            headers: {},
            payload: {
              environmentId: self.environmentId,
              label: self.label,
              urls: [selfUrl, ...selfAlternates],
              credential: app.credential,
              credentialExpiresAt: app.expiresAt,
            },
          })
          .pipe(Effect.tapError(() => auth.revokePairingLink(app.id).pipe(Effect.ignore)));
        return `invited to connect to ${self.label}, until ${DateTime.formatIso(invite.expiresAt)}`;
      }),
    );
  }

  yield* endSession(1000).pipe(Effect.ignore);
  yield* Console.log(`${outcomes.map((outcome) => outcome.text).join("\n")}\n`);
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  if (failed > 0) return yield* new EnvironmentBothWaysIncompleteError({ failed });
});
