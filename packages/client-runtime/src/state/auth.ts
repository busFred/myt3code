import type {
  AuthAccessSnapshot,
  AuthApproveConnectDeviceInput,
  AuthRevokeConnectDeviceInput,
  AuthAccessStreamEvent,
  AuthAccessStreamSnapshotEvent,
  AuthCreatePairingCredentialInput,
  AuthRevokeClientSessionInput,
  AuthRenewClientSessionInput,
  AuthCreateAppInviteInput,
  AuthRevokeAppInviteInput,
  AuthRefreshPeerLinkExpiryInput,
  AuthRevokePairingLinkInput,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { carriesCredentialsSafely } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { subscribe } from "../rpc/client.ts";
import { executeConnectedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

const ACCESS_REQUEST_TIMEOUT_MS = 8_000;

/** This client reaches the environment over plain http, which must not carry an invite's code. */
class AppInviteUnsafeConnectionError extends Schema.TaggedError<AppInviteUnsafeConnectionError>()(
  "AppInviteUnsafeConnectionError",
  {},
) {}
// These carry or return pairing codes, which must not follow a redirect to another origin.
const NO_REDIRECTS: RequestInit = { redirect: "error" };

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};

function upsertByKey<A>(
  values: ReadonlyArray<A>,
  next: A,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function applyAuthAccessStreamEvent(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): AuthAccessSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertByKey(current.pairingLinks, event.payload, (value) => value.id),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: current.pairingLinks.filter((value) => value.id !== event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertByKey(
          current.clientSessions,
          event.payload,
          (value) => value.sessionId,
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: current.clientSessions.filter(
          (value) => value.sessionId !== event.payload.sessionId,
        ),
      };
  }
}

function projectAuthAccessSnapshot(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): readonly [AuthAccessSnapshot, ReadonlyArray<AuthAccessStreamEvent>] {
  const snapshot = applyAuthAccessStreamEvent(current, event);
  const projected: AuthAccessStreamSnapshotEvent = {
    version: 1,
    revision: event.revision,
    type: "snapshot",
    payload: snapshot,
  };
  return [snapshot, [projected]];
}

/** Access management runs on the chosen environment with this client's own session there. */
export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    createPairingCredential: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-create-pairing-credential",
      execute: (input: AuthCreatePairingCredentialInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.pairingCredential(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.pairingCredential({ headers, payload: input }),
        }),
    }),
    revokePairingLink: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-pairing-link",
      execute: (input: AuthRevokePairingLinkInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokePairingLink(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokePairingLink({ headers, payload: input }),
        }),
    }),
    revokeClient: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-client",
      execute: (input: AuthRevokeClientSessionInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeClient(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeClient({ headers, payload: input }),
        }),
    }),
    /** Sets a session's expiry; servers without it answer 404. */
    renewClient: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-renew-client",
      execute: (input: AuthRenewClientSessionInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.renewClient(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.renewClient({ headers, payload: input }),
        }),
    }),
    createAppInvite: createEnvironmentCommand(runtime, {
      label: "environment-data:server:access-create-app-invite",
      execute: Effect.fnUntraced(function* (input: AuthCreateAppInviteInput) {
        // The invite carries another environment's full-access code: never over plain http.
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isSome(prepared) && !carriesCredentialsSafely(prepared.value.httpBaseUrl)) {
          return yield* new AppInviteUnsafeConnectionError();
        }
        return yield* executeConnectedEnvironmentHttpRequest({
          group: "access",
          method: "POST",
          url: (urls) => urls.createAppInvite(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          requestInit: NO_REDIRECTS,
          request: ({ client, headers }) => client.createAppInvite({ headers, payload: input }),
        });
      }),
    }),
    revokeAppInvite: createEnvironmentCommand(runtime, {
      label: "environment-data:server:access-revoke-app-invite",
      execute: (input: AuthRevokeAppInviteInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "access",
          method: "POST",
          url: (urls) => urls.revokeAppInvite(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeAppInvite({ headers, payload: input }),
        }),
    }),
    /** Hands out and deletes the invites left for this environment's desktop app; older servers answer 404. */
    takePendingAppInvites: createEnvironmentCommand(runtime, {
      label: "environment-data:server:access-take-pending-app-invites",
      execute: (_input: null) =>
        executeConnectedEnvironmentHttpRequest({
          group: "access",
          method: "POST",
          url: (urls) => urls.takePendingAppInvites(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          requestInit: NO_REDIRECTS,
          request: ({ client, headers }) => client.takePendingAppInvites({ headers }),
        }),
    }),
    /** Has the environment ask a linked one when its link there ends; older servers answer 404. */
    refreshPeerLinkExpiry: createEnvironmentCommand(runtime, {
      label: "environment-data:server:access-refresh-peer-link-expiry",
      execute: (input: AuthRefreshPeerLinkExpiryInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "access",
          method: "POST",
          url: (urls) => urls.refreshPeerLinkExpiry(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) =>
            client.refreshPeerLinkExpiry({ headers, payload: input }),
        }),
    }),
    revokeOtherClients: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-other-clients",
      execute: (_input: null) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeOtherClients(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeOtherClients({ headers }),
        }).pipe(Effect.map((result) => result.revokedCount)),
    }),
    approveConnectDevice: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-approve-connect-device",
      execute: (input: AuthApproveConnectDeviceInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.approveConnectDevice(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) =>
            client.approveConnectDevice({ headers, payload: input }),
        }),
    }),
    revokeConnectDevice: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-connect-device",
      execute: (input: AuthRevokeConnectDeviceInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeConnectDevice(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeConnectDevice({ headers, payload: input }),
        }),
    }),
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
  };
}
