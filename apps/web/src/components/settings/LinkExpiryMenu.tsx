import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  AuthAccessWriteScope,
  type AuthSessionLifetime,
  type EnvironmentId,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useGT } from "gt-react";
import { useId, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useEnvironment } from "~/state/environments";
import { setPeerLinkExpiry } from "~/state/peerLinkSessions";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { describeLifetime, RENEW_LIFETIMES, type RenewLifetimeId } from "./sessionLifetime.logic";

const useLifetimeLabels = (): Record<RenewLifetimeId, string> => {
  const gt = useGT();
  return { "30-days": gt("30 days"), "1-year": gt("1 year"), never: gt("Never") };
};

/** How long a link being made lasts. */
export function LinkExpiryPicker({
  value,
  onChange,
  disabled = false,
}: {
  /** Null until picked where no default applies yet. */
  readonly value: RenewLifetimeId | null;
  readonly onChange: (next: RenewLifetimeId) => void;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const labelId = useId();
  const labels = useLifetimeLabels();
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium">
        {gt("Link expires")}
      </span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next as RenewLifetimeId);
        }}
      >
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue>{value === null ? null : labels[value]}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {RENEW_LIFETIMES.map(({ id }) => (
            <SelectItem key={id} value={id} hideIndicator>
              {labels[id]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/**
 * Sets how long `link`, held by `environmentId`, lasts from now, with no new pairing code. The
 * link's session lives on the machine it reaches, so only a machine this app manages access on
 * offers it.
 */
export function LinkExpiryMenu({
  environmentId,
  link,
  disabled = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const source = useEnvironment(environmentId);
  const savedPeer = useEnvironment(link.environmentId);
  const mayManagePeer = useEnvironmentScope(link.environmentId, AuthAccessWriteScope);
  const labels = useLifetimeLabels();
  const [busy, setBusy] = useState(false);
  if (
    link.peerSessionId === undefined ||
    savedPeer === null ||
    !mayManagePeer ||
    peerLinkHealth(link, DateTime.makeUnsafe(nowMinute)).kind === "expired"
  ) {
    return null;
  }
  const setExpiry = async (lifetime: AuthSessionLifetime) => {
    setBusy(true);
    const outcome = await setPeerLinkExpiry(environmentId, link, lifetime);
    setBusy(false);
    if (outcome.kind === "done") {
      const described = describeLifetime(lifetime);
      toastManager.add({
        type: outcome.sourceUpdated ? "success" : "warning",
        title:
          described.kind === "never"
            ? gt("{label} never expires", { label: link.label })
            : gt(
                "{days, plural, one {{label} now expires in {days} day} other {{label} now expires in {days} days}}",
                { label: link.label, days: described.days },
              ),
        ...(outcome.sourceUpdated
          ? {}
          : {
              description: gt(
                "{source} could not be told yet and still shows the old expiry. Pick the expiry again to retry.",
                { source: source?.label ?? "" },
              ),
            }),
      });
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Could not change the expiry"),
        description:
          outcome.failure === "unsupported"
            ? gt("That machine runs an older T3 Code")
            : outcome.failure === "unknown_session"
              ? gt("A machine does not report its link's session. Link it again to renew.")
              : outcome.failure === "not_found"
                ? gt("That session no longer exists.")
                : gt("Check that this app is signed in there with access management."),
      }),
    );
  };
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" disabled={disabled || busy} />}>
        {busy ? gt("Updating…") : gt("Expiry")}
      </MenuTrigger>
      <MenuPopup align="end">
        {RENEW_LIFETIMES.map(({ id, lifetime }) => (
          <MenuItem key={id} onClick={() => void setExpiry(lifetime)}>
            {labels[id]}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
