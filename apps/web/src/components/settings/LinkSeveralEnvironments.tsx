import {
  linkBatchBlockLabel,
  linkBatchCandidates,
  linkBatchFailureLabel,
  type LinkBatchOutcome,
  linkBatchSummary,
  linkListState,
  runLinkBatch,
} from "@t3tools/client-runtime/link-batch";
import type { BothWaysOutcome, BothWaysStep } from "@t3tools/client-runtime/link-both-ways";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import { T, useGT, useMessages } from "gt-react";
import { useId, useRef, useState } from "react";

import { useEnvironments } from "~/state/environments";
import { refreshPeerLinkLists } from "~/state/bothWays";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
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
} from "../ui/dialog";
import { BothWaysOption, BothWaysResults, useBothWaysRunner } from "./BothWays";
import { LinkAccessPicker } from "./LinkAccessPicker";
import {
  DEFAULT_LIFETIME_CHOICE,
  type LifetimeChoice,
  isLifetimeChoiceValid,
  summarizeBothWays,
} from "./sessionLifetime.logic";

const NO_MACHINES: ReadonlySet<EnvironmentId> = new Set();
const NO_OUTCOMES: ReadonlyMap<EnvironmentId, LinkBatchOutcome> = new Map();
const NO_STEPS: ReadonlyMap<EnvironmentId, ReadonlyMap<BothWaysStep, BothWaysOutcome>> = new Map();
// Each machine signs in to two others at once, so fewer run together than a plain batch.
const BOTH_WAYS_CONCURRENCY = 2;

