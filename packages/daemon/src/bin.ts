#!/usr/bin/env node
import { startDaemon, AlreadyRunning, ConfigInvalid, PortInUse } from "./main.js";

try {
  await startDaemon({ env: process.env, foreground: true });
} catch (err) {
  if (err instanceof AlreadyRunning) {
    console.log(`already running pid=${err.pid} port=${err.port}`);
    process.exit(0);
  }
  if (err instanceof ConfigInvalid) {
    for (const line of err.errors) console.error(line);
    process.exit(2);
  }
  if (err instanceof PortInUse) {
    console.error(`port ${err.port} in use`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
