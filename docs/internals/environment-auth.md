# Environment authentication

The environment issues its own sessions and enforces their capabilities. Cloud
identity and relay credentials belong to a separate trust boundary, described in
[T3 Connect](./t3-connect.md). A relay token is never an environment login.

## Authority survives transport changes

Pairing delegates a set of scopes. Exchanging a bootstrap credential can narrow
that grant but cannot widen it. The default grant includes access and relay
management: `terminal:operate` is a shell as the server's user and
`orchestration:operate` can start a full-access agent, and either can mint a
session with every scope through `t3 auth session issue`, so withholding
management from the default would not be a boundary. A narrower client gets
explicit scopes. Creating another pairing link requires both `access:write` and
every scope being delegated. The
[auth handlers](../../apps/server/src/auth/http.ts) enforce this at issuance;
client labels and device metadata have no authorization role.

The access read model contains pairing metadata, never recoverable pairing
secrets. Only the creation response returns the raw credential. Otherwise read
access to the connections list would become a way to acquire another client's
authority.

Browser cookies, bearer tokens, and DPoP tokens adapt the same scoped session
model. DPoP binds a token to a client's proof key; an invalid proof must fail
rather than fall back to bearer authentication. The OAuth token-exchange
vocabulary gives these grants a familiar meaning.

A device that exchanges a plain pairing link with a DPoP proof gets a one-hour
token on a session that renews: presenting the token, even expired, with a
proof from the same key moves the session's expiry 30 days out and returns a
fresh token for the same session. The session itself must still be unexpired
and unrevoked, so a device idle past the window pairs again. Renewal stays in place rather than issuing a
successor, so live sockets keep their session, Sharing & access shows one row
per device for its whole renewal window, and one revoke ends it. T3 Connect,
CLI and desktop sessions never renew, so unlinking Connect or rotating
their credential still cuts a device off.

