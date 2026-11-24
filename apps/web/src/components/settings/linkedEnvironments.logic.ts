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
