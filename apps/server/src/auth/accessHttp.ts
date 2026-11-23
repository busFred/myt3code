import {
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentPeerLinkFailedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as AppInvites from "./AppInvites.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentOperationForbidden,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "./http.ts";

/** Sessions this environment's own desktop app holds; only they take its invites. */
const DESKTOP_APP_SUBJECT = "desktop-bootstrap";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "access",
  Effect.fnUntraced(function* (handlers) {
    const appInvites = yield* AppInvites.AppInvites;
    const peerLinks = yield* PeerLinks.PeerLinks;
    const inviteFailed = (error: AppInvites.AppInviteError) =>
      failEnvironmentInternal("app_invite_failed", error);

    return handlers
      .handle(
        "createAppInvite",
        Effect.fn("environment.access.createAppInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthAccessWriteScope);
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
          if (session.subject !== DESKTOP_APP_SUBJECT) {
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
          Effect.catchTags({
            PeerLinkError: (error) =>
              Effect.fail(
                new EnvironmentPeerLinkFailedError({
                  code: "peer_link_failed",
                  reason: error.reason,
                  detail: error.message,
                  ...(error.answeredAs === undefined ? {} : { answeredAs: error.answeredAs }),
                }),
              ),
          }),
        ),
      );
  }),
);
