import {
  type AuthRenewClientSessionInput,
  type AuthSessionLifetime,
  type EnvironmentId,
  MCP_CLIENT_SESSION_SUBJECT,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

/**
 * `unknown_session`: the linking side predates reporting its session there; link again.
 * `not_found`: that session is gone there. `unsupported`: that server predates renewing.
 */
export type LinkExpiryOutcome =
  /**
   * `sourceUpdated`: the linking side asked for the new expiry. It learns a shorter one only
   * when asked, so until then it shows the old one; renewing again asks again.
   */
  | { readonly kind: "done"; readonly sourceUpdated: boolean }
  | {
      readonly kind: "failed";
      readonly failure: "unknown_session" | "not_found" | "unsupported" | "other";
    };

/**
 * Gives a link's session a new lifetime, such as never. The session lives on the machine the
 * link reaches, so it is renewed there with the client's session, which needs access
 * management (`access:write`) there.
 */
export async function renewPeerLink(input: {
  readonly link: Pick<PeerLinkSummary, "environmentId" | "peerSessionId">;
  readonly lifetime: AuthSessionLifetime;
  readonly ops: {
    readonly renew: (
      environmentId: EnvironmentId,
      input: AuthRenewClientSessionInput,
    ) => Promise<Result.Result<{ readonly renewed: boolean }, unknown>>;
    readonly isUnsupported?: (failure: unknown) => boolean;
    /** Has the linking side ask the other when the link now ends. */
    readonly refreshSource: () => Promise<Result.Result<unknown, unknown>>;
  };
}): Promise<LinkExpiryOutcome> {
  const { link, ops } = input;
  if (link.peerSessionId === undefined) return { kind: "failed", failure: "unknown_session" };
  try {
    // The linking side reports this id; the other side renews it only as a peer link's session.
    const renewed = await ops.renew(link.environmentId, {
      sessionId: link.peerSessionId,
      lifetime: input.lifetime,
      expectedSubject: MCP_CLIENT_SESSION_SUBJECT,
    });
    if (Result.isSuccess(renewed)) {
      if (!renewed.success.renewed) return { kind: "failed", failure: "not_found" };
      const refreshed = await ops.refreshSource().catch((cause: unknown) => Result.fail(cause));
      return { kind: "done", sourceUpdated: Result.isSuccess(refreshed) };
    }
    return {
      kind: "failed",
      failure: ops.isUnsupported?.(renewed.failure) === true ? "unsupported" : "other",
    };
  } catch {
    return { kind: "failed", failure: "other" };
  }
}

/** The server minting a link's code predates lifetimes and dropped the one asked for. */
export const peerLinkLifetimeDropped = (
  requested: AuthSessionLifetime | undefined,
  minted: AuthSessionLifetime | undefined,
): boolean => requested !== undefined && minted === undefined;
