// The desktop app rewrites `<T3 home>/bin/t3` (or `t3.cmd`) on every launch, so the t3 command
// finds the installed app through it. AppImage mounts change each run; the launcher must mount
// the image itself.

export const DESKTOP_CLI_SHIM_MARKER = "Written by T3 Code: runs the desktop app's bundled t3 CLI.";

export const DESKTOP_CLI_SHIM_SERVER_ENTRY = "apps/server/dist/bin.mjs";
const MARKER = DESKTOP_CLI_SHIM_MARKER;
const SERVER_ENTRY = DESKTOP_CLI_SHIM_SERVER_ENTRY;

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
/** cmd.exe expands `%` even inside quotes; Windows paths cannot contain `"`. */
const cmdText = (value: string) => value.replaceAll("%", "%%");
const cmdWord = (value: string) => `"${cmdText(value)}"`;

const MOVED = "T3 Code has moved or been removed. Open the app once to update this command.";

export type CliShimTarget =
  | { readonly kind: "appimage"; readonly appImage: string; readonly executableName: string }
  | { readonly kind: "direct"; readonly executable: string; readonly entry: string }
  | { readonly kind: "windows"; readonly executable: string; readonly entry: string };

/** Embed this install's home and executable path so `sudo`, which clears the environment, uses the same install. */
export const renderCliShim = (input: {
  readonly target: CliShimTarget;
  readonly shimPath: string;
  readonly t3Home: string;
}) => {
  const { target } = input;
  if (target.kind === "windows") {
    const utf8 = [target.executable, target.entry, input.shimPath, input.t3Home].some((value) =>
      [...value].some((character) => character.codePointAt(0)! > 0x7f),
    );
    const restore = utf8 ? ["chcp %t3_codepage% >nul"] : [];
    return [
      "@echo off",
      `rem ${MARKER}`,
      // Delayed expansion would rewrite `!name!` in paths and arguments.
      "setlocal EnableExtensions DisableDelayedExpansion",
      // Ctrl-C skips codepage restoration, so switch to UTF-8 only for non-ASCII install paths.
      ...(utf8
        ? [
            `for /f "tokens=2 delims=:." %%c in ('chcp') do set "t3_codepage=%%c"`,
            "chcp 65001 >nul",
          ]
        : []),
      `set "T3CODE_CLI_PATH=${cmdText(input.shimPath)}"`,
      `if not defined T3CODE_HOME set "T3CODE_HOME=${cmdText(input.t3Home)}"`,
      'set "ELECTRON_RUN_AS_NODE=1"',
      // Electron's Windows executable starts without stdin; this tells the CLI to reopen the console.
      'set "T3CODE_DESKTOP_CLI_LAUNCHER=1"',
      // A goto, not a parenthesized block: "Program Files (x86)" would close the block early.
      `if exist ${cmdWord(target.executable)} goto run`,
      ...restore,
      `echo ${MOVED} 1>&2`,
      "exit /b 127",
      ":run",
      `${cmdWord(target.executable)} ${cmdWord(target.entry)} %*`,
      'set "t3_exit=%ERRORLEVEL%"',
      ...restore,
      "exit /b %t3_exit%",
      "",
    ].join("\r\n");
  }
  const header = [
    "#!/bin/sh",
    `# ${MARKER}`,
    `export T3CODE_CLI_PATH=${shellWord(input.shimPath)}`,
    `home=${shellWord(input.t3Home)}`,
    'export T3CODE_HOME="${T3CODE_HOME:-$home}"',
    "export ELECTRON_RUN_AS_NODE=1",
    `app=${shellWord(target.kind === "appimage" ? target.appImage : target.executable)}`,
    'if [ ! -x "$app" ]; then',
    `  echo "${MOVED}" >&2`,
    "  exit 127",
    "fi",
  ];
  if (target.kind === "direct") {
    return [...header, `exec "$app" ${shellWord(target.entry)} "$@"`, ""].join("\n");
  }
  const run = (root: string) =>
    `"${root}/${target.executableName}" "${root}/resources/app.asar/${SERVER_ENTRY}" "$@"`;
  return [
    ...header,
    // Extract-and-run would make the runtime start the app instead of mounting it.
    "unset APPIMAGE_EXTRACT_AND_RUN",
    // Its own session keeps a group signal (Ctrl-C, SSH hangup) from unmounting it under the
    // running server; the traps unmount it after. Without setsid the extract fallback runs.
    "work=$(mktemp -d) || exit 1",
    'setsid "$app" --appimage-mount >"$work/mount" 2>/dev/null &',
    "mounter=$!",
    `trap 'kill "$mounter" 2>/dev/null; rm -rf "$work"' EXIT`,
    "trap 'exit 130' INT TERM HUP",
    "mount=",
    'while kill -0 "$mounter" 2>/dev/null; do',
    '  mount=$(head -n 1 "$work/mount")',
    '  [ -d "$mount" ] && break',
    "  mount=",
    "  sleep 0.05",
    "done",
    // Without FUSE the runtime cannot mount (it prints why and exits); extracting the image still works.
    'if [ -z "$mount" ]; then',
    '  (cd "$work" && "$app" --appimage-extract >/dev/null) || { echo "Could not open $app." >&2; exit 1; }',
    '  mount="$work/squashfs-root"',
    "fi",
    // The runtime sets this when it launches the app; the CLI skips its path-keyed compile cache on it.
    'export APPIMAGE="$app"',
    run("$mount"),
    "",
  ].join("\n");
};

const unshellWord = (word: string): string | undefined =>
  /^(?:'[^']*'|"'")+$/.test(word)
    ? Array.from(word.matchAll(/'([^']*)'|"(')"/g), (match) => match[1] ?? match[2]).join("")
    : undefined;

/** What a launcher the desktop app wrote runs; undefined for any other file. */
export const readCliShimTarget = (contents: string): CliShimTarget | undefined => {
  if (!contents.includes(MARKER)) return undefined;
  const windows = /^"([^"]+)" "([^"]+)" %\*\r?$/m.exec(contents);
  if (windows?.[1] !== undefined && windows[2] !== undefined) {
    return {
      kind: "windows",
      executable: windows[1].replaceAll("%%", "%"),
      entry: windows[2].replaceAll("%%", "%"),
    };
  }
  const app = unshellWord(/^app=(.+)$/m.exec(contents)?.[1] ?? "");
  if (app === undefined) return undefined;
  const direct = /^exec "\$app" (.+) "\$@"$/m.exec(contents)?.[1];
  if (direct !== undefined) {
    const entry = unshellWord(direct);
    return entry === undefined ? undefined : { kind: "direct", executable: app, entry };
  }
  const executableName = /^"\$mount\/([^"]+)" "\$mount\/resources\/app\.asar\//m.exec(
    contents,
  )?.[1];
  return executableName === undefined
    ? undefined
    : { kind: "appimage", appImage: app, executableName };
};