export function LinkSeveralEnvironmentsAction({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <T>Link several…</T>
      </Button>
      <LinkSeveralEnvironmentsDialog
        environmentId={environmentId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * Links the machines this app already reaches in one go. Each pairing code is
 * minted on its machine and passed straight to the linking environment; none
 * is ever held in state, shown, or logged.
 */
export function LinkSeveralEnvironmentsDialog({
  environmentId,
  open,
  onOpenChange,
  preset,
  presetOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Machines picked before the dialog opened. Those a batch cannot link stay unticked. */
  readonly preset?: ReadonlyArray<EnvironmentId>;
  /** Lists only the `preset` machines: they were picked for this link, not as a suggestion. */
  readonly presetOnly?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const formId = useId();
  const sourceLabel = useEnvironments().environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.label;
  const known = useLinkableMachines(environmentId, open);
  const machines =
    presetOnly && preset !== undefined
      ? known.filter((machine) => preset.includes(machine.environmentId))
      : known;
  // The same shared list `useLinkableMachines` reads `linked` from.
  const links = useEnvironmentQuery(
    open ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const linksState = linkListState(links);
  const writable = useEnvironmentsWithScope(machines, AuthAccessWriteScope);
  const [selected, setSelected] = useState<ReadonlySet<EnvironmentId>>(() => new Set(preset));
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [outcomes, setOutcomes] = useState(NO_OUTCOMES);
  const [linking, setLinking] = useState(NO_MACHINES);
  const [bothWays, setBothWays] = useState(true);
  const [lifetime, setLifetime] = useState<LifetimeChoice>(DEFAULT_LIFETIME_CHOICE);
  const [steps, setSteps] = useState(NO_STEPS);
  const runBothWays = useBothWaysRunner();
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  // The failure cause holds the request, and with it the code; keep it out of the console.
  const link = useAtomCommand(peerLinkEnvironment.linkInBatch, {
    label: "link several environments",
    reportFailure: false,
    reportDefect: false,
  });
  const candidates = linkBatchCandidates(machines, writable, linksState);
  const selectable = candidates.flatMap(({ machine, blocked }) =>
    blocked === null && outcomes.get(machine.environmentId)?.kind !== "linked" ? [machine] : [],
  );
  const chosen = selectable.filter((machine) => selected.has(machine.environmentId));
  const busy = linking.size > 0;
  const summary = linkBatchSummary(outcomes);
  // Picked on the map, but only another machine's link names them: this app has no session there.
  const unlisted = (preset ?? []).filter(
    (id) => !candidates.some(({ machine }) => machine.environmentId === id),
  ).length;

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setSelected(NO_MACHINES);
      setOutcomes(NO_OUTCOMES);
      setAccess("approval-required");
      setBothWays(true);
      setLifetime(DEFAULT_LIFETIME_CHOICE);
      setSteps(NO_STEPS);
    }
  };
  const toggle = (id: EnvironmentId, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const finishOne = (id: EnvironmentId, outcome: LinkBatchOutcome) => {
    setOutcomes((current) => new Map(current).set(id, outcome));
    setLinking((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  const submitBothWays = async () => {
    const results = new Map<EnvironmentId, LinkBatchOutcome>();
    const queue = [...chosen];
    const worker = async () => {
      for (let machine = queue.shift(); machine !== undefined; machine = queue.shift()) {
        const id = machine.environmentId;
        const stepOutcomes = await runBothWays({
          a: environmentId,
          b: id,
          aLinksToB: false,
          access,
          lifetime,
          batch: true,
          ...(steps.has(id) ? { previous: steps.get(id)! } : {}),
        });
        const outcome: LinkBatchOutcome =
          stepOutcomes !== null && summarizeBothWays(stepOutcomes).complete
            ? { kind: "linked" }
            : { kind: "failed", failure: "other", detail: null };
        if (stepOutcomes !== null) setSteps((current) => new Map(current).set(id, stepOutcomes));
        results.set(id, outcome);
        finishOne(id, outcome);
      }
    };
    await Promise.all(Array.from({ length: BOTH_WAYS_CONCURRENCY }, worker));
    // Listing probes every link, so each machine's list is read once, after the batch.
    refreshPeerLinkLists([environmentId, ...results.keys()]);
    return results;
  };
  const submit = async () => {
    if (inFlight.current || chosen.length === 0) return;
    if (bothWays && !isLifetimeChoiceValid(lifetime)) return;
    inFlight.current = true;
    setLinking(new Set(chosen.map((machine) => machine.environmentId)));
    const results = bothWays
      ? await submitBothWays()
      : await runLinkBatch({
          machines: chosen,
          access,
          mint: mintPairingCodeOn,
          link: async (input) => {
            const result = await link({ environmentId, input });
            return result._tag === "Success"
              ? Result.succeed(result.value)
              : Result.fail(squashAtomCommandFailure(result));
          },
          refreshLinks: links.refresh,
          onOutcome: finishOne,
        });
    inFlight.current = false;
    setLinking(NO_MACHINES);
    // What failed stays picked, so linking again retries only those.
    setSelected(new Set(linkBatchSummary(results).failed));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {sourceLabel === undefined
              ? gt("Link several environments")
              : gt("Link several machines from {source}", { source: sourceLabel })}
          </DialogTitle>
          <DialogDescription>
            <T>
              Agents here can then launch, message and wait on threads on each machine you pick.
              Each appears under Authorized clients in that machine's Sharing & access, where it can
              be revoked.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {presetOnly ? (
                  <T>This app is not connected to any of the machines you picked.</T>
                ) : (
                  <T>This app knows no other machines. Add them under Environments first.</T>
                )}
              </p>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-foreground">
                    <T>Machines</T>
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={busy || selectable.length === 0}
                    onClick={() =>
                      setSelected(
                        chosen.length === selectable.length
                          ? NO_MACHINES
                          : new Set(selectable.map((machine) => machine.environmentId)),
                      )
                    }
                  >
                    {chosen.length === selectable.length && selectable.length > 0
                      ? gt("Select none")
                      : gt("Select all")}
                  </Button>
                </div>
                {linksState === "loaded" ? null : (
                  <div
                    role="status"
                    className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                  >
                    {linksState === "loading" ? (
                      <T>Checking which machines are already linked…</T>
                    ) : (
                      <>
                        <span className="text-destructive">
                          {gt(
                            "Could not check which machines are already linked, so none can be picked: {error}",
                            { error: links.error ?? "" },
                          )}
                        </span>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={links.isPending}
                          onClick={links.refresh}
                        >
                          <T>Retry</T>
                        </Button>
                      </>
                    )}
                  </div>
                )}
                <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
                  {candidates.map(({ machine, blocked }) => {
                    const id = machine.environmentId;
                    const outcome = outcomes.get(id);
                    const available = blocked === null && outcome?.kind !== "linked";
                    const status = linking.has(id)
                      ? gt("Linking…")
                      : outcome?.kind === "linked"
                        ? gt("Linked", { $context: "status of a machine that was just linked" })
                        : outcome?.kind === "failed"
                          ? linkBatchFailureLabel(outcome.failure, m)
                          : blocked === null
                            ? null
                            : linkBatchBlockLabel(blocked, m);
                    return (
                      <li key={id}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm has-data-disabled:cursor-default">
                          <Checkbox
                            checked={available && selected.has(id)}
                            disabled={busy || !available}
                            onCheckedChange={(checked) => toggle(id, checked)}
                          />
                          <EnvironmentMachineIcon
                            kind={machine.machine}
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{machine.label}</span>
                            {steps.has(id) &&
                            (outcome?.kind === "failed" ||
                              summarizeBothWays(steps.get(id)!).lifetimeIgnored) ? (
                              <BothWaysResults
                                outcomes={steps.get(id)!}
                                aLabel={sourceLabel ?? environmentId}
                                bLabel={machine.label}
                              />
                            ) : outcome?.kind === "failed" && outcome.detail !== null ? (
                              <span className="block text-xs text-destructive">
                                {outcome.detail}
                              </span>
                            ) : null}
                          </span>
                          {status === null ? null : (
                            <span
                              className={
                                outcome?.kind === "failed"
                                  ? "shrink-0 text-xs text-destructive"
                                  : "shrink-0 text-xs text-muted-foreground"
                              }
                            >
                              {status}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {unlisted > 0 ? (
              <p className="text-xs text-muted-foreground">
                {gt(
                  "{count, plural, one {# machine needs a pairing code, so it is not listed.} other {# machines need a pairing code, so they are not listed.}}",
                  { count: unlisted },
                )}
              </p>
            ) : null}
            {outcomes.size > 0 && !busy ? (
              <p role="status" className="text-xs text-muted-foreground">
                {summary.failed.length === 0
                  ? gt("{linked, plural, one {Linked # machine.} other {Linked # machines.}}", {
                      linked: summary.linked,
                    })
                  : gt(
                      "Linked {linked} of {total}. The ones that failed stay selected, so you can try them again.",
                      { linked: summary.linked, total: outcomes.size },
                    )}
              </p>
            ) : null}
            <LinkAccessPicker
              value={access}
              onChange={(next) => {
                setAccess(next);
                // Earlier steps ran with the old access, so a retry starts over.
                setSteps(NO_STEPS);
              }}
              disabled={busy}
            />
            <BothWaysOption
              checked={bothWays}
              onCheckedChange={setBothWays}
              lifetime={lifetime}
              onLifetimeChange={(next) => {
                setLifetime(next);
                setSteps(NO_STEPS);
              }}
              disabled={busy}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            {outcomes.size > 0 ? gt("Done") : gt("Cancel")}
          </DialogClose>
          {outcomes.size > 0 && !busy && chosen.length === 0 ? null : (
            <Button
              form={formId}
              type="submit"
              disabled={
                busy || chosen.length === 0 || (bothWays && !isLifetimeChoiceValid(lifetime))
              }
            >
              {busy
                ? gt("Linking…")
                : gt("{count, plural, one {Link # machine} other {Link # machines}}", {
                    count: chosen.length,
                  })}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
