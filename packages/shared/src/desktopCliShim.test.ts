import { describe, expect, it } from "vite-plus/test";

import {
  type CliShimTarget,
  readCliShimRuntime,
  readCliShimTarget,
  renderCliShim,
  standaloneLauncherTarget,
} from "./desktopCliShim.ts";

describe("desktopCliShim", () => {
  it.each<CliShimTarget>([
    {
      kind: "windows",
      executable: "C:\\Users\\it's 100%\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe",
      entry: "C:\\Users\\it's 100%\\AppData\\Local\\Programs\\t3code\\resources\\app.asar\\bin.mjs",
    },
    {
      kind: "appimage",
      appImage: "/home/it's me/Apps/T3-Code-x86_64.AppImage",
      executableName: "t3code",
    },
    {
      kind: "direct",
      executable: "/opt/T3 Code (Beta)/t3code",
      entry: "/opt/T3 Code (Beta)/resources/app.asar/apps/server/dist/bin.mjs",
    },
  ])("reads back the $kind target it wrote", (target) => {
    const shim = renderCliShim({ target, shimPath: "/home/me/.t3/bin/t3", t3Home: "/home/me/.t3" });
    expect(readCliShimTarget(shim)).toEqual(target);
  });

  const windowsTarget: CliShimTarget = {
    kind: "windows",
    executable: "C:\\Program Files (x86)\\T3 Code\\T3 Code.exe",
    entry: "C:\\Program Files (x86)\\T3 Code\\resources\\app.asar\\bin.mjs",
  };
  const posixTarget: CliShimTarget = {
    kind: "direct",
    executable: "/opt/T3 Code/t3code",
    entry: "/opt/T3 Code/resources/app.asar/apps/server/dist/bin.mjs",
  };
  it.each([
    { target: windowsTarget, runtime: "C:\\Users\\me 100%\\.t3\\runtime\\versions\\1.2.3\\t3.exe" },
    { target: windowsTarget, runtime: undefined },
    { target: posixTarget, runtime: "/home/it's me/.t3/runtime/versions/1.2.3/t3" },
    { target: posixTarget, runtime: undefined },
  ])("reads back the $target.kind launcher with runtime $runtime", ({ target, runtime }) => {
    const shim = renderCliShim({
      target,
      shimPath: "/home/me/.t3/bin/t3",
      t3Home: "/home/me/.t3",
      runtime,
    });
    expect(readCliShimTarget(shim)).toEqual(target);
    expect(readCliShimRuntime(shim)).toBe(runtime);
    // `t3 update` takes a t3.cmd's first quoted line as what it runs; that must stay the app.
    if (target.kind === "windows") {
      expect(/^"([^"]+)"/m.exec(shim)?.[1]).toBe(target.executable);
    }
  });

  it.each([
    { contents: '@echo off\r\n"C:\\t3\\t3.exe" %*', platform: "win32", target: "C:\\t3\\t3.exe" },
    {
      contents: '@echo off\r\n"C:\\t3\\t3.exe" %* & exit /b',
      platform: "win32",
      target: "C:\\t3\\t3.exe",
    },
    {
      contents: '@echo off\r\nset X=1\r\n"C:\\t3\\t3.exe" %*',
      platform: "win32",
      target: undefined,
    },
    {
      contents: "#!/bin/sh\nexec '/home/it'\\''s/t3' \"$@\"\n",
      platform: "linux",
      target: "/home/it's/t3",
    },
    { contents: "#!/bin/sh\nset -e\nexec '/t3' \"$@\"\n", platform: "linux", target: undefined },
  ] as const)("reads a standalone launcher's target: $target", ({ contents, platform, target }) => {
    expect(standaloneLauncherTarget(contents, platform)).toBe(target);
  });

  it("ignores a launcher the desktop app did not write", () => {
    expect(readCliShimTarget('@echo off\r\n"C:\\t3\\t3.exe" "x" %*\r\n')).toBeUndefined();
  });
});