A [peer link](remote.md#peer-links)'s session renews on use instead: its
bearer token is never reissued. Authenticating a call from it moves the row
out by the link's window (below; 30 days by default), at most once a day, or
once per thirtieth of a shorter window, so a busy link does not write on every
call. Only an unexpired, unrevoked row moves, so an idle link still ends after
its window and a revoke is final. Other MCP clients keep the fixed 30 days they
were issued.

### The session row holds the deadline

Verification takes a session's expiry from its row, not from the token's
`exp`. The two are equal at issue, so this changes nothing until something
moves the row: peer-link use, a renewing device, or `renew` (`t3 auth session
renew`, `POST /api/auth/clients/renew`, `access:write` like revoke). Making a
session last longer over HTTP also needs every scope it holds, so access
management cannot stretch a stronger session; shortening needs only
`access:write`. The CLI renews through a running server with every scope, as
the local admin it already is. The scope check holds only for the row it read,
so the write is conditional on that row's expiry and window, and the automatic
extensions (peer-link use, a renewing device) are conditional on the window
they read: a concurrent shortening is never undone. A client renewing a peer
link passes `expectedSubject`, so a session id a linking side misreports cannot
renew another kind of session. Only a renewing device's token (`rnw`) is also
bound by its own short `exp`, which never outlasts its window. WebSocket
tickets already checked the row, and a live socket's or media stream's watcher
wakes on any change to its session, so a renew that shortens a session closes
them on time. Renew refuses T3 Connect and desktop app sessions
(`NON_RENEWABLE_SESSION_SUBJECTS`): Connect's and the desktop bootstrap's short
fixed lifetimes are what make unlinking Connect or rotating the desktop secret
cut them off, and the app attached to the background service pairs itself again
whenever that service changes.

A pairing link can carry a lifetime for the session it creates: a duration or
never. It applies to browser, bearer, renewing-device and peer-link sessions,
never to T3 Connect or the desktop app. The lifetime is stored on the row as
the session's window, and `renew` replaces it, so a renewing device or a peer
link keeps sliding by the lifetime it was last given. A renewing device's
window is at least ten minutes, at issue and on `renew`: its client renews a
minute before the token ends, so a shorter window would have it renew on every
request. Never is a fixed
far-future expiry (`NEVER_EXPIRES_AT_MILLIS`, 9999-12-31), not a null, so every
`expiresAt` field, token claim and `expires_at > now` query keeps working;
`isNeverExpiring` tests a threshold because a linking side derives its copy
from `expires_in`. A duration is capped at 100 years, so no expiry passes the
sentinel. Extending a session never moves its expiry earlier, so peer renewal
cannot shorten a never or long link; only `renew` can. The fork's columns are
added outside the numbered migrations
([ForkAuthLifetimes](../../apps/server/src/persistence/Migrations/ForkAuthLifetimes.ts)),
so an upstream migration that rebuilds `auth_sessions` or `auth_pairing_links`
would drop them: lifetimes and windows would reset to the defaults, and
expiries would survive.

Browsers keep a cookie at most 400 days (RFC 6265bis) whatever its expiry. The
session endpoint a web client calls on load sets the cookie again, capped at
400 days, when the row no longer matches the token's own expiry or the session
outlives the cap. A default session's cookie already matches, so it is not
rewritten. A browser that renews its own session gets the new cookie in that
response. One renewed from another device keeps its old cookie until it next
loads the app, so it must load it before that cookie expires.

### App invites

A client that links two environments can leave an invite on one for that
machine's own desktop app to connect to the other
([AppInvites](../../apps/server/src/auth/AppInvites.ts)). The invite holds a
one-time pairing code from the other environment, so the code lives in the
secret store like a peer link's token, and the access stream lists invites
without it. The app adds that environment without asking, so leaving an invite
needs every standard scope, and clients leave one only when, after their run,
the app's environment has a full-access link to the other, made then or
before, so a rerun retries an invite that failed: the code is a standard one,
and anything narrower would hand the app more than the link allows. The invite and its code last at most a
day. Only a desktop app session can take invites, each once:
`desktop-bootstrap`, or `desktop-service`, which only the local
`t3 pair --desktop-service` can mint because it writes to the environment's
database. The app asks only when the access snapshot lists some, or once at
launch from a server whose snapshot has no invite list, and stops asking a
server that refuses its session. A newer invite for the same environment
replaces the pending one; creating, revoking and taking run one at a time, and
a replacement stores its code before the old invite goes, so a take racing it
gets one of the two. A client revokes the code it minted only when it could not
leave the invite; this environment never acts on ids another machine reports,
and the one-day expiry bounds an unused code. Invite changes reach the access
stream as a fresh snapshot, because older clients cannot decode a new event
type.

### Guest links are not sessions

A [guest link](../user/guest-links.md) gives one browser read access to one
thread and a way to propose messages. Its tokens are HMACs of the thread and
share id under a server key ([GuestShareService](../../apps/server/src/guest/GuestShareService.ts)),
so nothing secret is stored. The share in the thread projection is the only
state: replacing, closing, or archiving it revokes every token, and the
orchestrator's serial commands make redeeming and sending happen once. Guest
tokens never enter `SessionStore`, so no RPC, WebSocket, or MCP path can accept
one. Guest routes also require T3 Connect to still serve the link's hostname;
the request's Host header is not checked, because a LAN client can forge it.

### MCP clients are a separate audience

Agents T3 Code did not launch sign in to `/mcp` through a narrow OAuth
authorization-code server ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)).
It accepts loopback redirect URIs for agents on the user's machine and any
HTTPS redirect for hosted agents (ChatGPT, bots). An HTTPS redirect means a
link someone else sends the owner can deliver access to that someone, so the
approval page names the host access goes to and approving stays the owner's
call. Every client is public and proves itself with PKCE; a client that asks
for a secret is registered without one. Client registration is stateless, so an unauthenticated caller cannot grow server
state. Approval spends a one-time pairing code, or uses a browser session with
`access:write`; proof-bound T3 Connect codes are refused without being spent.

The user grants either read-only access or a runtime-mode ceiling, not a
scope list: MCP tools are all orchestration, and `orchestration:operate`
alone would let an agent start a thread in full access and act through it.
The result is an ordinary session with subject `mcp-client`. A read-only
grant holds `orchestration:read` alone. On `/mcp` it passes only tools
declared as reads in [McpToolAccess](../../apps/server/src/mcp/McpToolAccess.ts),
where every tool must declare who may call it to compile. Any other grant adds
`orchestration:operate` and a signed ceiling. Only `/mcp` accepts these sessions. Every other HTTP and WebSocket
path rejects that subject, because the RPC surface would let the agent act
above its ceiling. Inside MCP the credential sets the limits and tool
parameters only pick targets; see
[threadAccess](../../apps/server/src/mcp/threadAccess.ts).

