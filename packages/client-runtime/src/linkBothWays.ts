import {
  type AuthCreateAppInviteInput,
  type AuthMcpClientAccess,
  type AuthSessionId,
  type AuthSessionLifetime,
  type EnvironmentId,
  MAX_APP_INVITE_TTL_MILLIS,
  MCP_CLIENT_SESSION_SUBJECT,
  type PeerLinkCreateInput,
  type PeerLinkFailureKind,
  type PeerLinkSummary,
  peerLinkFailureKind,
} from "@t3tools/contracts";
import { carriesCredentialsSafely } from "@t3tools/shared/hostClassification";
import type * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

/** One of the two environments, as this client knows it. */
export interface BothWaysSide {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /**
   * Where the other side can reach this one, most preferred first: the `urls` that
   * `linkableMachines` gives for this machine with the other side as the linking environment.
   */
  readonly urls: ReadonlyArray<string>;
  /** Whether Linked environments is on here, as `offersLinkedEnvironments` reads it. */
  readonly linkedEnvironmentsEnabled: boolean;
}

export type BothWaysStep = "enable_a" | "enable_b" | "a_to_b" | "b_to_a" | "invite";

/**
 * `unsupported`: that server predates the call. `disabled`: Linked environments could not be
 * turned on, so the link was not tried. `no_address`: no address the other side can reach.
 */
export type BothWaysFailure =
  | PeerLinkFailureKind
  | "no_code"
  | "no_address"
  | "disabled"
  | "unsupported";

export type BothWaysOutcome =
  | {
      readonly kind: "done";
      /** The pairing code's server dropped the requested lifetime: it predates lifetimes. */
      readonly lifetimeIgnored?: true;
    }
  /**
   * `not_full_access`: the invite's code would give more than the link, so none is left.
   * `not_linked`: the other side has no link here, so neither is the invite.
   * `no_safe_address`: every address would carry the invite's code over plain http.
   */
  | {
      readonly kind: "skipped";
      readonly reason?: "not_full_access" | "not_linked" | "no_safe_address";
    }
  /** A link the side already had, kept as it is: neither its access nor its lifetime changed. */
  | { readonly kind: "kept"; readonly access: AuthMcpClientAccess }
  | { readonly kind: "failed"; readonly failure: BothWaysFailure; readonly detail: string | null };

/**
 * What the orchestration needs from the client, each run with the client's own session on the
 * named environment. Failures are values; `isUnsupported` says when one is a missing endpoint.
 */
export interface BothWaysOps {
  readonly enableLinks: (environmentId: EnvironmentId) => Promise<Result.Result<unknown, unknown>>;
  /** A one-use peer-link code minted there (`purpose: "peer-link"`); `lifetime` echoes the result's. */
  readonly mintLinkCode: (
    environmentId: EnvironmentId,
    input: { readonly access: AuthMcpClientAccess; readonly lifetime?: AuthSessionLifetime },
  ) => Promise<
    Result.Result<
      {
        readonly id: string;
        readonly credential: string;
        readonly lifetime?: AuthSessionLifetime;
      },
      unknown
    >
  >;
  /**
   * Has `linkingEnvironmentId` link to the other side unless it already does, which it then keeps
   * and reports with its access, its code unused (the HTTP `linkPeer`).
   */
  readonly link: (
    linkingEnvironmentId: EnvironmentId,
    input: PeerLinkCreateInput,
  ) => Promise<
    Result.Result<
      { readonly alreadyLinked: boolean; readonly access: AuthMcpClientAccess },
      unknown
    >
  >;
  /** A standard one-use pairing code minted there for the desktop app of `appEnvironment`. */
  readonly mintAppCode: (
    environmentId: EnvironmentId,
    input: {
      readonly appEnvironment: Pick<BothWaysSide, "environmentId" | "label">;
      readonly lifetime?: AuthSessionLifetime;
      readonly linkTtlMillis: number;
    },
  ) => Promise<
    Result.Result<
      {
        readonly id: string;
        readonly credential: string;
        readonly expiresAt: DateTime.Utc;
        readonly lifetime?: AuthSessionLifetime;
      },
      unknown
    >
  >;
  /** Revokes a code this client minted there, as `authEnvironment.revokePairingLink` does. */
  readonly revokeCode: (environmentId: EnvironmentId, id: string) => Promise<unknown>;
  readonly createInvite: (
    environmentId: EnvironmentId,
    input: AuthCreateAppInviteInput,
  ) => Promise<Result.Result<unknown, unknown>>;
  readonly isUnsupported?: (failure: unknown) => boolean;
}

