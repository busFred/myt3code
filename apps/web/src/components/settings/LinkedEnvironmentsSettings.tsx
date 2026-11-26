import { useAtomValue } from "@effect/atom-react";
import {
  linkBackBlockLabel,
  linkBatchFailureLabel,
  linkWithMintedCode,
} from "@t3tools/client-runtime/link-batch";
import { ANOTHER_ADDRESS, linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  AuthSettingsWriteScope,
  type EnvironmentId,
  isNeverExpiring,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { peerLinkHealth, type PeerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { carriesCredentialsSafely } from "@t3tools/shared/hostClassification";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { T, useGT, useLocale, useMessages, Var } from "gt-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironment } from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { inviteDesktopAppTo } from "~/state/peerLinkSessions";
import {
  canTurnOnLinks,
  ensureLinkedEnvironmentsOn,
  peerLinkEnvironment,
  useLinkableMachines,
  useLinkBackOffers,
  useLinkThroughRoutes,
} from "~/state/peerLinks";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { LinkExpiryMenu, LinkExpiryPicker } from "./LinkExpiryMenu";
import { LinkAddressWarning, LinkMachineSelect } from "./LinkMachineSelect";
import { LinkSeveralEnvironmentsAction } from "./LinkSeveralEnvironments";
import { defaultLinkLifetimeId, linkLifetime, type RenewLifetimeId } from "./sessionLifetime.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { m as resolveMessage } from "../../i18n/messages";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useSearchableSetting } from "./settingsSearch";

// Console log labels for the atom commands.
const UNLINK_COMMAND_LABEL = "unlink environment";
const LINK_COMMAND_LABEL = "link environment";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkedEnvironmentsSettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId, input: {} }),
    useMessages(),
  );
  // Links made outside this client bump nothing the shared list reads, so showing the panel
  // asks again. Listing probes every linked environment, too costly for a timer nobody asked for.
  // A list still loading counts as read now, so the next return to the window asks again.
  useLiveRefresh(
    () => {
      if (!links.isPending) links.refresh();
    },
    {
      key: `linked-environments:${environmentId}`,
      intervalMs: null,
      refreshOnShow: true,
    },
  );
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const search = searchableSetting("linked-environments");
  // A batch needs at least two other machines this app has saved.
  const otherMachines = useEnvironments().environments.length - 1;
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={
        canLink ? (
          <div className="flex items-center gap-2">
            {otherMachines > 1 ? (
              <LinkSeveralEnvironmentsAction environmentId={environmentId} />
            ) : null}
            <LinkEnvironmentAction environmentId={environmentId} />
          </div>
        ) : null
      }
    >
      {links.error ? (
        <SettingsRow title={gt("Could not load linked environments")} description={links.error} />
      ) : !links.data ? (
        <SettingsRow title={gt("Loading linked environments…")} role="status" />
      ) : links.data.links.length === 0 ? (
        <SettingsRow
          title={gt("No linked environments")}
          description={gt(
            "Link another machine running T3 Code, such as a VPS, so agents here can launch and drive threads there.",
          )}
        />
      ) : (
        links.data.links.map((link) => (
          <LinkedEnvironmentRow
            key={link.environmentId}
            environmentId={environmentId}
            link={link}
          />
        ))
      )}
    </SettingsSection>
  );
}

function LinkedEnvironmentRow({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const { busy, forget } = useForgetPeerLink(environmentId, link);
  const status = peerLinkStatusText(health, gt, isNeverExpiring(link.expiresAt));
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={status}
              dotClassName={
                health.kind === "reachable"
                  ? health.expiresInDays === null
                    ? "bg-success"
                    : "bg-warning"
                  : health.kind === "expired" || health.kind === "failing"
                    ? "bg-destructive"
                    : "bg-muted-foreground/30"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {m(accessConfig[link.access].label)} · {status}
          </p>
          <p className="truncate text-xs text-muted-foreground/80">{link.urls.join(", ")}</p>
        </div>
        {canUnlink ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <LinkExpiryMenu environmentId={environmentId} link={link} disabled={busy} />
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void forget()}
            >
              {busy ? gt("Forgetting…") : gt("Forget")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinkEnvironmentAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <LinkEnvironmentDialog
      environmentId={environmentId}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              {gt("Link", { $context: "verb, links an environment" })}
            </Button>
          }
        />
      }
    />
  );
}

