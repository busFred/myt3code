import type { EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import type * as DateTime from "effect/DateTime";

/** Whether the peer holds a link to `environmentId` that has not expired. */
export const hasLinkBack = (
  peerLinks: ReadonlyArray<PeerLinkSummary>,
  environmentId: EnvironmentId,
  now: DateTime.Utc,
) =>
  peerLinks.some(
    (candidate) =>
      candidate.environmentId === environmentId &&
      peerLinkHealth(candidate, now).kind !== "expired",
  );

export type LinkDirection = "two-way" | "one-way" | "unknown" | "checking";

/**
 * Whether the peer links back here. `unknown` when this app cannot read the peer's links;
 * `checking` while they load for the first time.
 */
export const linkDirection = (input: {
  readonly canRead: boolean;
  readonly peerLinks: ReadonlyArray<PeerLinkSummary> | null;
  readonly failed: boolean;
  readonly environmentId: EnvironmentId;
  readonly now: DateTime.Utc;
}): LinkDirection => {
  if (!input.canRead) return "unknown";
  if (input.peerLinks === null) return input.failed ? "unknown" : "checking";
  return hasLinkBack(input.peerLinks, input.environmentId, input.now) ? "two-way" : "one-way";
};