/** A peer link error, the socket's or the HTTP one, or the request error wrapping the latter. */
const peerLinkFailureOf = (
  failure: unknown,
): {
  readonly error: Parameters<typeof peerLinkFailureKind>[0];
  readonly detail: string;
} | null => {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) return null;
  if (failure._tag === "RemoteEnvironmentAuthFetchError" && "cause" in failure) {
    return peerLinkFailureOf(failure.cause);
  }
  const text =
    failure._tag === "EnvironmentPeerLinkFailedError" && "detail" in failure
      ? failure.detail
      : failure._tag === "PeerLinkError" && "message" in failure
        ? failure.message
        : undefined;
  if (typeof text !== "string" || !("reason" in failure)) return null;
  return { error: failure as unknown as Parameters<typeof peerLinkFailureKind>[0], detail: text };
};

/**
 * Only a peer link error passes its text through, never a wrapper's own: anything else may carry
 * the request, and with it the pairing code.
 */
const failureOf = (
  failure: unknown,
  ops: Pick<BothWaysOps, "isUnsupported">,
  fallback: BothWaysFailure = "other",
): BothWaysOutcome => {
  if (ops.isUnsupported?.(failure) === true) {
    return { kind: "failed", failure: "unsupported", detail: null };
  }
  const peerLink = peerLinkFailureOf(failure);
  return peerLink === null
    ? { kind: "failed", failure: fallback, detail: null }
    : { kind: "failed", failure: peerLinkFailureKind(peerLink.error), detail: peerLink.detail };
};

const settle = async (run: () => Promise<BothWaysOutcome>): Promise<BothWaysOutcome> =>
  run().catch((): BothWaysOutcome => ({ kind: "failed", failure: "other", detail: null }));

/**
 * Links two environments both ways with codes minted on the side linked to, after turning Linked
 * environments on where off. Existing links are kept and a failure stops only its step, so a rerun
 * retries it. `invite` invites `b`'s desktop app to `a` once `b` links to `a` at full access.
 */
