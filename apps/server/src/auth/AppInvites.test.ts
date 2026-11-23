import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DESKTOP_BOOTSTRAP_SESSION_SUBJECT,
  DESKTOP_SERVICE_SESSION_SUBJECT,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AccessHttp from "./accessHttp.ts";
import * as AppInvites from "./AppInvites.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-app-invites-test-" });
const layerAppInvites = AppInvites.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerConfig),
);

const otherEnvironment = EnvironmentId.make("environment-a");
const inviteInput = (credential: string, environmentId = otherEnvironment) => ({
  environmentId,
  label: "A",
  urls: ["https://a.example.ts.net"] as const,
  credential,
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("AppInvites", (it) => {
  it.effect("hands each invite's code out once, then forgets the code", () =>
    Effect.gen(function* () {
      const invites = yield* AppInvites.AppInvites;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const created = yield* invites.create(inviteInput("AAAA-BBBB-CCCC"));
      expect((yield* invites.list).map((invite) => invite.id)).toEqual([created.id]);

      const [taken, again] = yield* Effect.all([invites.takePending, invites.takePending], {
        concurrency: "unbounded",
      });
      expect([...taken, ...again].map((invite) => invite.credential)).toEqual(["AAAA-BBBB-CCCC"]);
      expect(yield* invites.list).toEqual([]);
      expect(Option.isNone(yield* secrets.get(`app-invite-${created.id}`))).toBe(true);
    }).pipe(Effect.provide(Layer.merge(layerAppInvites, TestClock.layer()))),
  );

  it.effect(
    "keeps only addresses a code can travel to safely, and rejects an invite with none",
    () =>
      Effect.gen(function* () {
        const invites = yield* AppInvites.AppInvites;
        const kept = yield* invites.create({
          ...inviteInput("AAAA-BBBB-CCCC"),
          urls: ["http://192.168.1.5:3773", "https://a.example.ts.net"],
        });
        expect(kept.urls).toEqual(["https://a.example.ts.net"]);
        const rejected = yield* invites
          .create({ ...inviteInput("DDDD-EEEE-FFFF"), urls: ["http://192.168.1.5:3773"] })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({ _tag: "AppInviteError", reason: "no_safe_address" });
        expect((yield* invites.list).map((invite) => invite.id)).toEqual([kept.id]);
      }).pipe(Effect.provide(Layer.merge(layerAppInvites, TestClock.layer()))),
  );

  it.effect("leaves an invite whose code cannot be read pending, and hands out the rest", () =>
    Effect.gen(function* () {
      const invites = yield* AppInvites.AppInvites;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const lost = yield* invites.create(inviteInput("LOST"));
      yield* invites.create(inviteInput("KEPT", EnvironmentId.make("b")));
      yield* secrets.remove(`app-invite-${lost.id}`);

      expect((yield* invites.takePending).map((invite) => invite.credential)).toEqual(["KEPT"]);
      expect((yield* invites.list).map((invite) => invite.id)).toEqual([lost.id]);
    }).pipe(Effect.provide(Layer.merge(layerAppInvites, TestClock.layer()))),
  );

  it.effect("ends an invite when its code does, after a day, or when replaced or revoked", () =>
    Effect.gen(function* () {
      const invites = yield* AppInvites.AppInvites;
      const now = yield* DateTime.now;
      const shortLived = yield* invites.create({
        ...inviteInput("SHORT"),
        credentialExpiresAt: DateTime.add(now, { hours: 1 }),
      });
      expect(shortLived.expiresAt.epochMilliseconds).toBe(now.epochMilliseconds + 3_600_000);
      // A newer invite for the same environment replaces it.
      const replacing = yield* invites.create({
        ...inviteInput("REPLACING"),
        credentialExpiresAt: DateTime.add(now, { days: 7 }),
      });
      expect(replacing.expiresAt.epochMilliseconds).toBe(now.epochMilliseconds + 24 * 3_600_000);
      const other = yield* invites.create(inviteInput("OTHER", EnvironmentId.make("b")));
      expect((yield* invites.list).map((invite) => invite.id).toSorted()).toEqual(
        [replacing.id, other.id].toSorted(),
      );

      expect(yield* invites.revoke(other.id)).toBe(true);
      expect(yield* invites.revoke(other.id)).toBe(false);
      yield* TestClock.adjust("1 day");
      expect(yield* invites.takePending).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(layerAppInvites, TestClock.layer()))),
  );

  it.effect("revokes an invite even when its code cannot be removed", () =>
    Effect.gen(function* () {
      const invites = yield* AppInvites.AppInvites;
      const created = yield* invites.create(inviteInput("STUCK"));
      expect(yield* invites.revoke(created.id)).toBe(true);
      expect(yield* invites.list).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          AppInvites.layer.pipe(
            Layer.provideMerge(
              Layer.effect(
                ServerSecretStore.ServerSecretStore,
                Effect.map(ServerSecretStore.make, (store) =>
                  ServerSecretStore.ServerSecretStore.of({
                    ...store,
                    remove: (name) =>
                      Effect.fail(
                        new ServerSecretStore.SecretStoreRemoveError({
                          resource: name,
                          cause: "the disk refused",
                        }),
                      ),
                  }),
                ),
              ),
            ),
            Layer.provideMerge(SqlitePersistence.layerMemory),
            Layer.provide(layerConfig),
          ),
          TestClock.layer(),
        ),
      ),
    ),
  );

  it.effect("a take racing a replacing create gets the old invite or the new one, never none", () =>
    Effect.gen(function* () {
      const invites = yield* AppInvites.AppInvites;
      for (let round = 0; round < 20; round++) {
        yield* invites.create(inviteInput(`OLD-${round}`));
        const [taken] = yield* Effect.all(
          [invites.takePending, invites.create(inviteInput(`NEW-${round}`))],
          { concurrency: "unbounded" },
        );
        const left = yield* invites.takePending;
        expect(taken.map((invite) => invite.credential)).toHaveLength(1);
        expect([...taken, ...left].map((invite) => invite.credential)).toEqual(
          taken[0]?.credential === `OLD-${round}`
            ? [`OLD-${round}`, `NEW-${round}`]
            : [`NEW-${round}`],
        );
      }
    }).pipe(Effect.provide(Layer.merge(layerAppInvites, TestClock.layer()))),
  );
});

class AccessTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.access) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const post = (path: string, token: string, body?: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: encodeJson(body) }),
  });

