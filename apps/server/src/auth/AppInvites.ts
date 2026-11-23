import {
  type AuthAppInvite,
  type AuthCreateAppInviteInput,
  type AuthPendingAppInvite,
  EnvironmentId,
  MAX_PAIRING_LINK_TTL_MILLIS,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "./ServerSecretStore.ts";

export class AppInviteError extends Schema.TaggedError<AppInviteError>()("AppInviteError", {
  operation: Schema.Literals(["create", "list", "revoke", "take"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} app invites.`;
  }
}

/**
 * Invites for this environment's own desktop app to connect to another environment, left by a
 * client that linked the two. Each holds a one-time pairing code from that environment, kept in
 * the secret store like a peer link's token; the table keeps the rest.
 */
export class AppInvites extends Context.Service<
  AppInvites,
  {
    readonly create: (
      input: AuthCreateAppInviteInput,
    ) => Effect.Effect<AuthAppInvite, AppInviteError>;
    /** Invites not yet taken, revoked, replaced or expired. */
    readonly list: Effect.Effect<ReadonlyArray<AuthAppInvite>, AppInviteError>;
    readonly revoke: (id: string) => Effect.Effect<boolean, AppInviteError>;
    /** Hands out every pending invite once, with its code, and forgets the codes. */
    readonly takePending: Effect.Effect<ReadonlyArray<AuthPendingAppInvite>, AppInviteError>;
    /** Fires after any change, for the access stream to send a new snapshot. */
    readonly changes: Stream.Stream<void>;
  }
>()("t3/auth/AppInvites") {}

interface AppInviteRow {
  readonly id: string;
  readonly environment_id: string;
  readonly label: string;
  readonly urls_json: string;
  readonly secret_name: string;
  readonly created_at: string;
  readonly expires_at: string;
}

const UrlsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeUrls = Schema.decodeUnknownSync(UrlsJson);
const encodeUrls = Schema.encodeEffect(UrlsJson);

const toInvite = (row: AppInviteRow): AuthAppInvite => ({
  id: row.id,
  environmentId: EnvironmentId.make(row.environment_id),
  label: row.label,
  urls: decodeUrls(row.urls_json),
  createdAt: DateTime.makeUnsafe(row.created_at),
  expiresAt: DateTime.makeUnsafe(row.expires_at),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const changes = yield* PubSub.unbounded<void>();
  const publish = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const newId = random.randomBytes(16).pipe(Effect.map(Hex.encode));

  /** Drops spent, revoked and expired invites and their codes, so neither piles up. */
  const sweep = (now: DateTime.Utc) =>
    sql<{ readonly secret_name: string }>`
      DELETE FROM auth_app_invites
      WHERE consumed_at IS NOT NULL
        OR revoked_at IS NOT NULL
        OR expires_at <= ${DateTime.formatIso(now)}
      RETURNING secret_name
    `.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) => secrets.remove(row.secret_name), { discard: true }),
      ),
    );

  const create: AppInvites["Service"]["create"] = Effect.fn("AppInvites.create")(
    function* (input) {
      const now = yield* DateTime.now;
      // A newer invite for the same environment replaces the pending one.
      yield* sql`
        UPDATE auth_app_invites SET revoked_at = ${DateTime.formatIso(now)}
        WHERE environment_id = ${input.environmentId}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
      `;
      yield* sweep(now);
      const latest = DateTime.add(now, { milliseconds: MAX_PAIRING_LINK_TTL_MILLIS });
      const expiresAt =
        input.credentialExpiresAt !== undefined &&
        DateTime.isLessThan(input.credentialExpiresAt, latest)
          ? input.credentialExpiresAt
          : latest;
      const id = yield* newId;
      const urlsJson = yield* encodeUrls(input.urls);
      const secretName = `app-invite-${id}`;
      yield* secrets.set(secretName, new TextEncoder().encode(input.credential));
      const invite: AuthAppInvite = {
        id,
        environmentId: input.environmentId,
        label: input.label,
        urls: input.urls,
        createdAt: now,
        expiresAt,
      };
      yield* sql`
        INSERT INTO auth_app_invites (
          id, environment_id, label, urls_json, secret_name, created_at, expires_at
        ) VALUES (
          ${id}, ${input.environmentId}, ${input.label}, ${urlsJson},
          ${secretName}, ${DateTime.formatIso(now)}, ${DateTime.formatIso(expiresAt)}
        )
      `.pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
      yield* publish;
      return invite;
    },
    Effect.mapError((cause) => new AppInviteError({ operation: "create", cause })),
  );

  const list: AppInvites["Service"]["list"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const rows = yield* sql<AppInviteRow>`
      SELECT * FROM auth_app_invites
      WHERE consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ${DateTime.formatIso(now)}
      ORDER BY created_at DESC, id DESC
    `.pipe(NodeSqliteClient.readOnly);
    return rows.map(toInvite);
  }).pipe(
    Effect.mapError((cause) => new AppInviteError({ operation: "list", cause })),
    Effect.withSpan("AppInvites.list"),
  );

  const revoke: AppInvites["Service"]["revoke"] = Effect.fn("AppInvites.revoke")(
    function* (id) {
      const now = yield* DateTime.now;
      const revoked = yield* sql<{ readonly secret_name: string }>`
        UPDATE auth_app_invites SET revoked_at = ${DateTime.formatIso(now)}
        WHERE id = ${id} AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING secret_name
      `;
      yield* Effect.forEach(revoked, (row) => secrets.remove(row.secret_name), { discard: true });
      if (revoked.length > 0) yield* publish;
      return revoked.length > 0;
    },
    Effect.mapError((cause) => new AppInviteError({ operation: "revoke", cause })),
  );

  const takePending: AppInvites["Service"]["takePending"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    // The update claims each invite once, so two apps asking at once never both get one.
    const taken = yield* sql<AppInviteRow>`
      UPDATE auth_app_invites SET consumed_at = ${DateTime.formatIso(now)}
      WHERE consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ${DateTime.formatIso(now)}
      RETURNING *
    `;
    const invites = yield* Effect.forEach(taken, (row) =>
      secrets.get(row.secret_name).pipe(
        Effect.map(
          Option.map((credential): AuthPendingAppInvite => ({
            ...toInvite(row),
            credential: new TextDecoder().decode(credential),
          })),
        ),
      ),
    );
    yield* sweep(now);
    if (taken.length > 0) yield* publish;
    return invites.flatMap((invite) => (Option.isSome(invite) ? [invite.value] : []));
  }).pipe(
    Effect.mapError((cause) => new AppInviteError({ operation: "take", cause })),
    Effect.withSpan("AppInvites.takePending"),
  );

  return AppInvites.of({
    create,
    list,
    revoke,
    takePending,
    get changes() {
      return Stream.fromPubSub(changes);
    },
  });
});

export const layer = Layer.effect(AppInvites, make);
