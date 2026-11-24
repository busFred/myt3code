import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { hasLinkBack } from "./linkedEnvironments.logic";

const mac = EnvironmentId.make("mac");
const now = DateTime.makeUnsafe("2026-11-24T12:00:00.000Z");
const link = (environmentId: string, expiresAt: string): PeerLinkSummary => ({
  environmentId: EnvironmentId.make(environmentId),
  label: environmentId,
  urls: ["https://example.ts.net"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe(expiresAt),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

describe("hasLinkBack", () => {
  it.each([
    ["no links", [], false],
    ["a link to this machine", [link("mac", "2099-01-01T00:00:00.000Z")], true],
    ["an expired link to this machine", [link("mac", "2026-11-01T00:00:00.000Z")], false],
    ["a link to another machine only", [link("vm", "2099-01-01T00:00:00.000Z")], false],
  ])("%s", (_name, links, expected) => {
    expect(hasLinkBack(links, mac, now)).toBe(expected);
  });
});