export async function runLinkBothWays(input: {
  readonly a: BothWaysSide;
  readonly b: BothWaysSide;
  readonly access: AuthMcpClientAccess;
  /** For both links and the invite's app session. Absent keeps each server's default. */
  readonly lifetime?: AuthSessionLifetime;
  readonly invite: boolean;
  readonly ops: BothWaysOps;
}): Promise<ReadonlyMap<BothWaysStep, BothWaysOutcome>> {
  const { a, b, ops } = input;
  const lifetime = input.lifetime === undefined ? {} : { lifetime: input.lifetime };
  const enable = (side: BothWaysSide) =>
    settle(async () => {
      if (side.linkedEnvironmentsEnabled) return { kind: "skipped" };
      const enabled = await ops.enableLinks(side.environmentId);
      return Result.isSuccess(enabled) ? { kind: "done" } : failureOf(enabled.failure, ops);
    });
  const [enableA, enableB] = await Promise.all([enable(a), enable(b)]);
  const bothOn = enableA.kind !== "failed" && enableB.kind !== "failed";

  /** The step's outcome and the access of the link `linking` has after it, if any. */
  type LinkResult = {
    readonly outcome: BothWaysOutcome;
    readonly access?: AuthMcpClientAccess;
  };
  const link = (linking: BothWaysSide, target: BothWaysSide): Promise<LinkResult> =>
    (async (): Promise<LinkResult> => {
      if (!bothOn) return { outcome: { kind: "failed", failure: "disabled", detail: null } };
      // The linking server sends the code over plain http only to a Tailscale name or loopback.
      const [url, ...alternateUrls] = [
        ...target.urls.filter(carriesCredentialsSafely),
        ...target.urls.filter((candidate) => !carriesCredentialsSafely(candidate)),
      ];
      if (url === undefined) {
        return { outcome: { kind: "failed", failure: "no_address", detail: null } };
      }
      const minted = await ops.mintLinkCode(target.environmentId, {
        access: input.access,
        ...lifetime,
      });
      if (Result.isFailure(minted)) return { outcome: failureOf(minted.failure, ops, "no_code") };
      // Best effort: an unused code would otherwise stay valid there until it expires.
      const revokeCode = () =>
        Promise.resolve(ops.revokeCode(target.environmentId, minted.success.id)).catch(
          () => undefined,
        );
      const linked = await ops.link(linking.environmentId, {
        url,
        ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
        expectedEnvironmentId: target.environmentId,
        expectedLabel: target.label,
        pairingCode: minted.success.credential,
        access: input.access,
      });
      if (Result.isFailure(linked)) {
        await revokeCode();
        return { outcome: failureOf(linked.failure, ops) };
      }
      if (linked.success.alreadyLinked) {
        await revokeCode();
        return {
          outcome: { kind: "kept", access: linked.success.access },
          access: linked.success.access,
        };
      }
      return { outcome: lifetimeOutcome(minted.success), access: linked.success.access };
    })().catch((): LinkResult => ({ outcome: { kind: "failed", failure: "other", detail: null } }));

  const lifetimeOutcome = (minted: { readonly lifetime?: AuthSessionLifetime }): BothWaysOutcome =>
    input.lifetime !== undefined && minted.lifetime === undefined
      ? { kind: "done", lifetimeIgnored: true }
      : { kind: "done" };

  const invite = (bLinkAccess: AuthMcpClientAccess | undefined) =>
    settle(async (): Promise<BothWaysOutcome> => {
      if (!input.invite) return { kind: "skipped" };
      if (input.access !== "full-access") return { kind: "skipped", reason: "not_full_access" };
      if (bLinkAccess === undefined) return { kind: "skipped", reason: "not_linked" };
      if (bLinkAccess !== "full-access") return { kind: "skipped", reason: "not_full_access" };
      // The invite's code gives full use of `a`, so it never travels over plain http.
      const [firstUrl, ...otherUrls] = a.urls.filter(carriesCredentialsSafely);
      if (firstUrl === undefined) return { kind: "skipped", reason: "no_safe_address" };
      const minted = await ops.mintAppCode(a.environmentId, {
        appEnvironment: { environmentId: b.environmentId, label: b.label },
        linkTtlMillis: MAX_APP_INVITE_TTL_MILLIS,
        ...lifetime,
      });
      if (Result.isFailure(minted)) return failureOf(minted.failure, ops, "no_code");
      const created = await ops.createInvite(b.environmentId, {
        environmentId: a.environmentId,
        label: a.label,
        urls: [firstUrl, ...otherUrls],
        credential: minted.success.credential,
        credentialExpiresAt: minted.success.expiresAt,
      });
      if (Result.isSuccess(created)) return lifetimeOutcome(minted.success);
      // Best effort: the code this client minted stays unused.
      await Promise.resolve(ops.revokeCode(a.environmentId, minted.success.id)).catch(
        () => undefined,
      );
      return failureOf(created.failure, ops);
    });

  const [aToB, bToA] = await Promise.all([link(a, b), link(b, a)]);
  const invited = await invite(bToA.access);
  return new Map<BothWaysStep, BothWaysOutcome>([
    ["enable_a", enableA],
    ["enable_b", enableB],
    ["a_to_b", aToB.outcome],
    ["b_to_a", bToA.outcome],
    ["invite", invited],
  ]);
}

