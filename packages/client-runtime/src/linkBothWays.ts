import {
  type AuthCreateAppInviteInput,
  type AuthMcpClientAccess,
  type AuthSessionId,
  type AuthSessionLifetime,
  type EnvironmentId,
  MAX_PAIRING_LINK_TTL_MILLIS,
  type PeerLinkCreateInput,
  type PeerLinkFailureKind,
  type PeerLinkSummary,
  peerLinkFailureKind,
} from "@t3tools/contracts";
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
  /** Whether this side already has an unexpired link to the other. */
  readonly linksToOther: boolean;
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
  | { readonly kind: "skipped" }
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
    Result.Result<{ readonly credential: string; readonly lifetime?: AuthSessionLifetime }, unknown>
  >;
  /** Has `linkingEnvironmentId` link to the other side, as `peerLinks.link` does. */
  readonly link: (
    linkingEnvironmentId: EnvironmentId,
    input: PeerLinkCreateInput,
  ) => Promise<Result.Result<unknown, unknown>>;
  /** A standard one-use pairing code minted there for the desktop app of `appEnvironment`. */
  readonly mintAppCode: (
    environmentId: EnvironmentId,
    input: {
      readonly appEnvironment: Pick<BothWaysSide, "environmentId" | "label">;
      readonly lifetime?: AuthSessionLifetime;
      readonly linkTtlMillis: number;
    },
  ) => Promise<
    Result.Result<{ readonly credential: string; readonly expiresAt: DateTime.Utc }, unknown>
  >;
  readonly createInvite: (
    environmentId: EnvironmentId,
    input: AuthCreateAppInviteInput,
  ) => Promise<Result.Result<unknown, unknown>>;
  readonly isUnsupported?: (failure: unknown) => boolean;
}

/**
 * Only a peer link error passes its message through: anything else may carry the request,
 * and with it the pairing code.
 */
const failureOf = (
  failure: unknown,
  ops: Pick<BothWaysOps, "isUnsupported">,
  fallback: BothWaysFailure = "other",
): BothWaysOutcome => {
  if (ops.isUnsupported?.(failure) === true) {
    return { kind: "failed", failure: "unsupported", detail: null };
  }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "PeerLinkError" &&
    "reason" in failure &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    const error = failure as unknown as Parameters<typeof peerLinkFailureKind>[0];
    return { kind: "failed", failure: peerLinkFailureKind(error), detail: failure.message };
  }
  return { kind: "failed", failure: fallback, detail: null };
};

const settle = async (run: () => Promise<BothWaysOutcome>): Promise<BothWaysOutcome> =>
  run().catch((): BothWaysOutcome => ({ kind: "failed", failure: "other", detail: null }));

/**
 * Links two environments both ways, each link with a code minted on the side it links to, after
 * turning Linked environments on where it is off. Linked sides are left alone and a failure stops
 * only its step, so a rerun retries what failed. `invite` leaves `b`'s desktop app an invite to `a`.
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

  const link = (linking: BothWaysSide, target: BothWaysSide) =>
    settle(async (): Promise<BothWaysOutcome> => {
      if (linking.linksToOther) return { kind: "skipped" };
      if (!bothOn) return { kind: "failed", failure: "disabled", detail: null };
      const [url, ...alternateUrls] = target.urls;
      if (url === undefined) return { kind: "failed", failure: "no_address", detail: null };
      const minted = await ops.mintLinkCode(target.environmentId, {
        access: input.access,
        ...lifetime,
      });
      if (Result.isFailure(minted)) return failureOf(minted.failure, ops, "no_code");
      const linked = await ops.link(linking.environmentId, {
        url,
        ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
        expectedEnvironmentId: target.environmentId,
        expectedLabel: target.label,
        pairingCode: minted.success.credential,
        access: input.access,
      });
      if (Result.isFailure(linked)) return failureOf(linked.failure, ops);
      return input.lifetime !== undefined && minted.success.lifetime === undefined
        ? { kind: "done", lifetimeIgnored: true }
        : { kind: "done" };
    });

  const invite = () =>
    settle(async (): Promise<BothWaysOutcome> => {
      if (!input.invite) return { kind: "skipped" };
      const [firstUrl, ...otherUrls] = a.urls;
      if (firstUrl === undefined) return { kind: "failed", failure: "no_address", detail: null };
      const minted = await ops.mintAppCode(a.environmentId, {
        appEnvironment: { environmentId: b.environmentId, label: b.label },
        linkTtlMillis: MAX_PAIRING_LINK_TTL_MILLIS,
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
      return Result.isSuccess(created) ? { kind: "done" } : failureOf(created.failure, ops);
    });

  const [aToB, bToA, invited] = await Promise.all([link(a, b), link(b, a), invite()]);
  return new Map<BothWaysStep, BothWaysOutcome>([
    ["enable_a", enableA],
    ["enable_b", enableB],
    ["a_to_b", aToB],
    ["b_to_a", bToA],
    ["invite", invited],
  ]);
}

/** One side of a pair whose sessions get a new lifetime. */
export interface RenewBothWaysSide {
  readonly environmentId: EnvironmentId;
  /** This side's link to the other, as its `peerLinks.list` reports it; absent when none. */
  readonly linkToOther?: Pick<PeerLinkSummary, "peerSessionId" | "status">;
  /** This client's own session here, to renew as well; absent leaves it as it is. */
  readonly clientSessionId?: AuthSessionId;
}

export type RenewBothWaysStep = "a_to_b" | "b_to_a" | "client_a" | "client_b";

/** `unknown_session`: the linking side predates reporting its session there; link again. */
export type RenewBothWaysOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "skipped" }
  | {
      readonly kind: "failed";
      readonly failure: "unknown_session" | "not_found" | "unsupported" | "other";
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
    readonly renew: (
      environmentId: EnvironmentId,
      sessionId: AuthSessionId,
      lifetime: AuthSessionLifetime,
    ) => Promise<Result.Result<{ readonly renewed: boolean }, unknown>>;
    readonly isUnsupported?: (failure: unknown) => boolean;
  };
}): Promise<ReadonlyMap<RenewBothWaysStep, RenewBothWaysOutcome>> {
  const { ops } = input;
  const renew = (environmentId: EnvironmentId, sessionId: AuthSessionId) =>
    ops
      .renew(environmentId, sessionId, input.lifetime)
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
    if (link === undefined || link.status === "expired") {
      return Promise.resolve<RenewBothWaysOutcome>({ kind: "skipped" });
    }
    return link.peerSessionId === undefined
      ? Promise.resolve<RenewBothWaysOutcome>({ kind: "failed", failure: "unknown_session" })
      : renew(target.environmentId, link.peerSessionId);
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
