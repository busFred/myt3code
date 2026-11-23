import {
  AuthMcpClientAccess,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  AuthSessionId,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  MCP_PEER_LINK_SOFTWARE_ID,
  type PeerLink,
  type PeerLinkCreateInput,
  PeerLinkError,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const PeerHttpApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth)
  .annotateMerge(EnvironmentHttpApi.annotations);

/** The redirect registered for a link. Nothing ever listens there: the code comes back in the response. */
const LINK_REDIRECT_URI = "http://127.0.0.1/t3code-peer-link";
/**
 * How long a peer's descriptor or MCP handshake may take before a route counts
 * as unreachable. A tailnet or relayed route to a machine that is waking up takes longer.
 */
export const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);
/** How long a listing waits on a link's addresses; a real call still gives a waking peer `probeTimeout`. */
const LIST_PROBE_TIMEOUT = Duration.seconds(3);
const MCP_PROTOCOL_VERSION = "2025-06-18";
const EXPIRY_PROBE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "t3code-peer", version: "1" },
  },
});

/** Node's TLS verification code in a failed request's cause chain, if any. */
export const certificateErrorCode = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 6 && Predicate.isObject(current); depth++) {
    if (
      Predicate.hasProperty(current, "code") &&
      typeof current.code === "string" &&
      /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|INVALID_(CA|PURPOSE)|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH/.test(
        current.code,
      )
    )
      return current.code;
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return undefined;
};

/** A usable link: where to reach the peer and the token to send there. */
export interface ResolvedPeerLink {
  readonly link: PeerLink;
  /** The first address that answered as this peer. */
  readonly url: string;
  readonly token: string;
  /** Where the token is stored; a link made again gets a new one. */
  readonly secretName: string;
}

export const LINKED_ENVIRONMENTS_OFF =
  "Linked environments is off on this machine. Turn it on in Settings → Labs.";

/**
 * Links from this environment to others. Linking signs this environment in to
 * the peer's `/mcp` as an outside agent with a pairing code from the peer, the
 * same MCP OAuth flow an outside agent uses, without a browser. The peer's
 * session token is kept in the server secret store; the table keeps the rest.
 */
export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    /** Whether the Linked environments beta (Settings → Labs) is on here. */
    readonly enabled: Effect.Effect<boolean>;
    readonly link: (input: PeerLinkCreateInput) => Effect.Effect<PeerLink, PeerLinkError>;
    /**
     * Links like `link`, except that a machine whose link has not expired is
     * left as it is, with its pairing code unused.
     */
    readonly linkUnlessLinked: (
      input: PeerLinkCreateInput,
    ) => Effect.Effect<{ readonly link: PeerLink; readonly alreadyLinked: boolean }, PeerLinkError>;
    /** Turns on Linked environments here when it is off; true when this call turned it on. */
    readonly turnOn: Effect.Effect<boolean, PeerLinkError>;
    /** Links unless linked, first turning on Linked environments here when asked and it is off. */
    readonly linkEnabling: (
      input: PeerLinkCreateInput,
      enableFirst: boolean,
    ) => Effect.Effect<
      {
        readonly link: PeerLink;
        readonly alreadyLinked: boolean;
        readonly enabledLinkedEnvironments: boolean;
      },
      PeerLinkError
    >;
    readonly list: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError>;
    /** The stored link, without asking the peer whether it answers. */
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
    /** Forgets the link here. The peer still lists the session until it is revoked there. */
    readonly unlink: (environmentId: EnvironmentId) => Effect.Effect<boolean, PeerLinkError>;
    /** An address that answers as the linked peer, with its token, ready to call. */
    readonly resolve: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ResolvedPeerLink, PeerLinkError>;
    /** Records the outcome of a call, so listing shows whether the peer answered last time. */
    readonly recordOutcome: (
      environmentId: EnvironmentId,
      outcome: { readonly error: string | null },
    ) => Effect.Effect<void>;
    /**
     * Records the end the peer gives the link's session, only while the link still holds the
     * credential stored as `secretName`, so an answer for a replaced one is dropped. A call's
     * answer only moves it later, since a slow one may predate a renewal; `allowEarlier` is for
     * asking the peer outright, which decides.
     */
    readonly recordExpiry: (input: {
      readonly environmentId: EnvironmentId;
      readonly secretName: string;
      readonly expiresAt: DateTime.Utc;
      readonly allowEarlier?: boolean;
    }) => Effect.Effect<void>;
    /**
     * Asks the peer when the link's session ends, as after it was renewed there, and records it.
     * None when the peer does not say, such as one that no longer accepts the link.
     */
    readonly refreshExpiry: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<DateTime.Utc>, PeerLinkError>;
  }
