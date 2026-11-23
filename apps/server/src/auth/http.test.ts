import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          expect(devCookies.filter((cookie) => /;\s*Secure/i.test(cookie))).toEqual([]);
          const httpsResponse = await environmentA.handler(
            postJson(
              "/api/auth/browser-session",
              { credential: DEV_TOKEN },
              { "x-forwarded-proto": "https" },
            ),
            requestContext,
          );
          const httpsCookies = httpsResponse.headers.getSetCookie();
          expect(httpsCookies).toHaveLength(2);
          for (const cookie of httpsCookies) expect(cookie).toMatch(/;\s*Secure/i);
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("sets a renewed or long session's cookie again on load, capped at 400 days", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const day = 24 * 60 * 60 * 1000;
          const cookieOf = (response: Response) =>
            response.headers.getSetCookie().find((cookie) => cookie.startsWith("t3_session_"));
          const expiresAt = (cookie: string | undefined) =>
            Date.parse(/Expires=([^;]+)/.exec(cookie ?? "")?.[1] ?? "");
          const admin = await environment.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          const adminCookie =
            admin.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          const pairAndSignIn = async (body: unknown) => {
            const pairing = (await (
              await environment.handler(
                postJson("/api/auth/pairing-token", body, { cookie: adminCookie }),
                requestContext,
              )
            ).json()) as { credential: string };
            return environment.handler(
              postJson("/api/auth/browser-session", { credential: pairing.credential }),
              requestContext,
            );
          };
          const load = (cookie: string | undefined) =>
            environment.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
              }),
              requestContext,
            );

          const forever = await pairAndSignIn({ lifetime: { _tag: "never" } });
          const foreverCookie = cookieOf(forever);
          // A default session's cookie already matches it, so loading sets nothing.
          const ordinary = await pairAndSignIn({ scopes: ["orchestration:read"] });
          const ordinaryCookie = cookieOf(ordinary);
          expect(cookieOf(await load(ordinaryCookie))).toBeUndefined();
          // Browsers keep 400 days; the 30-day cookie set just after shows where that lands.
          const capDays = (expiresAt(foreverCookie) - expiresAt(ordinaryCookie)) / day + 30;
          expect(capDays).toBeGreaterThan(399.9);
          expect(capDays).toBeLessThanOrEqual(400);
          expect(expiresAt(cookieOf(await load(foreverCookie)))).toBeGreaterThanOrEqual(
            expiresAt(foreverCookie),
          );

          // Only access management may renew, as only it may revoke.
          const ordinaryId = await (async () => {
            const token = decodeURIComponent(ordinaryCookie?.split(";", 1)[0]?.split("=")[1] ?? "");
            const payload = JSON.parse(
              Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
            ) as { sid: string };
            return payload.sid;
          })();
          const renew = (cookie: string) =>
            environment.handler(
              postJson(
                "/api/auth/clients/renew",
                { sessionId: ordinaryId, lifetime: { _tag: "duration", millis: 90 * day } },
                { cookie },
              ),
              requestContext,
            );
          const refused = await renew(ordinaryCookie?.split(";", 1)[0] ?? "");
          expect(refused.status).toBe(403);
          expect(await refused.json()).toMatchObject({ requiredPermission: "access:write" });
          const renewed = await renew(adminCookie);
          expect(renewed.status).toBe(200);
          const result = (await renewed.json()) as { renewed: boolean; expiresAt: string };
          expect(result.renewed).toBe(true);
          // Cookie expiries keep whole seconds.
          expect(
            Math.abs(
              expiresAt(cookieOf(await load(ordinaryCookie))) - Date.parse(result.expiresAt),
            ),
          ).toBeLessThan(1000);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// The web handler runs on its own runtime, so proofs need wall-clock time.
it.live("checks token-endpoint DPoP proofs without writing replay state", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const written: Array<string> = [];
    const recordingSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: (name) => Effect.sync(() => void written.push(name)),
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, recordingSecretStore),
    );
    const url = "http://127.0.0.1/oauth/token";
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const tokenRequest = (subjectToken: string, proof: string) =>
      new Request(url, {
        method: "POST",
        headers: { host: "127.0.0.1", dpop: proof },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: subjectToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const unknownToken = await environment.handler(
            tokenRequest("not-a-pairing-token", key.sign({ method: "POST", url, token: "", iat })),
            requestContext,
          );
          expect(unknownToken.status).toBe(401);
          expect(await unknownToken.json()).not.toHaveProperty("dpopFailureReason");

          const accepted = await environment.handler(
            tokenRequest(DEV_TOKEN, key.sign({ method: "POST", url, token: "", iat })),
            requestContext,
          );
          expect(accepted.status).toBe(200);
          expect(await accepted.json()).toMatchObject({ token_type: "DPoP" });

          const badProof = await environment.handler(
            tokenRequest(DEV_TOKEN, "not-a-proof"),
            requestContext,
          );
          expect(badProof.status).toBe(401);
          expect(badProof.headers.get("www-authenticate")).toBe("DPoP");
          expect(written).toEqual([]);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
