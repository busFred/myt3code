import {
  createMcpApprovalCodeCommand,
  createPeerLinkCodeCommand,
} from "@t3tools/client-runtime/state/peerPairingCode";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AuthMcpClientAccess,
  AuthPairingCredentialResult,
  AuthSessionLifetime,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const mintPairingCode = createPeerLinkCodeCommand(connectionAtomRuntime);
const mintMcpApprovalCode = createMcpApprovalCodeCommand(connectionAtomRuntime);

/**
 * A fresh link code minted on `environmentId` with this client's session there, at `access`
 * for `lifetime` (absent: that server's default). `onLifetimeDropped` hears of a server too
 * old to keep the lifetime. Fails with `PeerPairingCodeError` when the session may not mint.
 */
export async function mintPairingCodeOn(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
  lifetime?: AuthSessionLifetime,
  onLifetimeDropped?: (environmentId: EnvironmentId) => void,
): Promise<Result.Result<string, unknown>> {
  const result = await runAtomCommand(
    appAtomRegistry,
    mintPairingCode,
    { environmentId, input: { access, ...(lifetime === undefined ? {} : { lifetime }) } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") return Result.fail(squashAtomCommandFailure(result));
  if (result.value.lifetimeDropped) onLifetimeDropped?.(environmentId);
  return Result.succeed(result.value.credential);
}

/** A fresh code on `environmentId` that approves one app's sign-in at `access`. */
export async function mintMcpApprovalCodeOn(
  environmentId: EnvironmentId,
  access: AuthMcpClientAccess,
): Promise<Result.Result<AuthPairingCredentialResult, unknown>> {
  const result = await runAtomCommand(
    appAtomRegistry,
    mintMcpApprovalCode,
    { environmentId, input: access },
    { reportFailure: false },
  );
  return result._tag === "Success"
    ? Result.succeed(result.value)
    : Result.fail(squashAtomCommandFailure(result));
}
