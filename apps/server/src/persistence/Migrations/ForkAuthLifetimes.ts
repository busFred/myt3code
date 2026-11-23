import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork-only schema, kept out of the numbered ledger: the migrator skips every id up to the
 * highest recorded, so a fork id would hide upstream's next migration. Each step is idempotent
 * and runs after the numbered migrations.
 */
const missingParts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly pairingLifetime: number;
    readonly sessionWindow: number;
    readonly appInvites: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM pragma_table_info('auth_pairing_links')
        WHERE name = 'session_lifetime_json') AS "pairingLifetime",
      (SELECT COUNT(*) FROM pragma_table_info('auth_sessions')
        WHERE name = 'renewal_window_json') AS "sessionWindow",
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'auth_app_invites') AS "appInvites"
  `;
  return {
    pairingLifetime: row?.pairingLifetime === 0,
    sessionWindow: row?.sessionWindow === 0,
    appInvites: row?.appInvites === 0,
  };
});

export const forkSchemaPending = missingParts.pipe(
  Effect.map((missing) => missing.pairingLifetime || missing.sessionWindow || missing.appInvites),
);

export const applyForkSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const missing = yield* missingParts;
  if (missing.pairingLifetime) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN session_lifetime_json TEXT`;
  }
  // A sliding session's window (renewing device or peer link); NULL keeps the server default.
  if (missing.sessionWindow) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN renewal_window_json TEXT`;
  }
  // The invite's pairing code lives in the secret store under `secret_name`.
  if (missing.appInvites) {
    yield* sql`
      CREATE TABLE auth_app_invites (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL,
        label TEXT NOT NULL,
        urls_json TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT
      )
    `;
  }
});