/** What the link dialog opens with when something other than its own button opened it. */
export interface LinkEnvironmentPrefill {
  /** The machine to link to, by environment id, or `ANOTHER_ADDRESS` with `address`. */
  readonly choice: string | null;
  readonly address?: string;
  /**
   * With `address`: the machine there, and one of this app's that links to it at full access and
   * so can get the pairing code from it.
   */
  readonly through?: {
    readonly viaEnvironmentId: EnvironmentId;
    readonly environmentId: EnvironmentId;
    readonly label: string;
  };
  /** The picked machine already links here: this link is the way back. */
  readonly linkingBack?: true;
}

/**
 * The one link flow. When this client is connected to the picked machine and may create pairing
 * links there, it mints the code itself; otherwise it asks for one.
 */
export function LinkEnvironmentDialog({
  environmentId,
  open,
  onOpenChange,
  trigger = null,
  prefill,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger?: ReactNode;
  readonly prefill?: LinkEnvironmentPrefill;
}) {
  const gt = useGT();
  const m = useMessages();
  const setOpen = onOpenChange;
  // Named in the title: from the map, nothing else on screen says which machine is linking.
  const source = useEnvironment(environmentId);
  const saved = useLinkableMachines(environmentId, open);
  const routes = useLinkThroughRoutes(environmentId, open);
  // Machines this app has no entry for are still pickable when one of its environments links
  // to them at full access.
  const machines = [
    ...saved,
    ...[...routes.values()]
      .filter((route) => saved.every((machine) => machine.environmentId !== route.environmentId))
      .map((route) => ({
        environmentId: route.environmentId,
        label: route.label,
        machine: "server" as const,
        connected: false,
        connectOnly: false,
        linked: false,
        urls: route.urls,
      })),
  ];
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(prefill?.choice ?? null);
  const [address, setAddress] = useState(prefill?.address ?? "");
  const [pairingCode, setPairingCode] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: LINK_COMMAND_LABEL });
  const linkOnTarget = useAtomCommand(peerLinkEnvironment.link, {
    label: "link environment back",
    // The failure cause holds the request, and with it the code; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const pairThrough = useAtomCommand(peerLinkEnvironment.pairLink, {
    label: "pair link through a linked environment",
    // The answer is a credential; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  // Machines that would not give a code through a link, so the dialog asks for one instead.
  const [throughFailed, setThroughFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const [alsoLinkBack, setAlsoLinkBack] = useState(false);
  const [alsoInvite, setAlsoInvite] = useState(false);
  // Machines whose server kept the default lifetime for a code minted in this submit.
  const dropped = useRef(new Set<EnvironmentId>());
  const onLifetimeDropped = (id: EnvironmentId) => {
    dropped.current.add(id);
  };
  // Null until picked: a link being made again starts at how long it lasts now.
  const [lifetimeChoice, setLifetimeChoice] = useState<RenewLifetimeId | null>(null);
  const nowMinute = useNowMinute();
  const sourceLinks = useEnvironmentQuery(
    open ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  // Only for the machine the dialog opened for: another choice or address is another machine.
  const prefilledThrough =
    prefill?.through !== undefined &&
    selected === ANOTHER_ADDRESS &&
    address === (prefill.address ?? "")
      ? prefill.through
      : null;
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  // A picked machine that left the list has no address here either.
  const needsAddress = selected !== null && (machine === null || machine.urls.length === 0);
  // This client mints a code there when it is connected with a session that may
  // create pairing links, and only for its own addresses: anything can answer
  // as that machine at one typed in, so that one gets a code the user fetched.
  const canMint =
    targetId !== null &&
    !needsAddress &&
    Option.isSome(connected) &&
    mayMint &&
    !mintFailed.has(targetId);
  // Minting with this client's own session there comes first: it needs no third machine.
  const throughCandidate =
    prefilledThrough ?? (targetId === null || canMint ? null : (routes.get(targetId) ?? null));
  const via = useEnvironment(throughCandidate?.viaEnvironmentId ?? null);
  // The environment holding the link refuses a level this client's session there does not hold.
  const mayPairThrough = useAtomValue(
    peerLinkEnvironment.pairLink.permissionAtom(
      throughCandidate?.viaEnvironmentId ?? null,
      throughCandidate === null
        ? undefined
        : { environmentId: throughCandidate.environmentId, access },
    ),
  );
  const through =
    throughCandidate !== null &&
    via !== null &&
    mayPairThrough &&
    !throughFailed.has(throughCandidate.environmentId)
      ? throughCandidate
      : null;
  const linkBack = useLinkBackOffers(environmentId, targetId === null ? [] : [targetId], open);
  const backOffer = linkBack.offerFor(targetId);
  // A pasted code carries its own lifetime, and a code got through a link carries none. Until
  // the source's links are read, a link it holds there may never expire: no default yet.
  const existing =
    sourceLinks.data === null
      ? undefined
      : (sourceLinks.data.links.find(
          (entry) => entry.environmentId === targetId && entry.status !== "expired",
        ) ?? null);
  const lifetimeId =
    lifetimeChoice ??
    defaultLinkLifetimeId(
      existing === undefined || existing === null
        ? existing
        : DateTime.toEpochMillis(existing.expiresAt),
      DateTime.toEpochMillis(DateTime.makeUnsafe(nowMinute)),
    );
  const lifetime = canMint && lifetimeId !== null ? linkLifetime(lifetimeId) : undefined;
  const sourceSettingsWritable = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const target = useEnvironment(targetId);
  const targetSettingsWritable = useEnvironmentScope(targetId, AuthSettingsWriteScope);
  // Both ends need Linked environments on: one to hold the link, the other to accept it. A typed
  // address may be another machine, so only one of this app's own addresses names the target.
  const turnsOnSource =
    source !== null && canTurnOnLinks(source.serverConfig, sourceSettingsWritable);
  const turnsOnTarget =
    target !== null && !needsAddress && canTurnOnLinks(target.serverConfig, targetSettingsWritable);
  const turnsOn = [
    ...(turnsOnSource ? [source.label] : []),
    ...(turnsOnTarget ? [target.label] : []),
  ];
  const locale = useLocale();
  const sourceWritable = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const sourceConnection = usePreparedConnection(environmentId);
  const reverse = linkBack.reverseFor(targetId);
  const linkingBack = prefill?.linkingBack === true && selected === prefill.choice;
  // An app's code gives full use of the machine it joins, so it pairs only with a full-access
  // link from the app's machine to that one: in a link back, this link; otherwise the way back.
  const invite =
    machine === null || source === null || access !== "full-access" || !sourceWritable || !mayMint
      ? null
      : linkingBack
        ? {
            host: {
              environmentId: machine.environmentId,
              label: machine.label,
              urls: machine.urls,
            },
            app: { environmentId, label: source.label },
            connection: sourceConnection,
          }
        : linkBack.source !== null &&
            ((alsoLinkBack && backOffer.kind === "offered") || reverse?.access === "full-access")
          ? {
              host: { environmentId, label: source.label, urls: linkBack.source.urls },
              app: { environmentId: machine.environmentId, label: machine.label },
              connection: connected,
            }
          : null;
  // The code travels to the app's machine over this app's connection there.
  const inviteSendable =
    invite !== null &&
    carriesCredentialsSafely(Option.getOrNull(invite.connection)?.httpBaseUrl ?? "");
  const ready =
    through !== null ||
    (selected !== null &&
      (!needsAddress || address.trim().length > 0) &&
      (canMint ? lifetimeId !== null : pairingCode.trim().length > 0));
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(prefill?.choice ?? null);
      setAddress(prefill?.address ?? "");
      setPairingCode("");
      setAccess("approval-required");
      setMintFailed(new Set());
      setThroughFailed(new Set());
      setAlsoLinkBack(false);
      setAlsoInvite(false);
      setLifetimeChoice(null);
    }
  };
  // Settles to what to link with, or null after reporting why the linked machine gave no code.
  const resolveThrough = async (target: NonNullable<typeof through>) => {
    const asked = await pairThrough({
      environmentId: target.viaEnvironmentId,
      input: { environmentId: target.environmentId, access },
    });
    if (asked._tag === "Success" && asked.value.type === "credential") {
      const [url, ...alternateUrls] = asked.value.urls;
      if (url !== undefined) {
        return {
          url,
          ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
          expectedEnvironmentId: asked.value.environmentId,
          expectedLabel: asked.value.label,
          pairingCode: asked.value.credential,
        };
      }
    }
    if (asked._tag === "Failure" && isAtomCommandInterrupted(asked)) return null;
    setThroughFailed((failed) => new Set(failed).add(target.environmentId));
    failureToast(
      gt("{via} could not get a pairing code from {target}", {
        via: via?.label ?? "",
        target: target.label,
      }),
      gt("Enter its address and a pairing code from it instead."),
    );
    return null;
  };
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId, access, lifetime, onLifetimeDropped);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast(
      gt("Could not link the environment"),
      linkRequestFailureMessage(minted.failure, resolveMessage),
    );
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    dropped.current.clear();
    if (turnsOnSource) await ensureLinkedEnvironmentsOn(environmentId);
    if (turnsOnTarget && targetId !== null) await ensureLinkedEnvironmentsOn(targetId);
    const throughInput = through === null ? null : await resolveThrough(through);
    const code = through === null ? await resolvePairingCode() : null;
    const result =
      through !== null
        ? throughInput === null
          ? null
          : await link({ environmentId, input: { ...throughInput, access } })
        : code === null
          ? null
          : await link({
              environmentId,
              input: {
                url,
                ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
                // A typed address links alone: only this app's own addresses name a machine.
                ...(machine === null || needsAddress
                  ? {}
                  : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
                pairingCode: code,
                access,
              },
            });
    // The link back is its own link, made on the other machine: it never undoes this one.
    const back =
      result?._tag === "Success" &&
      alsoLinkBack &&
      backOffer.kind === "offered" &&
      linkBack.source !== null &&
      targetId !== null &&
      // A typed address can answer as another machine: the picked one links back only if it did.
      result.value.environmentId === targetId
        ? await linkWithMintedCode({
            machine: linkBack.source,
            access,
            mint: (id, level) => mintPairingCodeOn(id, level, lifetime, onLifetimeDropped),
            link: async (input) => {
              const reverse = await linkOnTarget({ environmentId: targetId, input });
              return reverse._tag === "Success"
                ? Result.succeed(reverse.value)
                : Result.fail(squashAtomCommandFailure(reverse));
            },
          })
        : null;
    const invited =
      result?._tag === "Success" &&
      alsoInvite &&
      invite !== null &&
      inviteSendable &&
      result.value.environmentId === machine?.environmentId &&
      (linkingBack || back?.kind === "linked" || reverse?.access === "full-access")
        ? await inviteDesktopAppTo({
            host: invite.host,
            app: invite.app,
            appLinkAccess:
              linkingBack || back?.kind === "linked" ? access : (reverse?.access ?? access),
            lifetime,
            codeLabel: gt("App for {label}", { label: invite.app.label }),
          })
        : null;
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      const names = { source: source?.label ?? "", target: result.value.label };
      toastManager.add({
        type: "success",
        title:
          back?.kind === "linked"
            ? gt("Linked {source} and {target} both ways", names)
            : gt("Linked {label}", { label: result.value.label }),
      });
      if (back?.kind === "failed") {
        failureToast(
          gt("Could not link {target} back to {source}", names),
          back.detail ?? linkBatchFailureLabel(back.failure, m),
        );
      }
      const inviteNames = {
        source: invite?.host.label ?? "",
        target: invite?.app.label ?? "",
      };
      if (invited?.kind === "invited") {
        toastManager.add({
          type: "success",
          title: gt("Invited the desktop app on {target} to connect to {source}", inviteNames),
        });
      } else if (invited !== null) {
        failureToast(
          gt("Could not invite the desktop app on {target}", inviteNames),
          invited.kind === "skipped"
            ? invited.reason === "not_full_access"
              ? gt("Only with full access")
              : gt("Needs an https or Tailscale address")
            : invited.failure === "unsupported"
              ? gt("That machine runs an older T3 Code")
              : invited.failure === "no_code"
                ? linkBatchFailureLabel("no_code", m)
                : gt("Check that this app is signed in there with access management."),
        );
      }
      for (const id of dropped.current) {
        toastManager.add({
          type: "warning",
          title: gt("{host} runs an older T3 Code", {
            host: (id === environmentId ? source?.label : machine?.label) ?? "",
          }),
          description: gt("It ignored the expiry, so the link lasts the default 30 days."),
        });
      }
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not link the environment"), String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      {trigger}
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {source === null ? (
              <T>Link an environment</T>
            ) : through !== null ? (
              gt("Link {source} to {target}", { source: source.label, target: through.label })
            ) : machine === null ? (
              gt("Link {label} to another machine", { label: source.label })
            ) : (
              gt("Link {source} to {target}", { source: source.label, target: machine.label })
            )}
          </DialogTitle>
          <DialogDescription>
            <T>
              Agents here can then launch, message and wait on threads there. It appears under
              Authorized clients in that environment's Sharing & access, where it can be revoked.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 && (through === null || through !== prefilledThrough) ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={(next) => {
                  // The opt-ins name one machine: they do not carry over to another.
                  if (next !== selected) {
                    setAlsoLinkBack(false);
                    setAlsoInvite(false);
                    setLifetimeChoice(null);
                  }
                  setChoice(next);
                }}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                <T>Already linked. Linking again renews it with the access you pick.</T>
              </p>
            ) : null}
            {through !== null ? (
              <p className="text-xs text-muted-foreground">
                {gt(
                  "{via} links to {target} at full access, so it gets the pairing code. No code to paste.",
                  { via: via?.label ?? "", target: through.label },
                )}
              </p>
            ) : null}
            {needsAddress && through === null ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Address</T>
                </span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      This app has no address for <Var>{machine.label}</Var> that another machine
                      can reach. Enter its https or Tailscale address.
                    </T>
                  </span>
                ) : null}
              </label>
            ) : null}
            {needsAddress && through === null && address.trim() ? (
              <LinkAddressWarning address={address} />
            ) : null}
            {selected === null || canMint || through !== null ? null : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">
                  <T>Pairing code</T>
                </span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null
                      ? gt("From Sharing & access there, or t3 pair")
                      : gt("Paste the code")
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    <T>
                      Create a link on <Var>{machine.label}</Var>: Settings → Sharing & access →
                      Authorized clients → Create link, then paste its code here.
                    </T>
                  </span>
                ) : null}
              </label>
            )}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
            {canMint ? (
              <LinkExpiryPicker
                value={lifetimeId}
                onChange={setLifetimeChoice}
                disabled={busy || (sourceLinks.data === null && sourceLinks.error === null)}
              />
            ) : null}
            {turnsOn.length > 0 ||
            invite !== null ||
            (machine !== null &&
              source !== null &&
              (backOffer.kind === "offered" || backOffer.kind === "blocked")) ? (
              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-xs font-medium text-foreground">{gt("Both ways")}</p>
                {machine === null || source === null ? null : backOffer.kind === "offered" ? (
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm has-data-disabled:cursor-default">
                    <Checkbox
                      checked={alsoLinkBack}
                      disabled={busy}
                      onCheckedChange={setAlsoLinkBack}
                    />
                    <span className="min-w-0 space-y-0.5">
                      <span className="block font-medium text-foreground">
                        {gt("Also link {target} back to {source}", {
                          source: source.label,
                          target: machine.label,
                        })}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {gt("Agents on {target} can then work on {source} too.", {
                          source: source.label,
                          target: machine.label,
                        })}
                      </span>
                    </span>
                  </label>
                ) : backOffer.kind === "blocked" ? (
                  <p className="text-xs text-muted-foreground">
                    {linkBackBlockLabel(
                      backOffer.reason,
                      { source: source.label, target: machine.label },
                      m,
                    )}
                  </p>
                ) : null}
                {invite !== null ? (
                  inviteSendable ? (
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm has-data-disabled:cursor-default">
                      <Checkbox
                        checked={alsoInvite}
                        disabled={busy}
                        onCheckedChange={setAlsoInvite}
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block font-medium text-foreground">
                          {gt("Invite {target}'s desktop app", { target: invite.app.label })}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {gt("It adds {source} to its environments within a day.", {
                            source: invite.host.label,
                          })}
                        </span>
                      </span>
                    </label>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {gt(
                        "This app connects to {label} over plain http, so it cannot invite the desktop app there.",
                        { label: invite.app.label },
                      )}
                    </p>
                  )
                ) : null}
                {turnsOn.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {gt("Turns on Linked environments on {label}.", {
                      label: new Intl.ListFormat(locale, { type: "conjunction" }).format(turnsOn),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? gt("Linking…") : gt("Link", { $context: "verb, links an environment" })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** What a link's health means for the user, in a sentence. */
export function peerLinkStatusText(
  health: PeerLinkHealth,
  gt: ReturnType<typeof useGT>,
  neverExpires = false,
): string {
  return health.kind === "expired"
    ? gt("Expired. Link it again with a new pairing code.")
    : health.kind === "unreachable"
      ? (health.detail ?? gt("Not answering right now."))
      : health.kind === "failing"
        ? health.detail
        : health.expiresInDays !== null
          ? gt(
              "{days, plural, one {Expires in {days} day. Link it again to renew.} other {Expires in {days} days. Link it again to renew.}}",
              { days: health.expiresInDays },
            )
          : neverExpires
            ? gt("Never expires")
            : gt("Reachable");
}

/** Forgets `link` from `environmentId` after the user confirms. */
export function useForgetPeerLink(environmentId: EnvironmentId, link: PeerLinkSummary) {
  const gt = useGT();
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: UNLINK_COMMAND_LABEL });
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      gt(
        "Forget {label}? Agents here stop working there, and their session on {label} ends too if it answers.",
        { label: link.label },
      ),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Success") {
      if (result.value.removed && result.value.endedThere !== true) {
        toastManager.add({
          type: "warning",
          title: gt("{label} did not answer", { label: link.label }),
          description: gt(
            "Revoke \"T3 Code · …\" in {label}''s Sharing & access to end the session there too.",
            { label: link.label },
          ),
        });
      }
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast(gt("Could not forget the link"), String(squashAtomCommandFailure(result)));
    }
  };
  return { busy, forget };
}
