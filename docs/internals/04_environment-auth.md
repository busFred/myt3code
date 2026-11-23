# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud identity and relay
credentials belong to a separate trust boundary, described in [T3 Connect](./06_t3-connect.md). A relay
token is never an environment login. See [SECURITY.md](../../SECURITY.md) for the overall threat
model.

## Scoped sessions and delegation

- **Narrowing only.** Pairing delegates a set of scopes. Exchanging a bootstrap credential can
  narrow a grant, never widen it. Client labels and device metadata have no authorization role.
- **`access:write` hands out what the session holds and revokes anything.** Every route that
  returns a credential to the caller requires `access:write` and every scope that credential
  carries: a pairing link, an MCP sign-in approval, a link code from a linked environment, and a
  guest link (which reads a thread). Revoking is not capped by the caller's scopes. Admitting a
  T3 Connect device is not delegation; see [T3 Connect](./06_t3-connect.md).
- **Why the default grant includes management scopes.** `terminal:operate` and
  `orchestration:operate` already grant OS-user execution (which can invoke `t3 auth session issue`),
  so withholding access or relay management from the default grant would not be a real boundary.
  Narrower clients receive explicit scopes.
- **No recoverable secrets in read models.** Only the creation response returns a raw pairing
  credential; access listings expose metadata only.
- **DPoP binding.** Browser cookies, bearer tokens, and DPoP tokens share the scoped session model.
  DPoP binds tokens to a client proof key; an invalid proof must fail rather than fall back to
  bearer auth. Plain paired DPoP sessions renew in place so live sockets and Sharing & access rows
  stay stable; T3 Connect, CLI, and desktop sessions never self-renew so revoking/unlinking cuts
  them off.
- **The session row holds the deadline.** Verification takes a session's expiry from its row, not
  the token's `exp`, so peer-link use, a renewing device, or `renew` (`t3 auth session renew`,
  `POST /api/auth/clients/renew`, `access:write` like revoke) can move it. Lengthening a session
  over HTTP also needs every scope it holds; shortening needs only `access:write`. The write is
  conditional on the expiry and window it read, and the automatic extensions on the window they
  read, so a concurrent shortening is never undone. A client renewing a peer link passes
  `expectedSubject`, so a misreported session id cannot renew another kind of session. Only a
  renewing device's token (`rnw`) is also bound by its own short `exp`. A live socket's or media
  stream's watcher wakes on any change to its session, so a shortening closes them on time. Renew
  refuses T3 Connect and desktop app sessions (`NON_RENEWABLE_SESSION_SUBJECTS`), whose short fixed
  lifetimes are what make unlinking Connect or rotating the desktop secret cut them off.
- **Pairing links can set a session lifetime.** A duration (at most 100 years) or never, for
  browser, bearer, renewing-device and peer-link sessions, never T3 Connect or the desktop app. It
  is stored on the row as the session's window and `renew` replaces it, so a renewing device or
  peer link keeps sliding by the lifetime it was last given; a renewing device's window is at
  least its one-hour token. Never is a fixed far-future expiry (`NEVER_EXPIRES_AT_MILLIS`,
  9999-12-31), not a null, so every `expiresAt` field, token claim and `expires_at > now` query
  keeps working; `isNeverExpiring` tests a threshold because a linking side derives its copy from
  `expires_in`. Extending never moves an expiry earlier; only `renew` can. Browsers keep a cookie
  at most 400 days, so the session endpoint sets it again, capped, when the row no longer matches
  the token's expiry; a browser renewed from another device keeps its old cookie until it next
  loads the app.
- **Fork schema lives outside the numbered migrations.**
  [ForkAuthLifetimes](../../apps/server/src/persistence/Migrations/ForkAuthLifetimes.ts) adds the
  lifetime and window columns and the invite table idempotently after the numbered migrations, so
  a fork id never hides upstream's next migration. An upstream migration that rebuilds
  `auth_sessions` or `auth_pairing_links` would drop the columns: lifetimes and windows reset to
  the defaults, expiries survive.
- **App invites.** A client that links two environments can leave an invite for that machine's
  desktop app to connect to the other ([AppInvites](../../apps/server/src/auth/AppInvites.ts)). The
  app adds it without asking, so leaving one needs every standard scope, and clients leave one only
  when the app's environment has a full-access link to the other: the code is a standard one, and
  anything narrower would hand the app more than the link allows. Its code lives in the secret
  store like a peer link's token, the access stream lists invites without it, and both last at
  most a day. Invites list only https, loopback and Tailscale addresses, the rule peer links
  follow. Only a desktop app session takes invites, each once: `desktop-bootstrap`, or
  `desktop-service`, which only the local `t3 pair --desktop-service` can mint. A newer invite for
  the same environment replaces the pending one; creating, revoking and taking run one at a time.
  Invite changes reach the access stream as a fresh snapshot, because older clients cannot decode a
  new event type.