/** One side of a pair whose sessions get a new lifetime. */
export interface RenewBothWaysSide {
  readonly environmentId: EnvironmentId;
  /**
   * This side's link to the other, as its `peerLinks.list` reports it; absent when none, null
   * when its links could not be read.
   */
  readonly linkToOther?: Pick<PeerLinkSummary, "peerSessionId" | "status"> | null;
  /** This client's own session here, to renew as well; absent leaves it as it is. */
  readonly clientSessionId?: AuthSessionId;
}

export type RenewBothWaysStep = "a_to_b" | "b_to_a" | "client_a" | "client_b";

/**
 * `unknown_session`: the linking side predates reporting its session there; link again.
 * `unreadable`: the linking side's links could not be read, so whether it has one is unknown.
 */
export type RenewBothWaysOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "failed";
      readonly failure: "unknown_session" | "unreadable" | "not_found" | "unsupported" | "other";
    };

/**
 * Gives both link sessions, and optionally this client's own sessions, a new lifetime such as
 * never. A link's session lives on the side it links to, so each is renewed there with this
 * client's session, which needs access management (`access:write`) on that side.
 */
export async function runRenewBothWays(input: {
  readonly a: RenewBothWaysSide;
  readonly b: RenewBothWaysSide;
  readonly lifetime: AuthSessionLifetime;
  readonly ops: {
    /** `expectedSubject` refuses a session id that does not name that kind of session. */
    readonly renew: (
      environmentId: EnvironmentId,
      sessionId: AuthSessionId,
      lifetime: AuthSessionLifetime,
      expectedSubject?: string,
    ) => Promise<Result.Result<{ readonly renewed: boolean }, unknown>>;
    readonly isUnsupported?: (failure: unknown) => boolean;
  };
}): Promise<ReadonlyMap<RenewBothWaysStep, RenewBothWaysOutcome>> {
  const { ops } = input;
  const renew = (
    environmentId: EnvironmentId,
    sessionId: AuthSessionId,
    expectedSubject?: string,
  ) =>
    ops
      .renew(environmentId, sessionId, input.lifetime, expectedSubject)
      .then((result): RenewBothWaysOutcome =>
        Result.isSuccess(result)
          ? result.success.renewed
            ? { kind: "done" }
            : { kind: "failed", failure: "not_found" }
          : {
              kind: "failed",
              failure: ops.isUnsupported?.(result.failure) === true ? "unsupported" : "other",
            },
      )
      .catch((): RenewBothWaysOutcome => ({ kind: "failed", failure: "other" }));
  const renewLink = (linking: RenewBothWaysSide, target: RenewBothWaysSide) => {
    const link = linking.linkToOther;
    if (link === null) {
      return Promise.resolve<RenewBothWaysOutcome>({ kind: "failed", failure: "unreadable" });
    }
    if (link === undefined || link.status === "expired") {
      return Promise.resolve<RenewBothWaysOutcome>({ kind: "skipped" });
    }
    return link.peerSessionId === undefined
      ? Promise.resolve<RenewBothWaysOutcome>({ kind: "failed", failure: "unknown_session" })
      : // The linking side reports this id; the target renews it only as a peer link's session.
        renew(target.environmentId, link.peerSessionId, MCP_CLIENT_SESSION_SUBJECT);
  };
  const renewClient = (side: RenewBothWaysSide) =>
    side.clientSessionId === undefined
      ? Promise.resolve<RenewBothWaysOutcome>({ kind: "skipped" })
      : renew(side.environmentId, side.clientSessionId);
  const [aToB, bToA, clientA, clientB] = await Promise.all([
    renewLink(input.a, input.b),
    renewLink(input.b, input.a),
    renewClient(input.a),
    renewClient(input.b),
  ]);
  return new Map<RenewBothWaysStep, RenewBothWaysOutcome>([
    ["a_to_b", aToB],
    ["b_to_a", bToA],
    ["client_a", clientA],
    ["client_b", clientB],
  ]);
}
