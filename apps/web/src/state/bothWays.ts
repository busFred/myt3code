import {
  type BothWaysOps,
  type BothWaysSide,
  type BothWaysStep,
  type BothWaysOutcome,
  runLinkBothWays,
  runRenewBothWays,
} from "@t3tools/client-runtime/link-both-ways";
import { linkableMachines } from "@t3tools/client-runtime/link-request";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AuthMcpClientAccess,
  AuthSessionId,
  AuthSessionLifetime,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import { isMissingEndpointFailure } from "../components/settings/sessionLifetime.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { authEnvironment } from "./auth";
import { readEnvironment } from "./environments";
import { peerLinkEnvironment } from "./peerLinks";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";
import { waitForAtomValue } from "./waitForAtomValue";

type Relays = Parameters<typeof linkableMachines>[0]["connect"];

const run = async <W, A, E>(
  command: Parameters<typeof runAtomCommand<W, A, E>>[1],
  input: W,
): Promise<Result.Result<A, unknown>> => {
  const result = await runAtomCommand(appAtomRegistry, command, input, {
    reportFailure: false,
    reportDefect: false,
  });
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
};

const PEER_LINK_CODE_LABEL = "T3 Code link";

/**
 * Each op runs with this client's own session on the environment it names. Links go over HTTP,
 * which keeps a link the environment has; a server without it is reported as older, since its
 * socket link would replace one. In a batch a link leaves the lists alone, and the batch
 * refreshes each once when it ends.
 */
const bothWaysOps = (
  appCodeLabel: (environmentLabel: string) => string,
  batch: boolean,
): BothWaysOps => ({
  enableLinks: (environmentId) =>
    run(serverEnvironment.updateSettings, {
      environmentId,
      input: { patch: { linkedEnvironmentsEnabled: true } },
    }),
  mintLinkCode: async (environmentId, input) => {
    const minted = await run(authEnvironment.createPairingCredential, {
      environmentId,
      input: {
        label: PEER_LINK_CODE_LABEL,
        access: input.access,
        purpose: "peer-link",
        ...(input.lifetime === undefined ? {} : { lifetime: input.lifetime }),
      },
    });
    // A server that predates peer-link codes answers with a plain code, which must not be used.
    if (
      Result.isSuccess(minted) &&
      (minted.success.purpose !== "peer-link" || minted.success.access !== input.access)
    ) {
      await run(authEnvironment.revokePairingLink, {
        environmentId,
        input: { id: minted.success.id },
      });
      return Result.fail(new Error("The environment did not issue a peer-link code."));
    }
    return minted;
  },
  link: async (environmentId, input) => {
    const linked = await run(authEnvironment.linkPeer, { environmentId, input });
    if (Result.isFailure(linked)) {
      return Result.fail(linked.failure);
    }
    if (!batch && !linked.success.alreadyLinked) refreshPeerLinkLists([environmentId]);
    return Result.succeed({
      alreadyLinked: linked.success.alreadyLinked,
      access: linked.success.link.access,
    });
  },
  mintAppCode: (environmentId, input) =>
    run(authEnvironment.createPairingCredential, {
      environmentId,
      input: {
        label: appCodeLabel(input.appEnvironment.label),
        linkTtlMillis: input.linkTtlMillis,
        ...(input.lifetime === undefined ? {} : { lifetime: input.lifetime }),
      },
    }),
  revokeCode: (environmentId, id) =>
    run(authEnvironment.revokePairingLink, { environmentId, input: { id } }),
  createInvite: (environmentId, input) =>
    run(authEnvironment.createAppInvite, { environmentId, input }),
  isUnsupported: isMissingEndpointFailure,
});

/** One of the two machines as `runLinkBothWays` wants it, urls being how `other` reaches it. */
export function bothWaysSide(input: {
  readonly environmentId: EnvironmentId;
  readonly other: EnvironmentId;
  readonly relays: Relays;
}): BothWaysSide | null {
  const environment = readEnvironment(input.environmentId);
  if (environment === null) return null;
  const urls =
    linkableMachines({
      environments: [environment],
      threadEnvironmentId: input.other,
      links: [],
      connect: input.relays,
    }).find((machine) => machine.environmentId === input.environmentId)?.urls ?? [];
  return {
    environmentId: input.environmentId,
    label: environment.label,
    urls,
    linkedEnvironmentsEnabled:
      environment.serverConfig?.settings.linkedEnvironmentsEnabled === true,
  };
}

export function linkEnvironmentsBothWays(input: {
  readonly a: BothWaysSide;
  readonly b: BothWaysSide;
  readonly access: AuthMcpClientAccess;
  readonly lifetime: AuthSessionLifetime | undefined;
  readonly invite: boolean;
  readonly batch: boolean;
  readonly appCodeLabel: (environmentLabel: string) => string;
}): Promise<ReadonlyMap<BothWaysStep, BothWaysOutcome>> {
  return runLinkBothWays({
    a: input.a,
    b: input.b,
    access: input.access,
    ...(input.lifetime === undefined ? {} : { lifetime: input.lifetime }),
    invite: input.invite,
    ops: bothWaysOps(input.appCodeLabel, input.batch),
  });
}

/** Lists each environment's links again, once, as a batch does when it ends. */
export function refreshPeerLinkLists(environmentIds: Iterable<EnvironmentId>) {
  for (const environmentId of new Set(environmentIds)) {
    appAtomRegistry.refresh(peerLinkEnvironment.list({ environmentId, input: {} }));
  }
}

/**
 * Has each side ask the other when its link there now ends, so a renewal made there shows here.
 * Best effort: an older server answers 404 and keeps the expiry it knew.
 */
export async function refreshLinkExpiries(a: EnvironmentId, b: EnvironmentId) {
  await Promise.all([
    run(authEnvironment.refreshPeerLinkExpiry, { environmentId: a, input: { environmentId: b } }),
    run(authEnvironment.refreshPeerLinkExpiry, { environmentId: b, input: { environmentId: a } }),
  ]);
  refreshPeerLinkLists([a, b]);
}

/** Lists the links `environmentId` holds, for finding the session its link to another has there. */
export async function readPeerLinks(environmentId: EnvironmentId) {
  const result = await run(peerLinkEnvironment.listNow, { environmentId, input: {} });
  return Result.isSuccess(result) ? result.success.links : null;
}

export function renewLinksBothWays(input: {
  readonly a: Parameters<typeof runRenewBothWays>[0]["a"];
  readonly b: Parameters<typeof runRenewBothWays>[0]["b"];
  readonly lifetime: AuthSessionLifetime;
}) {
  return runRenewBothWays({
    ...input,
    ops: {
      renew: (environmentId, sessionId: AuthSessionId, lifetime, expectedSubject) =>
        run(authEnvironment.renewClient, {
          environmentId,
          input: { sessionId, lifetime, ...(expectedSubject ? { expectedSubject } : {}) },
        }),
      isUnsupported: isMissingEndpointFailure,
    },
  });
}

const SESSION_WAIT_MS = 20_000;

/** Whether a freshly added environment's session loaded in time, so its scopes can be read. */
export const waitForEnvironmentSession = (environmentId: EnvironmentId) =>
  waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentSession.sessionStateAtom(environmentId),
    predicate: (state) => state._tag === "Success",
    timeoutMs: SESSION_WAIT_MS,
  });
