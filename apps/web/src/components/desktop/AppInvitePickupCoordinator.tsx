import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import { authEnvironment } from "../../state/auth";
import { readEnvironment, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appInviteSignal,
  pickUpAppInvites,
  shouldTakeAppInvites,
  singleFlightWithFollowUp,
  type TakeInvitesResult,
} from "./appInvitePickup";

const FOCUS_RECHECK_MS = 60_000;

function hasStatus(error: unknown, tag: string, status: number): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("_tag" in error && error._tag === tag) return true;
  const response = "response" in error ? error.response : null;
  return typeof response === "object" && response !== null && "status" in response
    ? response.status === status
    : false;
}

/**
 * Adds the environments that linked themselves to this one's server, without asking. Only the
 * desktop app's own session may take invites, so this does nothing in browsers and on mobile.
 */
export function AppInvitePickupCoordinator() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const ready = primary?.connection.phase === "connected" && window.desktopBridge !== undefined;
  const access = useEnvironmentQuery(
    ready && environmentId !== null
      ? authEnvironment.accessChanges({ environmentId, input: null })
      : null,
  );
  const snapshot = access.data?.type === "snapshot" ? access.data.payload : null;
  const failed = access.failure !== null;
  // A new invite can replace one while the signal stays pending, so the list itself is watched.
  const appInvites = snapshot === null ? null : snapshot.appInvites;
  const takeInvites = useAtomCommand(authEnvironment.takePendingAppInvites, {
    reportFailure: false,
  });
  const pairEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const lastRunAt = useRef(0);
  const checkedAtLaunch = useRef<string | null>(null);
  // A server that refuses this app's session never will take its invites, so it is not asked again.
  const refusedBy = useRef<string | null>(null);

  const pickUp = useEffectEvent(async () => {
    if (!ready || environmentId === null || refusedBy.current === environmentId) return;
    lastRunAt.current = Date.now();
    await pickUpAppInvites({
      isDesktop: window.desktopBridge !== undefined,
      take: async (): Promise<TakeInvitesResult> => {
        const result = await takeInvites({ environmentId, input: null });
        if (result._tag === "Success") return { _tag: "Taken", invites: result.value.invites };
        if (isAtomCommandInterrupted(result)) return { _tag: "Unsupported" };
        const error = squashAtomCommandFailure(result);
        if (hasStatus(error, "EnvironmentOperationForbiddenError", 403)) {
          refusedBy.current = environmentId;
          return { _tag: "Unsupported" };
        }
        return hasStatus(error, "EnvironmentResourceNotFoundError", 404)
          ? { _tag: "Unsupported" }
          : { _tag: "Failed", error };
      },
      isConnected: (id) => readEnvironment(id)?.connection.phase === "connected",
      pair: async (input) => {
        const result = await pairEnvironment(input);
        if (result._tag === "Success") return { ok: true };
        return { ok: false, error: squashAtomCommandFailure(result) };
      },
      log: (message, detail) => console.warn(message, detail),
    });
  });
  // A snapshot that changes during a pickup gets one more pickup after it.
  const [run] = useState(() => singleFlightWithFollowUp(() => pickUp()));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server announces invites on the access stream; one without it is checked once at launch
  useEffect(() => {
    if (!ready || environmentId === null) return;
    const current = appInviteSignal(
      {
        snapshot: appInvites === null ? null : appInvites === undefined ? {} : { appInvites },
        failed,
      },
      Date.now(),
    );
    if (!shouldTakeAppInvites(current, checkedAtLaunch.current === environmentId)) return;
    checkedAtLaunch.current = environmentId;
    void run();
  }, [ready, environmentId, appInvites, failed, run]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus is an external event; retries invites a failed take left, at most once a minute
  useEffect(() => {
    if (!ready || appInviteSignal({ snapshot, failed }, Date.now()) !== "pending") return;
    const onFocus = () => {
      const now = Date.now();
      // An invite that expired since stays listed until the next snapshot.
      if (appInviteSignal({ snapshot, failed }, now) !== "pending") return;
      if (now - lastRunAt.current >= FOCUS_RECHECK_MS) void run();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready, snapshot, failed, run]);

  return null;
}
