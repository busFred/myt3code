import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

/** Where upstream publishes; this fork only reads it and never installs from it. */
const UPSTREAM_RELEASES_REPOSITORY = "pingdotgg/t3code";
export const UPSTREAM_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${UPSTREAM_RELEASES_REPOSITORY}/releases/latest`;

export interface UpstreamRelease {
  readonly version: string;
  readonly url: string;
}

/** The tag must be a plain semver, so the page link is built here and never taken from the response. */
export function parseUpstreamRelease(body: unknown): UpstreamRelease | null {
  const tag =
    typeof body === "object" && body !== null && "tag_name" in body ? body.tag_name : undefined;
  if (typeof tag !== "string" || parseSemver(tag) === null) return null;
  const version = tag.trim().replace(/^v/, "");
  return {
    version,
    url: `https://github.com/${UPSTREAM_RELEASES_REPOSITORY}/releases/tag/${encodeURIComponent(tag.trim())}`,
  };
}

export function isUpstreamNewer(upstreamVersion: string, appVersion: string): boolean {
  return (
    parseSemver(upstreamVersion) !== null &&
    parseSemver(appVersion) !== null &&
    compareSemverVersions(upstreamVersion, appVersion) > 0
  );
}

/** One desktop notification per upstream version, however often it is checked. */
export function shouldNotifyUpstream(
  release: UpstreamRelease,
  appVersion: string,
  lastNotifiedVersion: string | null,
): boolean {
  return isUpstreamNewer(release.version, appVersion) && release.version !== lastNotifiedVersion;
}
