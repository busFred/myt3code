import {
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  DESKTOP_APP_SESSION_SUBJECTS,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentPeerLinkFailedError,
  type PeerLinkError,
} from "@t3tools/contracts";
import { carriesCredentialsSafely } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as AppInvites from "./AppInvites.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentOperationForbidden,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "./http.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "access",
  Effect.fnUntraced(function* (handlers) {
    const appInvites = yield* AppInvites.AppInvites;
    const peerLinks = yield* PeerLinks.PeerLinks;
    const inviteFailed = (error: AppInvites.AppInviteError) =>
      failEnvironmentInternal("app_invite_failed", error);
    const linkFailed = (error: PeerLinkError) =>
      Effect.fail(
        new EnvironmentPeerLinkFailedError({
          code: "peer_link_failed",
          reason: error.reason,
          detail: error.message,
          ...(error.answeredAs === undefined ? {} : { answeredAs: error.answeredAs }),
        }),
      );

    return handlers
      .handle(
        "createAppInvite",
        Effect.fn("environment.access.createAppInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // The desktop app takes an invite without asking, so only a caller that could itself
          // sign in with every standard scope may leave one.
          const session = yield* EnvironmentAuthenticatedPrincipal;
          const missing = AuthStandardClientScopes.find((scope) => !session.scopes.has(scope));
          if (missing !== undefined) return yield* failEnvironmentScopeRequired(missing);
          if (!args.payload.urls.some(carriesCredentialsSafely)) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          return yield* appInvites.create(args.payload).pipe(Effect.catch(inviteFailed));
        }),
      )
      .handle(
        "revokeAppInvite",
        Effect.fn("environment.access.revokeAppInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
          const revoked = yield* appInvites
            .revoke(args.payload.id)
            .pipe(Effect.catch(inviteFailed));
          return { revoked };
        }),
      )
      .handle(
        "takePendingAppInvites",
        Effect.fn("environment.access.takePendingAppInvites")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* EnvironmentAuthenticatedPrincipal;
          // Only this environment's own desktop app may take its invites.
          if (!DESKTOP_APP_SESSION_SUBJECTS.includes(session.subject)) {
            return yield* failEnvironmentOperationForbidden("desktop_app_only");
          }
          return { invites: yield* appInvites.takePending.pipe(Effect.catch(inviteFailed)) };
        }),
      )
      .handle(
        "linkPeer",
        Effect.fn("environment.access.linkPeer")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const { enableLinkedEnvironments, ...input } = args.payload;
            const enableFirst = enableLinkedEnvironments === true && !(yield* peerLinks.enabled);
            // Turning the beta on is a settings change.
            if (enableFirst && !session.scopes.has(AuthSettingsWriteScope)) {
              return yield* failEnvironmentScopeRequired(AuthSettingsWriteScope);
            }
            return yield* peerLinks.linkEnabling(input, enableFirst);
          },
          Effect.catchTags({ PeerLinkError: linkFailed }),
        ),
      )
      .handle(
        "enableLinkedEnvironments",
        Effect.fn("environment.access.enableLinkedEnvironments")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthSettingsWriteScope);
            return { enabledLinkedEnvironments: yield* peerLinks.turnOn };
          },
          Effect.catchTags({ PeerLinkError: linkFailed }),
        ),
      )
      .handle(
        "refreshPeerLinkExpiry",
        Effect.fn("environment.access.refreshPeerLinkExpiry")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            // The peer may slide the link's session when asked, which managing access allows.
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const expiresAt = yield* peerLinks.refreshExpiry(args.payload.environmentId);
            return Option.isSome(expiresAt) ? { expiresAt: expiresAt.value } : {};
          },
          Effect.catchTags({ PeerLinkError: linkFailed }),
        ),
      );
  }),
);
