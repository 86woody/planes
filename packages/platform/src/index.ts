import type { PlatformAdapter, PlatformEnv } from "./types.js";
import { NullPlatform } from "./null.js";
import { FakePlatform } from "./fake/index.js";

export type * from "./types.js";
export { NullPlatform } from "./null.js";
export { FakePlatform } from "./fake/index.js";
export { exec, which, semaphore } from "./exec.js";
export type { Exec, ExecResult } from "./exec.js";
export { ancestry, processAlive, processStartTime, commandLine, ttyOf } from "./process/index.js"; // D-25
export {
  AUMID,
  AUMID_KEY,
  PROTOCOL,
  PROTOCOL_KEY,
  protocolCommand,
  restoreVbs,
  registerAumid,
  registerProtocol,
  unregisterAll,
} from "./windows/registry.js"; // D-30: Windows registry writers for the T051 installers (reg.exe via exec; safe to import on any OS)
export type { ProtocolOptions } from "./windows/registry.js";

/** MC_PLATFORM=fake -> fake; else by process.platform; anything else -> NullPlatform (platform-adapter.md 2). */
export async function createPlatform(env: PlatformEnv): Promise<PlatformAdapter> {
  if (env.displayEnv().MC_PLATFORM === "fake") return new FakePlatform();
  switch (process.platform) {
    case "win32":
      return (await import("./windows/index.js")).create(env);
    case "darwin":
      return (await import("./macos/index.js")).create(env);
    case "linux":
      return (await import("./linux/index.js")).create(env);
    default:
      return new NullPlatform();
  }
}
