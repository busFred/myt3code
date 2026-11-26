import {
  type AuthSessionLifetime,
  isNeverExpiring,
  NON_RENEWABLE_SESSION_SUBJECTS,
} from "@t3tools/contracts";

const DAY_MILLIS = 24 * 60 * 60 * 1000;
export const MAX_CUSTOM_LIFETIME_DAYS = 3650;

export type LifetimeMode = "default" | "custom" | "never";
export interface LifetimeChoice {
  readonly mode: LifetimeMode;
  /** What the custom field holds, as typed. */
  readonly days: string;
}
export const DEFAULT_LIFETIME_CHOICE: LifetimeChoice = { mode: "default", days: "90" };

const parseDays = (input: string): number | null => {
  if (!/^\d+$/u.test(input.trim())) return null;
  const days = Number(input);
  return days >= 1 && days <= MAX_CUSTOM_LIFETIME_DAYS ? days : null;
};

export const isLifetimeChoiceValid = (choice: LifetimeChoice) =>
  choice.mode !== "custom" || parseDays(choice.days) !== null;

/** `undefined` keeps each server's default (30 days), which older servers also know. */
export function lifetimeFromChoice(choice: LifetimeChoice): AuthSessionLifetime | undefined {
  if (choice.mode === "never") return { _tag: "never" };
  if (choice.mode !== "custom") return undefined;
  const days = parseDays(choice.days);
  return days === null ? undefined : { _tag: "duration", millis: days * DAY_MILLIS };
}

export type RenewLifetimeId = "30-days" | "1-year" | "never";
export const RENEW_LIFETIMES: ReadonlyArray<{
  readonly id: RenewLifetimeId;
  readonly lifetime: AuthSessionLifetime;
}> = [
  { id: "30-days", lifetime: { _tag: "duration", millis: 30 * DAY_MILLIS } },
  { id: "1-year", lifetime: { _tag: "duration", millis: 365 * DAY_MILLIS } },
  { id: "never", lifetime: { _tag: "never" } },
];

/** A new link's lifetime: the default 30 days stays implicit, as older servers know only it. */
export const linkLifetime = (id: RenewLifetimeId): AuthSessionLifetime | undefined =>
  id === "30-days" ? undefined : RENEW_LIFETIMES.find((entry) => entry.id === id)?.lifetime;

/**
 * Where the link expiry picker starts. A link being made again keeps how long it lasts, so
 * renewing never shortens one that never expires; one ending over a month away lasts a year.
 * `undefined`: the source's links are not read yet, so there is no default to give.
 */
export function defaultLinkLifetimeId(
  existingExpiresAtMillis: number | null | undefined,
  nowMillis: number,
): RenewLifetimeId | null {
  if (existingExpiresAtMillis === undefined) return null;
  if (existingExpiresAtMillis === null) return "30-days";
  if (isNeverExpiring(existingExpiresAtMillis)) return "never";
  return existingExpiresAtMillis - nowMillis > 31 * DAY_MILLIS ? "1-year" : "30-days";
}

/** T3 Connect and desktop app sessions keep their own lifetimes; the server refuses to renew them. */
export const canRenewSession = (session: { readonly subject: string }) =>
  !NON_RENEWABLE_SESSION_SUBJECTS.includes(session.subject);

/**
 * A DPoP device renews its own sign-in, so renewing it sets how long it may go unused rather
 * than when it ends.
 */
export const renewsItself = (session: { readonly method: string }) =>
  session.method === "dpop-access-token";

export type LifetimeDescription =
  | { readonly kind: "never" }
  | { readonly kind: "days"; readonly days: number };

export const describeLifetime = (lifetime: AuthSessionLifetime): LifetimeDescription =>
  lifetime._tag === "never"
    ? { kind: "never" }
    : { kind: "days", days: Math.max(1, Math.round(lifetime.millis / DAY_MILLIS)) };

/** A 404 means the machine runs a T3 Code that predates the call. */
export function isMissingEndpointFailure(failure: unknown, depth = 0): boolean {
  if (typeof failure !== "object" || failure === null || depth > 4) return false;
  if ("status" in failure && failure.status === 404) return true;
  if (
    "response" in failure &&
    typeof failure.response === "object" &&
    failure.response !== null &&
    "status" in failure.response &&
    failure.response.status === 404
  ) {
    return true;
  }
  return "cause" in failure && isMissingEndpointFailure(failure.cause, depth + 1);
}
