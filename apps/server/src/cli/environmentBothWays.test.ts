import {
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  mcpClientScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { bothWaysScopes, inviteSkipReason } from "./environmentBothWays.ts";

describe("linking both ways from the CLI", () => {
  it("spends the code for every scope leaving an invite needs, only when one may follow", () => {
    const inviting = bothWaysScopes({ access: "full-access", inviteApp: true });
    // The other side refuses an invite from a session missing any standard scope.
    expect(AuthStandardClientScopes.filter((scope) => !inviting.includes(scope))).toEqual([]);
    expect(inviting).toEqual(expect.arrayContaining([...mcpClientScopes("full-access")]));

    const linkOnly = [
      AuthAccessWriteScope,
      AuthSettingsWriteScope,
      ...mcpClientScopes("approval-required"),
    ];
    expect(new Set(bothWaysScopes({ access: "approval-required", inviteApp: true }))).toEqual(
      new Set(linkOnly),
    );
    expect(new Set(bothWaysScopes({ access: "full-access", inviteApp: false }))).toEqual(
      new Set([AuthAccessWriteScope, AuthSettingsWriteScope, ...mcpClientScopes("full-access")]),
    );
  });

  it("invites when the other side links here at full access, and fails when the code cannot", () => {
    const base = {
      access: "full-access",
      inviteApp: true,
      granted: bothWaysScopes({ access: "full-access", inviteApp: true }),
      peerLinkAccess: "full-access",
      peerLabel: "Box",
    } as const;
    expect(inviteSkipReason(base)).toBeNull();
    expect(inviteSkipReason({ ...base, peerLinkAccess: undefined })).toMatchObject({ ok: true });
    expect(inviteSkipReason({ ...base, peerLinkAccess: "auto" })).toMatchObject({ ok: true });
    expect(inviteSkipReason({ ...base, access: "auto" })).toMatchObject({ ok: true });
    expect(inviteSkipReason({ ...base, inviteApp: false })).toMatchObject({ ok: true });
    // A code without the standard scopes still links, but the invite is reported as not done.
    expect(
      inviteSkipReason({
        ...base,
        granted: [AuthAccessWriteScope, AuthSettingsWriteScope, ...mcpClientScopes("full-access")],
      }),
    ).toMatchObject({ ok: false });
  });
});