>()("t3/peer/PeerLinks") {}

interface PeerLinkRow {
  readonly environment_id: string;
  readonly secret_name: string;
  readonly label: string;
  readonly urls_json: string;
  readonly access: string;
  readonly linked_at: string;
  readonly expires_at: string;
  readonly last_reached_at: string | null;
  readonly last_error: string | null;
  readonly fenced: number;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccess = Schema.decodeUnknownEffect(AuthMcpClientAccess);
const decodeTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sid: AuthSessionId })),
);

/** The session a peer's token names there. T3 Code signs its session claims but does not encrypt them. */
export const peerSessionIdOf = (token: string) => {
  const [payload] = token.split(".");
  return payload === undefined
    ? Option.none()
    : Option.map(
        decodeTokenClaims(Buffer.from(payload, "base64url").toString("utf8")),
        (claims) => claims.sid,
      );
};

/** Fails with a fixed storage error that keeps its cause; the log gets the details. */
const failStorage = (cause: unknown) =>
  Effect.logWarning("Peer link storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new PeerLinkError({
          reason: "storage",
          message:
            "Linked environments could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

/**
 * The base URL a peer is reached at, normalised to its origin. The pairing
 * code and then the link's token travel to it, so plain http is accepted only
 * where the network already encrypts: this machine, or a Tailscale address.
 */
const peerOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        // Never the address as given: it may hold a username, password or query.
        message: "That address is not an http or https address.",
      }),
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  ) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${parsed.origin} is plain http, which would send the link's credentials unencrypted. Use its https address, or its Tailscale address.`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

/** The system error under a failed connection, such as ECONNREFUSED or ENOTFOUND. */
const connectionCode = (cause: unknown) =>
  [cause, Predicate.hasProperty(cause, "cause") ? cause.cause : undefined]
    .map((error) => (Predicate.hasProperty(error, "code") ? error.code : undefined))
    .find(Predicate.isString);

/** Why `origin` did not answer as T3 Code, short enough for a toast. Never echoes a body. */
const probeFailure = (
  origin: string,
  error: HttpClientError.HttpClientError | Schema.SchemaError | Cause.TimeoutError,
  timeout: Duration.Duration,
) => {
  const unreachable = (message: string) => new PeerLinkError({ reason: "unreachable", message });
  const certificate = certificateErrorCode(error);
  if (certificate !== undefined) {
    return unreachable(`${origin} presented a certificate this machine rejected (${certificate}).`);
  }
  if (Cause.isTimeoutError(error)) {
    return unreachable(`${origin} did not answer within ${Duration.toSeconds(timeout)} seconds.`);
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError") {
    const code = connectionCode(error.reason.cause);
    return unreachable(
      code === undefined ? `${origin} did not answer.` : `${origin} did not answer (${code}).`,
    );
  }
  return new PeerLinkError({
    reason: "not_a_t3_environment",
    message: `${origin} answered, but not as a T3 Code environment this version understands.`,
  });
};

/** Whether a host is this machine's own loopback. Tests serve their peers there, so they narrow it. */
export const LoopbackHost = Context.Reference<(host: string) => boolean>(
  "t3/peer/PeerLinks/LoopbackHost",
  { defaultValue: () => isLocalLoopbackHost },
);

