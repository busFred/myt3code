import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  desktopAppAssetFileName,
  newestCliReleaseVersion,
  parseChecksums,
  parseReleaseBuild,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });

  // Names as published on the fork's releases; SHA256SUMS lookups are by exact name.
  it.each([
    ["1.2.3", "nsis", "x64", "T3-Code-1.2.3-x64.exe"],
    ["1.2.3", "nsis", "arm64", "T3-Code-1.2.3-arm64.exe"],
    ["1.2.3", "deb", "x64", "T3-Code-1.2.3-amd64.deb"],
    ["1.2.3", "deb", "arm64", "T3-Code-1.2.3-arm64.deb"],
    ["1.2.3", "appimage", "x64", "T3-Code-x86_64.AppImage"],
    ["1.2.3", "appimage", "arm64", "T3-Code-arm64.AppImage"],
    ["1.2.4-nightly.20260912.7", "appimage", "x64", "T3-Code-Nightly-x86_64.AppImage"],
    [
      "1.2.4-preview.20260912.8",
      "appimage",
      "x64",
      "T3-Code-1.2.4-preview.20260912.8-x86_64.AppImage",
    ],
    ["1.2.3", "nsis", "ia32", undefined],
  ] as const)("names the %s %s %s app installer", (version, kind, arch, expected) => {
    expect(desktopAppAssetFileName(version, kind, arch)).toBe(expected);
  });

  it("reads a BUILD file's commit and rejects anything else", () => {
    expect(parseReleaseBuild("7FDB4DDF7C12\n")).toBe("7fdb4ddf7c12");
    expect(parseReleaseBuild("archive")).toBeUndefined();
    expect(parseReleaseBuild("")).toBeUndefined();
  });
});