// Live: sessions issued here must still be valid on the routes' own clock.
it.live("guards invites and links by access, and lets only the desktop app take invites", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const context = Context.make(SecureRandom.SecureRandom, random);
    let auth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const layerRoutes = Layer.mergeAll(
      Layer.effectDiscard(
        EnvironmentAuth.EnvironmentAuth.pipe(
          Effect.tap((service) =>
            Effect.sync(() => {
              auth = service;
            }),
          ),
        ),
      ),
      HttpApiBuilder.layer(AccessTestApi).pipe(
        Layer.provide([AuthHttp.layer, AccessHttp.layer]),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            // Off here, so a link request that turns it on is a settings change.
            enabled: Effect.succeed(false),
            linkEnabling: (input, enableFirst) =>
              DateTime.now.pipe(
                Effect.map((now) => ({
                  link: {
                    environmentId: input.expectedEnvironmentId ?? otherEnvironment,
                    label: "A",
                    urls: [input.url],
                    access: input.access,
                    linkedAt: now,
                    expiresAt: now,
                    lastReachedAt: now,
                    lastError: null,
                  },
                  alreadyLinked: false,
                  enabledLinkedEnvironments: enableFirst,
                })),
              ),
          }),
        ),
      ),
    ).pipe(
      Layer.provideMerge(AppInvites.layer),
      Layer.provideMerge(
        EnvironmentAuth.layer.pipe(
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provide(ServerEnvironment.layerIdentity),
        ),
      ),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provide(layerConfig),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const send = (request: Request) => Effect.promise(() => web.handler(request, context));
          // The first request builds the routes, and with them `auth`.
          yield* send(new Request("http://127.0.0.1/api/auth/session"));
          const service = auth!;
          const standard = yield* service.issueSession({ subject: "phone" });
          const reader = yield* service.issueSession({
            subject: "viewer",
            scopes: ["orchestration:read"],
          });
          const desktop = yield* service.issueSession({
            subject: DESKTOP_BOOTSTRAP_SESSION_SUBJECT,
          });
          const accessOnly = yield* service.issueSession({
            subject: "access-admin",
            scopes: ["access:read", "access:write"],
          });

          const refused = yield* send(
            post("/api/app-invites", reader.token, inviteInput("SECRET-CODE")),
          );
          expect(refused.status).toBe(403);
          // Managing access is not enough: the invited app gets every standard scope.
          const narrower = yield* send(
            post("/api/app-invites", accessOnly.token, inviteInput("SECRET-CODE")),
          );
          expect(narrower.status).toBe(403);
          const plainHttpOnly = yield* send(
            post("/api/app-invites", standard.token, {
              ...inviteInput("SECRET-CODE"),
              urls: ["http://192.168.1.5:3773"],
            }),
          );
          expect(plainHttpOnly.status).toBe(400);
          const created = yield* send(
            post("/api/app-invites", standard.token, inviteInput("SECRET-CODE")),
          );
          expect(created.status).toBe(200);
          const invite = (yield* Effect.promise(() => created.json())) as { id: string };
          expect(invite).not.toHaveProperty("credential");

          const notDesktop = yield* send(post("/api/app-invites/take", standard.token));
          expect(notDesktop.status).toBe(403);
          expect(yield* Effect.promise(() => notDesktop.json())).toMatchObject({
            reason: "desktop_app_only",
          });
          const taken = yield* send(post("/api/app-invites/take", desktop.token));
          expect(yield* Effect.promise(() => taken.json())).toMatchObject({
            invites: [{ id: invite.id, credential: "SECRET-CODE", environmentId: "environment-a" }],
          });
          const takenAgain = yield* send(post("/api/app-invites/take", desktop.token));
          expect(yield* Effect.promise(() => takenAgain.json())).toEqual({ invites: [] });
          // The desktop app attached to the background service takes them too.
          const serviceApp = yield* service.issueSession({
            subject: DESKTOP_SERVICE_SESSION_SUBJECT,
          });
          yield* send(post("/api/app-invites", standard.token, inviteInput("SERVICE-CODE")));
          const takenByService = yield* send(post("/api/app-invites/take", serviceApp.token));
          expect(yield* Effect.promise(() => takenByService.json())).toMatchObject({
            invites: [{ credential: "SERVICE-CODE" }],
          });
          const linkInput = {
            url: "https://a.example.ts.net",
            pairingCode: "ABCD-EFGH-JKLM",
            access: "auto",
            expectedEnvironmentId: otherEnvironment,
          };
          const turnOn = { ...linkInput, enableLinkedEnvironments: true };
          expect((yield* send(post("/api/peer-links/link", reader.token, linkInput))).status).toBe(
            403,
          );
          const noSettings = yield* send(post("/api/peer-links/link", accessOnly.token, turnOn));
          expect(yield* Effect.promise(() => noSettings.json())).toMatchObject({
            requiredPermission: "settings:write",
          });
          const linked = yield* send(post("/api/peer-links/link", standard.token, turnOn));
          expect(yield* Effect.promise(() => linked.json())).toMatchObject({
            alreadyLinked: false,
            enabledLinkedEnvironments: true,
          });
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
