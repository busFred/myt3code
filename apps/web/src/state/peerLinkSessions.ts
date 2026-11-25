import { type AppInviteOutcome, inviteDesktopApp } from "@t3tools/client-runtime/app-invite";
import { type LinkExpiryOutcome, renewPeerLink } from "@t3tools/client-runtime/link-expiry";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AuthMcpClientAccess,
  AuthSessionLifetime,
  EnvironmentId,
  PeerLinkSummary,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import { isMissingEndpointFailure } from "../components/settings/sessionLifetime.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { authEnvironment } from "./auth";
import { peerLinkEnvironment } from "./peerLinks";

// The failure cause can hold the request, and with it a pairing code; keep it out of the console.
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

/** Invites the desktop app on `app` to connect to `host`, with this client's sessions on both. */
export function inviteDesktopAppTo(input: {
  readonly host: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly urls: ReadonlyArray<string>;
  };
  readonly app: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly appLinkAccess: AuthMcpClientAccess;
  readonly lifetime: AuthSessionLifetime | undefined;
  /** The name the pairing code gets on `host`. */
  readonly codeLabel: string;
}): Promise<AppInviteOutcome> {
  return inviteDesktopApp({
    host: input.host,
    app: input.app,
    appLinkAccess: input.appLinkAccess,
    ...(input.lifetime === undefined ? {} : { lifetime: input.lifetime }),
    ops: {
      mintAppCode: (environmentId, mint) =>
        run(authEnvironment.createPairingCredential, {
          environmentId,
          input: {
            label: input.codeLabel,
            linkTtlMillis: mint.linkTtlMillis,
            ...(mint.lifetime === undefined ? {} : { lifetime: mint.lifetime }),
          },
        }),
      createInvite: (environmentId, invite) =>
        run(authEnvironment.createAppInvite, { environmentId, input: invite }),
      revokeCode: (environmentId, id) =>
        run(authEnvironment.revokePairingLink, { environmentId, input: { id } }),
      isUnsupported: isMissingEndpointFailure,
    },
  });
}

/**
 * Gives `link`, held by `sourceId`, a new lifetime on the machine it reaches, then has the source
 * ask that machine when it now ends, so the new expiry shows. That second step is best effort: an
 * older source answers 404 and shows the new expiry on its next call there.
 */
export async function setPeerLinkExpiry(
  sourceId: EnvironmentId,
  link: Pick<PeerLinkSummary, "environmentId" | "peerSessionId">,
  lifetime: AuthSessionLifetime,
): Promise<LinkExpiryOutcome> {
  const outcome = await renewPeerLink({
    link,
    lifetime,
    ops: {
      renew: (environmentId, input) => run(authEnvironment.renewClient, { environmentId, input }),
      isUnsupported: isMissingEndpointFailure,
    },
  });
  if (outcome.kind === "done") {
    await run(authEnvironment.refreshPeerLinkExpiry, {
      environmentId: sourceId,
      input: { environmentId: link.environmentId },
    });
    appAtomRegistry.refresh(peerLinkEnvironment.list({ environmentId: sourceId, input: {} }));
  }
  return outcome;
}
