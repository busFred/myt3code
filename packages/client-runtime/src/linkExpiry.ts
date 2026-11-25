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
  | { readonly kind: "done" }
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
      return renewed.success.renewed ? { kind: "done" } : { kind: "failed", failure: "not_found" };
    }
    return {
      kind: "failed",
      failure: ops.isUnsupported?.(renewed.failure) === true ? "unsupported" : "other",
    };
  } catch {
    return { kind: "failed", failure: "other" };
  }
}
