import {
  type AuthCreateAppInviteInput,
  type AuthMcpClientAccess,
  type AuthSessionLifetime,
  type EnvironmentId,
  MAX_APP_INVITE_TTL_MILLIS,
} from "@t3tools/contracts";
import { carriesCredentialsSafely } from "@t3tools/shared/hostClassification";
import type * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

interface InviteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * `not_full_access`: the app's code would give more than the link it pairs with, so none is left.
 * `no_safe_address`: every address would carry the code over plain http.
 * `unsupported`: a server predates app invites.
 */
export type AppInviteOutcome =
  | { readonly kind: "invited" }
  | { readonly kind: "skipped"; readonly reason: "not_full_access" | "no_safe_address" }
  | { readonly kind: "failed"; readonly failure: "no_code" | "unsupported" | "other" };

/** Each op runs with the client's own session on the environment it names. */
export interface AppInviteOps {
  /** A standard one-use pairing code minted on `environmentId` for the app of `appEnvironment`. */
  readonly mintAppCode: (
    environmentId: EnvironmentId,
    input: {
      readonly appEnvironment: InviteEnvironment;
      readonly linkTtlMillis: number;
      readonly lifetime?: AuthSessionLifetime;
    },
  ) => Promise<
    Result.Result<
      { readonly id: string; readonly credential: string; readonly expiresAt: DateTime.Utc },
      unknown
    >
  >;
  readonly createInvite: (
    environmentId: EnvironmentId,
    input: AuthCreateAppInviteInput,
  ) => Promise<Result.Result<unknown, unknown>>;
  /** Revokes a code this client minted there. */
  readonly revokeCode: (environmentId: EnvironmentId, id: string) => Promise<unknown>;
  readonly isUnsupported?: (failure: unknown) => boolean;
}

/**
 * Leaves an invite on `app` for its desktop app to connect to `host`'s background service.
 * The invite's code gives full use of `host`, so it is made only when `app` links to `host` at
 * full access, and travels only over https or Tailscale.
 */
export async function inviteDesktopApp(input: {
  readonly host: InviteEnvironment & { readonly urls: ReadonlyArray<string> };
  readonly app: InviteEnvironment;
  /** The access of `app`'s own link to `host`. */
  readonly appLinkAccess: AuthMcpClientAccess;
  /** For the app's session on `host`. Absent keeps that server's default. */
  readonly lifetime?: AuthSessionLifetime;
  readonly ops: AppInviteOps;
}): Promise<AppInviteOutcome> {
  const { host, app, ops } = input;
  if (input.appLinkAccess !== "full-access") return { kind: "skipped", reason: "not_full_access" };
  const [url, ...alternateUrls] = host.urls.filter(carriesCredentialsSafely);
  if (url === undefined) return { kind: "skipped", reason: "no_safe_address" };
  const failed = (failure: unknown, fallback: "no_code" | "other"): AppInviteOutcome => ({
    kind: "failed",
    failure: ops.isUnsupported?.(failure) === true ? "unsupported" : fallback,
  });
  try {
    const minted = await ops.mintAppCode(host.environmentId, {
      appEnvironment: app,
      linkTtlMillis: MAX_APP_INVITE_TTL_MILLIS,
      ...(input.lifetime === undefined ? {} : { lifetime: input.lifetime }),
    });
    if (Result.isFailure(minted)) return failed(minted.failure, "no_code");
    const created = await ops.createInvite(app.environmentId, {
      environmentId: host.environmentId,
      label: host.label,
      urls: [url, ...alternateUrls],
      credential: minted.success.credential,
      credentialExpiresAt: minted.success.expiresAt,
    });
    if (Result.isSuccess(created)) return { kind: "invited" };
    // Best effort: the unused code would otherwise stay valid there until it expires.
    await Promise.resolve(ops.revokeCode(host.environmentId, minted.success.id)).catch(
      () => undefined,
    );
    return failed(created.failure, "other");
  } catch {
    return { kind: "failed", failure: "other" };
  }
}