- **WebSocket tickets and per-RPC authorization.** Bearer and DPoP clients mint short-lived tickets
  over authenticated HTTP so long-lived tokens never appear in socket URLs. DPoP RPC tickets stay
  proof-key bound at upgrade. A successful handshake grants no extra authority: every RPC declares
  and checks its required scope in [`RpcAuthorization.ts`](../../apps/server/src/auth/RpcAuthorization.ts).
- **Secret references need `providers:manage`.** A request that names a secret for the server to
  read needs `providers:manage` on top of its method's scope, whether the reference is saved in
  settings or used once, as in a secret request answered with a reference. Typed values need only
  the method's scope. Clients hide the secret provider picker from sessions without it.
- **Project scripts need `orchestration:operate`.** The host runs a saved project script itself,
  on worktree creation and on settle, so saving one needs `orchestration:operate` on top of
  `settings:write`, whether it arrives in a settings patch or a project update.
- **Backward-compatible scope evolution.** Token exchange intersects requested scopes with the
  pairing grant, dropping retired/unknown names and failing before consuming a link if none remain.
  Stored grants are never expanded when scopes split. Auth responses preserve legacy `scopes`
  alongside exact `permissions` so older clients and servers stay compatible.

## Non-standard principals

- **Guest links are not sessions.** [GuestShareService](../../apps/server/src/guest/GuestShareService.ts)
  issues HMAC tokens bound to one share in the thread projection—never `SessionStore` rows—so no
  RPC, WebSocket, or MCP route can accept one. Closing, replacing, or archiving the share revokes
  every token. Guest routes also require T3 Connect to still serve the link's hostname (never rely
  on the request `Host` header alone).
- **MCP clients (`mcp-client`) are a separate audience.** Outside agents authenticate on `/mcp` via
  PKCE OAuth ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)), with stateless client
  registration so unauthenticated callers cannot grow server state. Users grant read-only access or
  a runtime-mode ceiling rather than raw scopes. Every non-`/mcp` HTTP and WebSocket route rejects
  `mcp-client` sessions (except the read-only thread relay and client-pairing routes restricted to
  [peer links](./05_remote.md#peer-links)). Every MCP tool must statically declare its access level in
  [`McpToolAccess.ts`](../../apps/server/src/mcp/McpToolAccess.ts), and thread-only tools must still
  refuse outside callers in handlers—hiding from tool listings is only discovery. A workflow run
  picks its own modes, so only a caller at the broadest mode a thread may run in here (full access,
  or an administrator's ceiling below it) can start or change runs, change what workflows store, or
  read webhook paths. Narrower callers can still read runs.
- **A project's worktree layout commands run only as a person approved them.** The commands come
  from the project folder's `t3.json` and run as the server's OS user, so each runs only after a
  client session holding `terminal:operate` approved its exact text for that project.
  [`TaskFolders`](../../apps/server/src/workspace/TaskFolders.ts) is the only place they run and
  checks the approval, managed policy, and who asked at every run. Recording an approval is a
  client RPC only: `t3code/no-layout-command-approval-writes` keeps the write side out of every
  other module, MCP tools included. For an agent's own worktree request, a thread below Full access
  gets neither these commands nor the project's setup script, approved or not. The asking thread's
  modes are read when each is about to run, a thread recorded above the administrator's
  `maxRuntimeMode` is not in Full access, and neither is an asking thread that can no longer be
  read. A command that waited for another one's turn is checked again, who asked, file and
  approval, before it starts; one refused then ran nothing, so the project's `remove` does not run
  for it either.
- **Peer-link client pairing.** Only a full-access peer link may mint a one-time client pairing on
  the linked environment (since full-access agents can already run `t3 auth pairing create`). The
  linked side enforces this itself, and the operation stays a human-triggered RPC/HTTP route rather
  than an MCP tool. The same route mints a code that links another environment at a chosen access
  level, and the linking side's RPC requires the caller to hold that level's scopes.

### Reusable dev credential

Web development servers can accept a fixed `T3CODE_DEV_AUTH_TOKEN` across worktrees and ports on one
hostname (see the [development runbook](../operations/00_development.md#reusable-dev-credential)). It
grants administrative access and is ignored by desktop and non-development servers.

Each environment hashes the value into its own database record and keeps independent SQLite state,
signing keys, and revocation state. Normal credentials always take precedence: a rejected normal
credential never falls back to the reusable dev credential.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes. `filesystem:read` permits reading
any file the server's OS user can read (for example, artifacts an agent writes in a temp directory);
relative paths and writes remain constrained by
[`WorkspaceFileSystem.ts`](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials for a single canonical file, rechecked by device/inode
identity on serve ([`AssetAccess.ts`](../../apps/server/src/assets/AssetAccess.ts)). They never
grant access to sibling files, and because `filesystem:read` is checked only at mint time, an issued
URL remains valid until it expires even if the session or grant is revoked.