These clients have no calling thread, so `/mcp` does not offer them tools that
act as one, such as `request_secret` or `delegate_task`. Hiding is only
discovery: the handlers still refuse such a call with
`thread_credential_required`. A secret card belongs to a thread's run, so an
outside agent that needs a secret starts a thread and lets that agent ask.

Issuer and resource URLs come from the request's Host and
`X-Forwarded-Proto`, so one server answers over loopback, Tailscale Serve and a
T3 Connect tunnel. A proxy that rewrites Host or drops the protocol header
breaks sign-in.

Bearer and DPoP clients obtain short-lived WebSocket tickets through authenticated
HTTP so long-lived tokens stay out of socket URLs. A ticket names the route it
opens: the RPC socket, or the media routes (device hub, preview stream), which
share one ticket across `<img>`, `EventSource` and several sockets. A DPoP
client's RPC ticket is bound to its proof key and the upgrade carries a fresh
proof in the `dpop` query parameter, since a WebSocket cannot set headers; a
ticket captured on a plain HTTP LAN route is useless without the key, and the
proof's `jti` is consumed like any other. Media tickets stay bearer because each
media request would need its own proof. Clients that predate this mint unbound
tickets that open either route. Browser sessions can authenticate the upgrade
with their cookie. A successful handshake grants no
extra authority: [every RPC declares a required
scope](../../apps/server/src/auth/RpcAuthorization.ts), and the WebSocket RPC
group's `RpcScopeAuthorization` middleware checks it before any handler runs.

Scope changes must not prevent older clients from connecting. Token exchange
intersects recognized requests with the pairing grant; retired and unknown names
are dropped. A request with no granted scopes fails before consuming the link.
Stored credentials are never expanded when scopes split.

Auth responses keep `scopes` within the original wire vocabulary and include
`permissions` for the exact grant. New clients use `permissions` when present,
even if empty. Older servers omit it, so clients use legacy parent checks for
features those servers already support. These client checks never change server
authorization. Permission errors likewise retain a legacy `requiredScope` and
add the exact `requiredPermission`, so a denied RPC stays decodable by old clients.
Unknown response permissions are ignored; grant inputs stay strict.

Desktop restarts forget the previous local bearer token, so its reusable
bootstrap grant replaces earlier sessions for the same subject and method.
Revocation and insertion share a [database
transaction](../../apps/server/src/persistence/AuthSessions.ts); a failed
replacement must leave the old credential usable. Pairing and browser sessions
do not follow this replacement rule.

### Reusable dev credential

Web development environments can accept one `T3CODE_DEV_AUTH_TOKEN` across
worktrees and ports on one hostname. The token and startup URLs that contain it
grant administrative access. Desktop and non-development servers ignore it. See
the [development runbook](../operations/development.md#reusable-dev-credential)
for setup.

Each environment hashes the value and seeds its own database record at startup.
Environments do not share SQLite data, signing keys, environment IDs, session
records, pairing grants, or revocation state. Local revocation persists after
restart and does not affect another worktree. Removing or rotating the value
and restarting invalidates the old credential and its WebSocket tickets.

Normal credentials keep precedence. A rejected normal credential never falls
back to the reusable credential. OAuth exchanges create ordinary local bearer
or DPoP children with normal expiry and revocation. The reusable cookie expires
after 30 days.

## The environment is the filesystem boundary

Projects are organizational boundaries, not filesystem sandboxes.
`filesystem:read` permits reading files the server account can read, including
absolute paths outside a project. This lets clients display artifacts that an
agent writes in a temporary directory. Relative paths and writes still follow
the [workspace path rules](../../apps/server/src/workspace/WorkspaceFileSystem.ts).

Signed asset URLs are bearer credentials. A URL for media on the host grants
access to one canonical file and its device/inode identity, not its containing directory.
[Asset access](../../apps/server/src/assets/AssetAccess.ts) rechecks the opened
file's identity when serving it, so atomic replacement requires a new URL while
editing the same file in place does not. An HTML file authorized this way cannot
load sibling assets; directory-scoped workspace previews are a separate grant.
Clients should share the authored file reference so they do not disclose the
temporary URL's credential. `filesystem:read` is checked when the URL is minted,
not when it is served: a URL issued before the grant was revoked keeps working
until it expires, and it is not bound to the session that minted it.

Host videos can change in place. Their [HTTP
responses](../../apps/server/src/http.ts) omit cache validators because file
metadata cannot prove byte-for-byte identity for `If-Range`. Adding weak
validators would turn native-player seeks into full downloads.
