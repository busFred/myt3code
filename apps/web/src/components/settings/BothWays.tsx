import { useAtomValue } from "@effect/atom-react";
import type { BothWaysOutcome, BothWaysStep } from "@t3tools/client-runtime/link-both-ways";
import { linkBatchFailureLabel } from "@t3tools/client-runtime/link-batch";
import type { AuthMcpClientAccess, EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useId } from "react";

import { bothWaysSide, linkEnvironmentsBothWays } from "~/state/bothWays";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  type LifetimeChoice,
  type LifetimeMode,
  isLifetimeChoiceValid,
  lifetimeFromChoice,
  MAX_CUSTOM_LIFETIME_DAYS,
  mergeBothWaysRetry,
  summarizeBothWays,
} from "./sessionLifetime.logic";

/** How long a device stays signed in: the default 30 days, a number of days, or never. */
export function SessionLifetimePicker({
  value,
  onChange,
  disabled = false,
  label,
}: {
  readonly value: LifetimeChoice;
  readonly onChange: (next: LifetimeChoice) => void;
  readonly disabled?: boolean;
  readonly label: string;
}) {
  const gt = useGT();
  const labelId = useId();
  const names: Record<LifetimeMode, string> = {
    default: gt("30 days"),
    custom: gt("Custom…"),
    never: gt("Never"),
  };
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium text-foreground">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <Select
          value={value.mode}
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== null) onChange({ ...value, mode: next as LifetimeMode });
          }}
        >
          <SelectTrigger aria-labelledby={labelId}>
            <SelectValue>{names[value.mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {(["default", "custom", "never"] as const).map((mode) => (
              <SelectItem key={mode} value={mode} hideIndicator>
                {names[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {value.mode === "custom" ? (
          <>
            <Input
              value={value.days}
              onChange={(event) => onChange({ ...value, days: event.target.value })}
              disabled={disabled}
              inputMode="numeric"
              aria-label={gt("Days")}
              aria-invalid={!isLifetimeChoiceValid(value)}
              className="w-24"
              nativeInput
            />
            <span className="text-xs text-muted-foreground">
              {gt("days, up to {max}", { max: MAX_CUSTOM_LIFETIME_DAYS })}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The "Bi-directional link" choice with the device lifetime it applies to both links. */
export function BothWaysOption({
  checked,
  onCheckedChange,
  lifetime,
  onLifetimeChange,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly lifetime: LifetimeChoice;
  readonly onLifetimeChange: (next: LifetimeChoice) => void;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onCheckedChange(next === true)}
        />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground">
            <T>Bi-directional link</T>
          </span>
          <span className="block text-xs text-muted-foreground">
            <T>
              Also links the other machine back to this one and, with full access, invites its
              desktop app to connect within a day. Turns on Labs → Linked environments on either
              machine where it is off.
            </T>
          </span>
        </span>
      </label>
      {checked ? (
        <SessionLifetimePicker
          label={gt("How long both links and the invited app stay signed in")}
          value={lifetime}
          onChange={onLifetimeChange}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

const STEPS: ReadonlyArray<BothWaysStep> = ["enable_a", "enable_b", "a_to_b", "b_to_a", "invite"];

/** Each step's outcome, with what went wrong for the failed ones. */
export function BothWaysResults({
  outcomes,
  aLabel,
  bLabel,
}: {
  readonly outcomes: ReadonlyMap<BothWaysStep, BothWaysOutcome>;
  readonly aLabel: string;
  readonly bLabel: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const stepLabel = (step: BothWaysStep) => {
    switch (step) {
      case "enable_a":
        return gt("Turn on Linked environments on {label}", { label: aLabel });
      case "enable_b":
        return gt("Turn on Linked environments on {label}", { label: bLabel });
      case "a_to_b":
        return gt("{from} links to {to}", { from: aLabel, to: bLabel });
      case "b_to_a":
        return gt("{from} links to {to}", { from: bLabel, to: aLabel });
      case "invite":
        return gt("Invite the desktop app on {label}", { label: bLabel });
    }
  };
  const failureLabel = (outcome: Extract<BothWaysOutcome, { kind: "failed" }>) => {
    switch (outcome.failure) {
      case "unsupported":
        return gt("That machine runs an older T3 Code");
      case "disabled":
        return gt("Linked environments could not be turned on");
      case "no_address":
        return gt("No address the other machine can reach");
      default:
        return linkBatchFailureLabel(outcome.failure, m);
    }
  };
  return (
    <ul className="space-y-1 rounded-lg border px-3 py-2 text-xs" aria-live="polite">
      {STEPS.flatMap((step) => {
        const outcome = outcomes.get(step);
        if (outcome === undefined || (outcome.kind === "skipped" && step.startsWith("enable"))) {
          return [];
        }
        return [
          <li key={step} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="max-w-full wrap-anywhere text-foreground">{stepLabel(step)}</span>
            <span
              className={
                outcome.kind === "failed"
                  ? "basis-full wrap-anywhere text-destructive"
                  : "ml-auto text-right text-muted-foreground"
              }
            >
              {outcome.kind === "done"
                ? gt("Done")
                : outcome.kind === "kept"
                  ? gt("Already linked, kept as it is ({access})", {
                      access: m(accessConfig[outcome.access].label),
                    })
                  : outcome.kind === "skipped"
                    ? outcome.reason === "not_full_access"
                      ? gt("Only with full access")
                      : outcome.reason === "not_linked"
                        ? gt("Only after a link is made")
                        : outcome.reason === "no_safe_address"
                          ? gt("Needs an https or Tailscale address")
                          : gt("Already done")
                    : outcome.detail !== null
                      ? `${failureLabel(outcome)}: ${outcome.detail}`
                      : failureLabel(outcome)}
            </span>
          </li>,
        ];
      })}
      {summarizeBothWays(outcomes).lifetimeIgnored ? (
        <li className="text-warning">
          {gt("That machine runs an older T3 Code")}.{" "}
          {gt("It ignored the device lifetime, so the device signs in for the default 30 days.")}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Links `a` and `b` both ways with this client's sessions; links either side has are kept, and
 * steps `previous` finished stay done. `batch` leaves the link lists for the caller to refresh once.
 */
export function useBothWaysRunner() {
  const gt = useGT();
  const relays = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments;
  return async (input: {
    readonly a: EnvironmentId;
    readonly b: EnvironmentId;
    readonly access: AuthMcpClientAccess;
    readonly lifetime: LifetimeChoice;
    readonly previous?: ReadonlyMap<BothWaysStep, BothWaysOutcome>;
    readonly batch?: boolean;
    /** Leave the invite out; omitted keeps it. */
    readonly invite?: boolean;
  }) => {
    const a = bothWaysSide({ environmentId: input.a, other: input.b, relays });
    const b = bothWaysSide({ environmentId: input.b, other: input.a, relays });
    if (a === null || b === null) return null;
    const outcomes = await linkEnvironmentsBothWays({
      a,
      b,
      access: input.access,
      lifetime: lifetimeFromChoice(input.lifetime),
      invite: input.invite !== false && input.previous?.get("invite")?.kind !== "done",
      batch: input.batch === true,
      appCodeLabel: (label) => gt("App for {label}", { label }),
    });
    return mergeBothWaysRetry(input.previous, outcomes);
  };
}
