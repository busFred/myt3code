import type { AuthPendingAppInvite, EnvironmentId } from "@t3tools/contracts";
import { carriesCredentialsSafely } from "@t3tools/shared/hostClassification";

export type TakeInvitesResult =
  | { readonly _tag: "Taken"; readonly invites: ReadonlyArray<AuthPendingAppInvite> }
  /** An older server without the endpoint: nothing to pick up. */
  | { readonly _tag: "Unsupported" }
  | { readonly _tag: "Failed"; readonly error: unknown };

/**
 * What this server's access snapshot says about invites. `unavailable`: no snapshot can come,
 * or it predates invites, so only a check at launch can find one. `unknown`: none yet.
 */
export type AppInviteSignal = "pending" | "none" | "unavailable" | "unknown";

/** The snapshot is not resent when an invite expires, so expired ones are left out here. */
export function appInviteSignal(
  access: {
    readonly snapshot: {
      readonly appInvites?: ReadonlyArray<{ readonly expiresAt: { epochMilliseconds: number } }>;
    } | null;
    readonly failed: boolean;
  },
  nowMillis: number,
): AppInviteSignal {
  if (access.snapshot === null) return access.failed ? "unavailable" : "unknown";
  if (access.snapshot.appInvites === undefined) return "unavailable";
  return access.snapshot.appInvites.some((invite) => invite.expiresAt.epochMilliseconds > nowMillis)
    ? "pending"
    : "none";
}

/** Taking writes to the server, so it runs only when there is something to take. */
export function shouldTakeAppInvites(signal: AppInviteSignal, checkedAtLaunch: boolean): boolean {
  return signal === "pending" || (signal === "unavailable" && !checkedAtLaunch);
}

export interface AppInvitePickupDeps {
  readonly isDesktop: boolean;
  readonly take: () => Promise<TakeInvitesResult>;
  /**
   * True when the invite adds nothing: the environment is saved and connected or connecting,
   * or the user turned it off, which an invite never undoes.
   */
  readonly isHandled: (environmentId: EnvironmentId) => boolean;
  /** Redeems the invite's one-time code at one address and saves the environment. */
  readonly pair: (input: {
    readonly host: string;
    readonly pairingCode: string;
    readonly expectedEnvironmentId: EnvironmentId;
  }) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>;
  readonly log: (message: string, detail?: unknown) => void;
}

/**
 * Adds every environment that left an invite for this desktop app. The server deletes an invite
 * once it is taken, so a failure is only logged: nothing is left to retry.
 */
export async function pickUpAppInvites(deps: AppInvitePickupDeps): Promise<number> {
  if (!deps.isDesktop) return 0;
  const taken = await deps.take();
  if (taken._tag === "Unsupported") return 0;
  if (taken._tag === "Failed") {
    deps.log("Could not check for app invites.", taken.error);
    return 0;
  }
  let added = 0;
  for (const invite of taken.invites) {
    if (deps.isHandled(invite.environmentId)) continue;
    // The code gives full use of that environment, so it never travels over plain http.
    const hosts = invite.urls.filter(carriesCredentialsSafely);
    let lastError: unknown = new Error(
      invite.urls.length === 0
        ? "The invite has no addresses."
        : "The invite has only plain http addresses, which would send its code unencrypted.",
    );
    let saved = false;
    for (const host of hosts) {
      const result = await deps.pair({
        host,
        pairingCode: invite.credential,
        expectedEnvironmentId: invite.environmentId,
      });
      if (result.ok) {
        saved = true;
        break;
      }
      lastError = result.error;
    }
    if (saved) {
      added += 1;
    } else {
      deps.log(
        `Could not add "${invite.label}" from its app invite; the invite is used up, so link it again.`,
        lastError,
      );
    }
  }
  return added;
}

/**
 * Runs `task` one at a time. A trigger while it runs asks for one more run after it ends, so a
 * change that lands mid-run is never missed and a burst of them costs one extra run.
 */
export function singleFlightWithFollowUp(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const loop = async () => {
    do {
      again = false;
      await task().catch(() => undefined);
    } while (again);
    running = null;
  };
  return () => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = loop();
    return running;
  };
}
