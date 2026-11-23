import { describe, expect, it } from "vite-plus/test";

import { isUpstreamNewer, parseUpstreamRelease, shouldNotifyUpstream } from "./upstreamRelease.ts";

describe("parseUpstreamRelease", () => {
  it("reads the version and builds the release page link from the tag", () => {
    expect(parseUpstreamRelease({ tag_name: "v0.1.12", html_url: "https://evil.example" })).toEqual(
      {
        version: "0.1.12",
        url: "https://github.com/pingdotgg/t3code/releases/tag/v0.1.12",
      },
    );
  });

  it.each([null, "v1", {}, { tag_name: 3 }, { tag_name: "latest" }, { tag_name: "v1/../x" }])(
    "ignores a response without a semver tag: %j",
    (body) => {
      expect(parseUpstreamRelease(body)).toBeNull();
    },
  );
});

describe("isUpstreamNewer", () => {
  it.each([
    ["0.1.12", "0.1.11", true],
    ["0.1.11", "0.1.11", false],
    ["0.1.10", "0.1.11", false],
    ["0.2.0", "0.1.99", true],
    ["0.1.11", "0.1.11-nightly.20261101.1", true],
    ["0.1.11", "garbage", false],
  ])("%s against app %s is %s", (upstream, app, expected) => {
    expect(isUpstreamNewer(upstream, app)).toBe(expected);
  });
});

describe("shouldNotifyUpstream", () => {
  const release = { version: "0.1.12", url: "https://example.test" };

  it("notifies once per upstream version", () => {
    expect(shouldNotifyUpstream(release, "0.1.11", null)).toBe(true);
    expect(shouldNotifyUpstream(release, "0.1.11", "0.1.11")).toBe(true);
    expect(shouldNotifyUpstream(release, "0.1.11", "0.1.12")).toBe(false);
  });

  it("stays quiet once the app has caught up", () => {
    expect(shouldNotifyUpstream(release, "0.1.12", null)).toBe(false);
  });
});
