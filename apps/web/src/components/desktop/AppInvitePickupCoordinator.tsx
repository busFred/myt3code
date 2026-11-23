import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useRef } from "react";

import { connectPairing } from "../../connection/onboarding";
import { authEnvironment } from "../../state/auth";
import { readEnvironment, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appInviteSignal,
  pickUpAppInvites,
  shouldTakeAppInvites,
  type TakeInvitesResult,
} from "./appInvitePickup";

const FOCUS_RECHECK_MS = 60_000;

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("_tag" in error && error._tag === "EnvironmentResourceNotFoundError") return true;
  const response = "response" in error ? error.response : null;
  return typeof response === "object" && response !== null && "status" in response
    ? response.status === 404
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
  const signal = appInviteSignal({
    snapshot: access.data?.type === "snapshot" ? access.data.payload : null,
    failed: access.failure !== null,
  });
  const takeInvites = useAtomCommand(authEnvironment.takePendingAppInvites, {
    reportFailure: false,
  });
  const pairEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const inFlight = useRef(false);
  const lastRunAt = useRef(0);
  const checkedAtLaunch = useRef<string | null>(null);

  const run = useEffectEvent(async () => {
    if (!ready || environmentId === null || inFlight.current) return;
    inFlight.current = true;
    lastRunAt.current = Date.now();
    await pickUpAppInvites({
      isDesktop: window.desktopBridge !== undefined,
      take: async (): Promise<TakeInvitesResult> => {
        const result = await takeInvites({ environmentId, input: null });
        if (result._tag === "Success") return { _tag: "Taken", invites: result.value.invites };
        if (isAtomCommandInterrupted(result)) return { _tag: "Unsupported" };
        const error = squashAtomCommandFailure(result);
        return isNotFound(error) ? { _tag: "Unsupported" } : { _tag: "Failed", error };
      },
      isConnected: (id) => readEnvironment(id)?.connection.phase === "connected",
      pair: async (input) => {
        const result = await pairEnvironment(input);
        if (result._tag === "Success") return { ok: true };
        return { ok: false, error: squashAtomCommandFailure(result) };
      },
      log: (message, detail) => console.warn(message, detail),
    }).finally(() => {
      inFlight.current = false;
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server announces invites on the access stream; one without it is checked once at launch
  useEffect(() => {
    if (!ready || environmentId === null) return;
    if (!shouldTakeAppInvites(signal, checkedAtLaunch.current === environmentId)) return;
    checkedAtLaunch.current = environmentId;
    void run();
  }, [ready, environmentId, signal]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus is an external event; retries invites a failed take left, at most once a minute
  useEffect(() => {
    if (!ready || signal !== "pending") return;
    const onFocus = () => {
      if (Date.now() - lastRunAt.current >= FOCUS_RECHECK_MS) void run();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready, signal]);

  return null;
}
