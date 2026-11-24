import { describe, expect, it } from "vite-plus/test";

import { type CliShimTarget, readCliShimTarget, renderCliShim } from "./desktopCliShim.ts";

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

  it("ignores a launcher the desktop app did not write", () => {
    expect(readCliShimTarget('@echo off\r\n"C:\\t3\\t3.exe" "x" %*\r\n')).toBeUndefined();
  });
});