/** Whether a peer holds a linked agent to its limits and keeps its work within its link. */
const linkLimitsHold = (peer: { readonly capabilities: ExecutionEnvironmentCapabilities }) =>
  peer.capabilities.mcpModeLimitHeader === true && peer.capabilities.linkFence === true;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const isOwnLoopback = yield* LoopbackHost;
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  /** A fresh name for one link's token; the row records it. */
  const newSecretName = random.randomBytes(16).pipe(
    Effect.map((bytes) => `peer-link-${Hex.encode(bytes)}`),
    Effect.orDie,
  );

  // Only the origin `peerOrigin` checked may receive a pairing code or token:
  // a redirect could forward them anywhere, including plain http.
  const peerHttpClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const clientFor = (origin: string) =>
    HttpApiClient.make(PeerHttpApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, peerHttpClient),
    );

  /** The environment answering at `origin`, or why nothing there answers as T3 Code. */
  const probe = (origin: string) => {
    const timeout = probeTimeout(origin);
    return clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      // A brief network drop must not list a live peer as down; the timeout still bounds both tries.
      Effect.retry({
        times: 1,
        schedule: Schedule.spaced("1 second"),
        while: (error) => certificateErrorCode(error) === undefined,
      }),
      Effect.timeout(timeout),
      // No cause: a decode error can carry the response body to the client.
      Effect.mapError((error) => probeFailure(origin, error, timeout)),
    );
  };

  /** Whether `url` answers as `environmentId`, counting any failure as no. */
  const answersAs = Effect.fn("PeerLinks.answersAs")(function* (
    url: string,
    environmentId: EnvironmentId,
  ) {
    const found = yield* probe(url).pipe(Effect.option);
    return Option.filter(found, (peer) => peer.environmentId === environmentId);
  });

  const toLink = Effect.fn("PeerLinks.toLink")(function* (row: PeerLinkRow) {
    return {
      environmentId: EnvironmentId.make(row.environment_id),
      label: row.label,
      urls: yield* decodeUrls(row.urls_json),
      access: yield* decodeAccess(row.access),
      linkedAt: DateTime.makeUnsafe(row.linked_at),
      // Its token predates link fencing, so the peer would not fence its work:
      // like an expired link, only a new pairing code brings it back.
      expiresAt: DateTime.makeUnsafe(row.fenced === 1 ? row.expires_at : row.linked_at),
      lastReachedAt: row.last_reached_at === null ? null : DateTime.makeUnsafe(row.last_reached_at),
      lastError: row.last_error,
    } satisfies PeerLink;
  }, Effect.catch(failStorage));

  const readRows = sql<PeerLinkRow>`
    SELECT * FROM peer_environment_links ORDER BY label, environment_id
  `.pipe(NodeSqliteClient.readOnly, Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<PeerLinkRow>`
      SELECT * FROM peer_environment_links WHERE environment_id = ${environmentId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  /** Signs in to the peer's `/mcp` with a pairing code: register, decide, exchange. */
  const signIn = Effect.fn("PeerLinks.signIn")(
    function* (origin: string, input: PeerLinkCreateInput, clientName: string) {
      const client = yield* clientFor(origin);
      // Only the peer's own refusals are rejections. A dropped connection or
      // an answer this version cannot read is classified below.
      const registered = yield* client.mcpOAuth
        .register({
          payload: {
            client_name: clientName,
            redirect_uris: [LINK_REDIRECT_URI],
            software_id: MCP_PEER_LINK_SOFTWARE_ID,
          },
        })
        .pipe(
          // A plain Schema.Error has no tag to catch by.
          Effect.catchIf(Schema.is(AuthMcpRegistrationError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused to register this environment: ${error.message}`,
              }),
            ),
          ),
        );
      const verifier = Base64Url.encode(yield* random.randomBytes(32));
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(Effect.orDie),
      );
      const state = Base64Url.encode(yield* random.randomBytes(16));
      const resource = `${origin}/mcp`;
      const decided = yield* client.mcpOAuth
        .decision({
          headers: {},
          payload: {
            authorization: {
              response_type: "code",
              client_id: registered.client_id,
              redirect_uri: LINK_REDIRECT_URI,
              code_challenge: challenge,
              code_challenge_method: "S256",
              state: Redacted.make(state),
              resource,
            },
            decision: { _tag: "pairing-code", access: input.access, code: input.pairingCode },
          },
        })
        .pipe(
          Effect.catchTags({
            AuthMcpApprovalError: (error) =>
              Effect.fail(
                new PeerLinkError({ reason: "pairing_rejected", message: error.message }),
              ),
          }),
        );
      const redirect = URL.parse(decided.redirectTo);
      if (redirect === null) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${origin} answered the sign-in with an address this version cannot read. Update both environments.`,
        });
      }
      const code = redirect.searchParams.get("code");
      if (code === null || redirect.searchParams.get("state") !== state) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message:
            redirect.searchParams.get("error_description") ??
            "The peer did not approve the link. Check the pairing code and try again.",
        });
      }
      return yield* client.mcpOAuth
        .token({
          payload: {
            grant_type: "authorization_code",
            code: Redacted.make(code),
            redirect_uri: LINK_REDIRECT_URI,
            client_id: registered.client_id,
            code_verifier: Redacted.make(verifier),
            resource,
          },
        })
        .pipe(
          Effect.catchIf(Schema.is(AuthMcpTokenError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused the sign-in: ${error.message}`,
              }),
            ),
          ),
        );
    },
    (effect, origin) =>
      effect.pipe(
        // Endpoint errors are mapped above; what is left is the transport or an
        // answer this version cannot decode.
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "incompatible",
                message: `${origin} answered in a shape this version does not understand. Update both environments.`,
                cause,
              }),
            ),
          HttpClientError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "unreachable",
                message: `${origin} stopped answering while linking.`,
                cause,
              }),
            ),
        }),
      ),
  );

  /**
   * The addresses that answer as `environmentId`, in the order given, with
   * what the first one answered. Addresses this environment would not send
   * credentials to are skipped; when none answers as it, the failure says why
   * for each.
   */
  const answeringAs = Effect.fn("PeerLinks.answeringAs")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    name: string,
  ) {
    const checked = yield* Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const origin = yield* peerOrigin(url);
          // Loopback is this machine, where anything may answer as the one picked.
          if (isOwnLoopback(new URL(origin).hostname)) {
            return yield* new PeerLinkError({
              reason: "unreachable",
              message: `${origin} is this machine, not ${name}.`,
            });
          }
          const descriptor = yield* probe(origin);
          if (descriptor.environmentId !== environmentId) {
            return yield* new PeerLinkError({
              reason: "unreachable",
              message: `${origin} answered as another environment, ${descriptor.label}.`,
              answeredAs: descriptor.label,
            });
          }
          return { origin, descriptor };
        }).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const matching = checked.flatMap((result) =>
      Result.isSuccess(result) ? [result.success] : [],
    );
    const first = matching[0];
    if (first === undefined) {
      const failures = checked.flatMap((result) =>
        Result.isFailure(result) ? [result.failure] : [],
      );
      const answeredAs = failures.find((failure) => failure.answeredAs !== undefined)?.answeredAs;
      return yield* new PeerLinkError({
        reason: "unreachable",
        message: `This environment could not reach ${name}: ${failures.map((failure) => failure.message).join(" ")}`,
        ...(answeredAs === undefined ? {} : { answeredAs }),
      });
    }
    // Each address is kept once, even when two spellings share an origin.
    const origins = [...new Set(matching.map((found) => found.origin))];
    return { primary: first.origin, peer: first.descriptor, origins };
  });

  /** The peer at `url`, with every address checked for credentials first. */
  const answeringAt = Effect.fn("PeerLinks.answeringAt")(function* (urls: ReadonlyArray<string>) {
    const origins = yield* Effect.forEach(urls, peerOrigin);
    const primary = origins[0]!;
    return { primary, peer: yield* probe(primary), origins };
  });

  const linkWith = Effect.fn("PeerLinks.link")(function* (
    input: PeerLinkCreateInput,
    keepLinked: boolean,
  ) {
    if (!(yield* enabled)) {
      return yield* new PeerLinkError({ reason: "disabled", message: LINKED_ENVIRONMENTS_OFF });
    }
    const urls = [input.url, ...(input.alternateUrls ?? [])];
    // The user picked a machine: link through the addresses that answer as
    // it, so one that now answers as another never receives the pairing code.
    const { primary, peer, origins } =
      input.expectedEnvironmentId === undefined
        ? yield* answeringAt(urls)
        : yield* answeringAs(
            urls,
            input.expectedEnvironmentId,
            input.expectedLabel ?? input.expectedEnvironmentId,
          );
    const row = yield* readRow(peer.environmentId);
    const stored = Option.isSome(row) ? yield* toLink(row.value) : undefined;
    const current =
      stored !== undefined && DateTime.isGreaterThan(stored.expiresAt, yield* DateTime.now)
        ? stored
        : undefined;
    if (keepLinked && current !== undefined) return { link: current, alreadyLinked: true };
    // Anything can answer as a linked machine, so an address alone renews its
    // link only where the link already reaches it, and never moves it.
    if (
      input.expectedEnvironmentId === undefined &&
      current !== undefined &&
      !current.urls.includes(primary)
    ) {
      return yield* new PeerLinkError({
        reason: "pairing_rejected",
        message: `${primary} answers as ${current.label}, which is already linked at another address. If ${current.label} moved, forget that link first.`,
      });
    }
    const self = yield* environment.getDescriptor;
    if (peer.environmentId === self.environmentId) {
      return yield* new PeerLinkError({
        reason: "self",
        message: "That address is this environment.",
      });
    }
    if (!linkLimitsHold(peer)) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${peer.label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.`,
      });
    }
    const issued = yield* signIn(primary, input, `T3 Code · ${self.label}`);
    const now = yield* DateTime.now;
    const peerSessionId = peerSessionIdOf(issued.access_token);
    const linked: PeerLink = {
      environmentId: peer.environmentId,
      label: peer.label,
      urls: origins,
      access: input.access,
      linkedAt: now,
      expiresAt: DateTime.add(now, { seconds: issued.expires_in }),
      lastReachedAt: now,
      lastError: null,
      ...(Option.isSome(peerSessionId) ? { peerSessionId: peerSessionId.value } : {}),
    };
    // The token goes under a name of its own before the row points at it,
    // so the row and its token are replaced together.
    const secretName = yield* newSecretName;
    yield* secrets
      .set(secretName, new TextEncoder().encode(issued.access_token))
      .pipe(Effect.catch(failStorage));
    // A token no row names could never be removed.
    const { previous, written } = yield* Effect.gen(function* () {
      const urlsJson = yield* encodeUrls(origins).pipe(Effect.catch(failStorage));
      const nowIso = DateTime.formatIso(now);
      const previous = yield* readRow(peer.environmentId);
      // Keeping a link replaces only one that has ended, in this one statement, so a link
      // that raced in since the read above wins. Stored expiries all compare as `formatIso` text.
      const written = yield* sql<{ secret_name: string }>`
        INSERT INTO peer_environment_links (
          environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
          last_reached_at, last_error, fenced
        ) VALUES (
          ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
          ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
          ${nowIso}, NULL, 1
        )
        ON CONFLICT (environment_id) DO UPDATE SET
          secret_name = excluded.secret_name,
          fenced = excluded.fenced,
          label = excluded.label,
          urls_json = excluded.urls_json,
          access = excluded.access,
          linked_at = excluded.linked_at,
          expires_at = excluded.expires_at,
          last_reached_at = excluded.last_reached_at,
          last_error = NULL
        WHERE ${keepLinked ? 1 : 0} = 0
          OR peer_environment_links.fenced <> 1
          OR peer_environment_links.expires_at <= ${nowIso}
        RETURNING secret_name
      `.pipe(Effect.catch(failStorage));
      return { previous, written: written.length > 0 };
    }).pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
    if (!written) {
      yield* secrets.remove(secretName).pipe(Effect.ignore);
      const winner = yield* readRow(peer.environmentId);
      if (Option.isNone(winner)) {
        return yield* new PeerLinkError({
          reason: "storage",
          message: `${peer.label} was linked and unlinked meanwhile. Link it again.`,
        });
      }
      return { link: yield* toLink(winner.value), alreadyLinked: true };
    }
    // Linking again replaces the old token. A racing link may leave its own
    // behind; it is unused either way.
    if (Option.isSome(previous) && previous.value.secret_name !== secretName) {
      yield* secrets.remove(previous.value.secret_name).pipe(Effect.ignore);
    }
    return { link: linked, alreadyLinked: false };
  });

  const link: PeerLinks["Service"]["link"] = (input) =>
    linkWith(input, false).pipe(Effect.map((result) => result.link));
  const linkUnlessLinked: PeerLinks["Service"]["linkUnlessLinked"] = (input) =>
    linkWith(input, true);

  const turnOn: PeerLinks["Service"]["turnOn"] = Effect.gen(function* () {
    if (yield* enabled) return false;
    yield* serverSettings.updateSettings({ linkedEnvironmentsEnabled: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PeerLinkError({
            reason: "storage",
            message: "Linked environments could not be turned on here.",
            cause,
          }),
      ),
    );
    return true;
  }).pipe(Effect.withSpan("PeerLinks.turnOn"));

  const linkEnabling: PeerLinks["Service"]["linkEnabling"] = Effect.fn("PeerLinks.linkEnabling")(
    function* (input, enableFirst) {
      const turnedOn = enableFirst ? yield* turnOn : false;
      const linked = yield* linkWith(input, true);
      return { ...linked, enabledLinkedEnvironments: turnedOn };
    },
  );

  /** A peer's label follows its machine name, so the link takes the one its own address answers with. */
  const withLabel = (link: PeerLink, label: string) =>
    label === link.label
      ? Effect.succeed(link)
      : sql`
          UPDATE peer_environment_links SET label = ${label}
          WHERE environment_id = ${link.environmentId}
        `.pipe(Effect.ignoreCause({ log: true }), Effect.as({ ...link, label }));

  const statusOf = Effect.fn("PeerLinks.statusOf")(function* (
    link: PeerLink,
    now: DateTime.Utc,
  ): Effect.fn.Return<PeerLinkSummary> {
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, now)) return { ...link, status: "expired" };
    // A race over no addresses never settles.
    if (link.urls.length === 0) return { ...link, status: "unreachable" };
    const answered = yield* Effect.raceAll(
      link.urls.map((url) =>
        answersAs(url, link.environmentId).pipe(Effect.flatMap(Effect.fromOption)),
      ),
    ).pipe(Effect.timeoutOption(LIST_PROBE_TIMEOUT), Effect.orElseSucceed(Option.none));
    if (Option.isNone(answered)) return { ...link, status: "unreachable" };
    return { ...(yield* withLabel(link, answered.value.label)), status: "reachable" };
  });

  /** Adds the session the stored token names on the peer; an unreadable token adds nothing. */
  const withPeerSessionId = (link: PeerLink, secretName: string) =>
    secrets.get(secretName).pipe(
      Effect.map((stored) => {
        const peerSessionId = Option.flatMap(stored, (token) =>
          peerSessionIdOf(new TextDecoder().decode(token)),
        );
        return Option.isSome(peerSessionId)
          ? { ...link, peerSessionId: peerSessionId.value }
          : link;
      }),
      Effect.orElseSucceed(() => link),
    );

  const list: PeerLinks["Service"]["list"] = Effect.gen(function* () {
    const links = yield* Effect.forEach(yield* readRows, (row) =>
      toLink(row).pipe(Effect.flatMap((link) => withPeerSessionId(link, row.secret_name))),
    );
    const now = yield* DateTime.now;
    return yield* Effect.forEach(links, (link) => statusOf(link, now), {
      concurrency: "unbounded",
    });
  });

  const get: PeerLinks["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(toLink(row)),
        }),
      ),
    );

  const unlink: PeerLinks["Service"]["unlink"] = Effect.fn("PeerLinks.unlink")(
    function* (environmentId) {
      const deleted = yield* sql<{ secret_name: string }>`
        DELETE FROM peer_environment_links WHERE environment_id = ${environmentId}
        RETURNING secret_name
      `.pipe(Effect.catch(failStorage));
      for (const row of deleted) {
        yield* secrets.remove(row.secret_name).pipe(Effect.catch(failStorage));
      }
      return deleted.length > 0;
    },
  );

  const resolve: PeerLinks["Service"]["resolve"] = Effect.fn("PeerLinks.resolve")(
    function* (environmentId) {
      const notLinked = new PeerLinkError({
        reason: "unknown_link",
        message: `This environment is not linked to ${environmentId}. t3_environment_links lists the linked ones.`,
      });
      const row = yield* readRow(environmentId);
      if (Option.isNone(row)) return yield* notLinked;
      const link = yield* toLink(row.value);
      // The expiry stored here is only the last one the peer named: a renewal there moves it,
      // so the peer decides, and refuses a link that really ended. An unfenced one never goes.
      if (row.value.fenced !== 1) {
        return yield* new PeerLinkError({
          reason: "expired",
          message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
        });
      }
      const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
      if (Option.isNone(stored)) {
        // An unlink between the two reads removes the row before its secret.
        if (Option.isNone(yield* readRow(environmentId))) return yield* notLinked;
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `The link to ${link.label} lost its credential. Link it again.`,
        });
      }
      // The token goes only to an address that still answers as this peer,
      // so one that now answers as another machine never receives it. The
      // addresses race, so a silent one never delays one that answers.
      const answered =
        link.urls.length === 0
          ? Option.none()
          : yield* Effect.raceAll(
              link.urls.map((url) =>
                answersAs(url, environmentId).pipe(
                  Effect.flatMap(Effect.fromOption),
                  Effect.map((peer) => ({ url, peer })),
                ),
              ),
            ).pipe(Effect.option);
      if (Option.isNone(answered)) {
        return yield* new PeerLinkError({
          reason: "unreachable",
          message: `${link.label} did not answer at ${link.urls.join(", ")}.`,
        });
      }
      const { url, peer } = answered.value;
      // A link made before the peer had to fence linked work, or a peer moved
      // back to such a version, would carry work past those limits.
      if (!linkLimitsHold(peer)) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.`,
        });
      }
      return {
        link: yield* withLabel(link, peer.label),
        url,
        token: new TextDecoder().decode(stored.value),
        secretName: row.value.secret_name,
      };
    },
  );

  const recordOutcome: PeerLinks["Service"]["recordOutcome"] = (environmentId, outcome) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        outcome.error === null
          ? sql`
              UPDATE peer_environment_links
              SET last_reached_at = ${DateTime.formatIso(now)}, last_error = NULL
              WHERE environment_id = ${environmentId}
            `
          : sql`
              UPDATE peer_environment_links SET last_error = ${outcome.error}
              WHERE environment_id = ${environmentId}
            `,
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
    );

  const recordExpiry: PeerLinks["Service"]["recordExpiry"] = Effect.fn("PeerLinks.recordExpiry")(
    function* ({ environmentId, secretName, expiresAt, allowEarlier }) {
      const iso = DateTime.formatIso(expiresAt);
      // A link made again meanwhile has a new secret name, which this update then misses.
      // Stored expiries are all `formatIso`, so they compare as text.
      yield* allowEarlier === true
        ? sql`
            UPDATE peer_environment_links SET expires_at = ${iso}
            WHERE environment_id = ${environmentId} AND secret_name = ${secretName}
          `
        : sql`
            UPDATE peer_environment_links SET expires_at = ${iso}
            WHERE environment_id = ${environmentId} AND secret_name = ${secretName}
              AND expires_at < ${iso}
          `;
    },
    Effect.ignoreCause({ log: true }),
  );

  const refreshExpiry: PeerLinks["Service"]["refreshExpiry"] = Effect.fn("PeerLinks.refreshExpiry")(
    function* (environmentId) {
      const { url, token, secretName } = yield* resolve(environmentId);
      // The lightest call the peer authenticates as the link; its answer names the link's end.
      const response = yield* peerHttpClient
        .execute(
          HttpClientRequest.post(`${url}/mcp`).pipe(
            HttpClientRequest.setHeaders({
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
            }),
            HttpClientRequest.setBody(HttpBody.text(EXPIRY_PROBE_BODY, "application/json")),
          ),
        )
        .pipe(
          Effect.timeout(probeTimeout(url)),
          Effect.mapError(
            () =>
              new PeerLinkError({
                reason: "unreachable",
                message: `${url} did not answer in time.`,
              }),
          ),
        );
      const expiresAt = Option.flatMap(
        Option.fromNullishOr(response.headers[McpInvocationContext.LINK_EXPIRES_AT_HEADER]),
        DateTime.make,
      );
      // Best effort: the session `initialize` opened there is ended rather than left to idle out.
      const mcpSessionId = response.headers["mcp-session-id"];
      if (mcpSessionId !== undefined) {
        yield* peerHttpClient
          .execute(
            HttpClientRequest.delete(`${url}/mcp`).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${token}`,
                "mcp-session-id": mcpSessionId,
                "mcp-protocol-version": MCP_PROTOCOL_VERSION,
              }),
            ),
          )
          .pipe(Effect.timeout(probeTimeout(url)), Effect.ignore);
      }
      if (response.status !== 200 || Option.isNone(expiresAt)) return Option.none();
      yield* recordExpiry({
        environmentId,
        secretName,
        expiresAt: DateTime.toUtc(expiresAt.value),
        allowEarlier: true,
      });
      return Option.some(DateTime.toUtc(expiresAt.value));
    },
  );

  return PeerLinks.of({
    enabled,
    link,
    linkUnlessLinked,
    turnOn,
    linkEnabling,
    list,
    get,
    unlink,
    resolve,
    recordOutcome,
    recordExpiry,
    refreshExpiry,
  });
});

export const layer = Layer.effect(PeerLinks, make);
