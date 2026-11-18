import path from "node:path";
import { exec as defaultExec, type Exec } from "../exec.js";

export const AUMID = "WoodyDeus.MissionControl";
export const PROTOCOL = "mission-control";
export const AUMID_KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;
export const PROTOCOL_KEY = `HKCU\\Software\\Classes\\${PROTOCOL}`;

export interface ProtocolOptions {
  mode: "shim" | "direct";
  stateDir: string;
  nodePath: string;
  mcJsPath: string;
}

function reject(name: string, value: string): void {
  if (value.includes('"')) throw new Error(`${name} must not contain a double quote: ${value}`);
}

/** The shell\open\command value for the protocol (windows.md 5.1). */
export function protocolCommand(opts: ProtocolOptions): string {
  if (opts.mode === "shim") {
    return `wscript.exe "${path.win32.join(opts.stateDir, "restore.vbs")}" "%1"`;
  }
  return `"${opts.nodePath}" "${opts.mcJsPath}" restore "%1" --from-notification`;
}

/**
 * The restore.vbs shim text (windows.md 5.1). Launches node with no console window; its guard
 * accepts exactly one argument that has no double quote and starts with mission-control://.
 */
export function restoreVbs(nodePath: string, mcJsPath: string): string {
  reject("nodePath", nodePath);
  reject("mcJsPath", mcJsPath);
  return [
    "If WScript.Arguments.Count <> 1 Then WScript.Quit 2",
    "u = WScript.Arguments(0)",
    'If InStr(u, """") > 0 Or Left(LCase(u), 18) <> "mission-control://" Then WScript.Quit 2',
    `CreateObject("WScript.Shell").Run """${nodePath}"" ""${mcJsPath}"" restore """ & u & """ --from-notification", 0, False`,
    "",
  ].join("\r\n");
}

/** reg.exe add argument arrays for the AUMID key (windows.md 5.1). */
export function aumidCommands(iconPath: string): string[][] {
  return [
    ["add", AUMID_KEY, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Mission Control", "/f"],
    ["add", AUMID_KEY, "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath, "/f"],
  ];
}

/** reg.exe add argument arrays for the mission-control protocol (windows.md 5.1). */
export function protocolCommands(command: string): string[][] {
  return [
    ["add", PROTOCOL_KEY, "/ve", "/t", "REG_SZ", "/d", "URL:Mission Control", "/f"],
    ["add", PROTOCOL_KEY, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"],
    ["add", `${PROTOCOL_KEY}\\shell\\open\\command`, "/ve", "/t", "REG_SZ", "/d", command, "/f"],
  ];
}

/** Every reg.exe add that windows.md 5.1 specifies, in order. */
export function regCommands(opts: { iconPath: string; protocolCommand: string }): string[][] {
  return [...aumidCommands(opts.iconPath), ...protocolCommands(opts.protocolCommand)];
}

async function runAll(run: Exec, commands: string[][]): Promise<void> {
  for (const args of commands) {
    const r = await run("reg.exe", args);
    if (r.code !== 0) {
      throw new Error(`reg.exe ${args[0]} ${args[1]} failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }
}

export async function registerAumid(iconPath: string, run: Exec = defaultExec): Promise<void> {
  await runAll(run, aumidCommands(iconPath));
}

/**
 * Writes the protocol keys. In shim mode also returns the restore.vbs text; the installer
 * writes it to `<stateDir>\restore.vbs`.
 */
export async function registerProtocol(
  opts: ProtocolOptions,
  run: Exec = defaultExec,
): Promise<{ restoreVbs?: string }> {
  reject("stateDir", opts.stateDir);
  reject("nodePath", opts.nodePath);
  reject("mcJsPath", opts.mcJsPath);
  const command = protocolCommand(opts);
  await runAll(run, protocolCommands(command));
  return opts.mode === "shim" ? { restoreVbs: restoreVbs(opts.nodePath, opts.mcJsPath) } : {};
}

/** Deletes the AUMID and protocol keys (with their subkeys). A key that is already absent is not an error. */
export async function unregisterAll(run: Exec = defaultExec): Promise<void> {
  for (const key of [AUMID_KEY, PROTOCOL_KEY]) {
    await run("reg.exe", ["delete", key, "/f"]);
  }
}
