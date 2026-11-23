import type { AuthPendingAppInvite, EnvironmentId } from "@t3tools/contracts";

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

export function appInviteSignal(access: {
  readonly snapshot: { readonly appInvites?: ReadonlyArray<unknown> } | null;
  readonly failed: boolean;
}): AppInviteSignal {
  if (access.snapshot === null) return access.failed ? "unavailable" : "unknown";
  if (access.snapshot.appInvites === undefined) return "unavailable";
  return access.snapshot.appInvites.length > 0 ? "pending" : "none";
}

/** Taking writes to the server, so it runs only when there is something to take. */
export function shouldTakeAppInvites(signal: AppInviteSignal, checkedAtLaunch: boolean): boolean {
  return signal === "pending" || (signal === "unavailable" && !checkedAtLaunch);
}

export interface AppInvitePickupDeps {
  readonly isDesktop: boolean;
  readonly take: () => Promise<TakeInvitesResult>;
  /** True when the environment is already saved and connected, so the invite adds nothing. */
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
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
    if (deps.isConnected(invite.environmentId)) continue;
    let lastError: unknown = new Error("The invite has no addresses.");
    let saved = false;
    for (const host of invite.urls) {
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
