import { existsSync, readFileSync } from "node:fs";

const D = "packages/daemon/src/";
const U = "packages/ui/src/";
const P = "packages/platform/src/";
const osFiles = (os) => [
  { file: `${P}${os}/index.ts`, exports: ["create"] },
  { file: `${P}${os}/discover.ts`, exports: ["Discover", "createDiscover"] },
  { file: `${P}${os}/focus.ts`, exports: ["createFocus"] },
  { file: `${P}${os}/notify.ts`, exports: ["createNotify"] },
];
const cmd = (n) => ({ file: `packages/cli/src/commands/${n}.ts`, exports: ["run"] });

const STUBS = [
  { file: `${D}internal.ts`, exports: ["Clock", "Logger", "Paths", "ConfigStore", "SessionRecord", "SessionChange", "SessionService", "PersistedState", "Persistence", "BridgeWindow", "BridgeRegistry", "FocusService", "Notifier", "Liveness", "Auth", "CapabilitiesCache", "DaemonDeps"] },
  { file: `${D}paths.ts`, exports: ["resolvePaths"] },
  { file: `${D}config.ts`, exports: ["loadConfig"] },
  { file: `${D}auth.ts`, exports: ["createAuth"] },
  { file: `${D}security.ts`, exports: ["registerSecurity", "Realm"] },
  { file: `${D}persistence.ts`, exports: ["createPersistence"] },
  { file: `${D}sessions.ts`, exports: ["createSessionService"] },
  { file: `${D}bridge.ts`, exports: ["createBridgeRegistry"] },
  { file: `${D}notifier.ts`, exports: ["createNotifier"] },
  { file: `${D}focus.ts`, exports: ["createFocusService"] },
  { file: `${D}liveness.ts`, exports: ["createLiveness"] },
  { file: `${D}git.ts`, exports: ["readGit"] },
  { file: `${D}app.ts`, exports: ["buildApp"] },
  { file: `${D}main.ts`, exports: ["startDaemon"] },
  { file: `${U}model.ts`, exports: ["Link", "BoardState", "BoardActions", "CardProps", "BarProps"] },
  { file: `${U}App.tsx`, exports: ["App"] },
  { file: `${U}components/Bar.tsx`, exports: ["Bar"] },
  { file: `${U}components/Banner.tsx`, exports: ["Banner"] },
  { file: `${U}components/Empty.tsx`, exports: ["Empty"] },
  { file: `${U}components/Card.tsx`, exports: ["Card"] },
  { file: `${U}components/Lamp.tsx`, exports: ["Lamp"] },
  { file: `${U}format.ts`, exports: ["stateLabel", "signalOf", "hostBadge", "hms", "age", "fixText"] },
  { file: `${U}store.ts`, exports: ["useBoard"] },
  { file: `${U}api.ts`, exports: ["api"] },
  { file: `${U}sort.ts`, exports: ["sortSessions", "pollItems", "counts"] },
  { file: `${U}components/Board.tsx`, exports: ["Board"] },
  { file: `${U}components/PollStrip.tsx`, exports: ["PollStrip"] },
  { file: `${U}components/Counts.tsx`, exports: ["Counts"] },
  { file: "packages/core/src/index.ts", exports: ["reduce", "ReducerOptions", "CoreEvent", "SessionCursor", "decide", "decideRenotify", "Coalescer", "NotifyContext", "NotifyDecision", "classifyHost", "VSCODE_NAMES", "SHELL_NAMES", "LINUX_TERMINALS", "CallsignAllocator", "summarize"] },
  { file: "packages/core/src/attention.ts", exports: ["reduce", "ReducerOptions", "CoreEvent", "SessionCursor"] },
  { file: "packages/core/src/notify-policy.ts", exports: ["decide", "decideRenotify", "Coalescer", "NotifyContext", "NotifyDecision"] },
  { file: "packages/core/src/classify.ts", exports: ["classifyHost", "VSCODE_NAMES", "SHELL_NAMES", "LINUX_TERMINALS"] },
  { file: "packages/core/src/callsign.ts", exports: ["CallsignAllocator"] },
  { file: "packages/core/src/summary.ts", exports: ["summarize"] },
  { file: `${P}index.ts`, exports: ["createPlatform"] },
  { file: `${P}types.ts`, exports: ["NativeWindow", "InnerSelector", "ResolvedTarget", "FocusOptions", "NotifyHandle", "PlatformAdapter", "PlatformEnv", "PlatformFactory"] },
  { file: `${P}exec.ts`, exports: ["ExecResult", "Exec", "exec", "which", "semaphore"] },
  { file: `${P}process/index.ts`, exports: ["ancestry", "processAlive", "processStartTime", "commandLine", "ttyOf"] },
  { file: `${P}linux/dbus-service.ts`, exports: ["getDaemonService"] },
  ...["windows", "macos", "linux"].flatMap(osFiles),
  { file: "packages/contracts/src/index.ts", exports: ["validateSession", "validateEnvelope", "validateConfig", "validateWsServerMessage", "validateBridgeClientMessage", "validateBridgeServerMessage"] },
  { file: "packages/cli/src/main.ts", exports: ["Io", "main"] },
  ...["start", "stop", "status", "daemon", "open", "restore", "token", "doctor", "install", "uninstall"].map(cmd),
];

const missing = [];
for (const { file, exports } of STUBS) {
  if (!existsSync(file)) {
    missing.push(`STUBS MISSING ${file}:(file)`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const name of exports) {
    const re = new RegExp("export[^;]*?\\b" + name + "\\b");
    if (!re.test(text)) missing.push(`STUBS MISSING ${file}:${name}`);
  }
}
if (missing.length > 0) {
  console.log(missing.join("\n"));
  process.exit(1);
}
const n = STUBS.length;
console.log(`STUBS OK ${n}/${n}`);
