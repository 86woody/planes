import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  validateConfig,
  validateEnvelope,
  validateSession,
} from "../src/index.js";
// @ts-expect-error generate.mjs is plain ESM with no type declarations
import { generate } from "../scripts/generate.mjs";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const SCHEMAS = path.join(PKG, "schemas");
const SCHEMA_FILES = ["session", "ingest", "api", "config", "bridge"].map((f) => `${f}.schema.json`);
const INGEST = path.join(PKG, "fixtures", "ingest");
const SESSIONS = path.join(PKG, "fixtures", "sessions");
const STATES = ["starting", "working", "needs_permission", "needs_input", "idle", "error", "ended", "lost"];

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("@mc/contracts", () => {
  test("CT-01 schema files match contracts.lock.json", () => {
    const lock = JSON.parse(readFileSync(path.join(PKG, "contracts.lock.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(lock).sort()).toEqual([...SCHEMA_FILES].sort());
    for (const f of SCHEMA_FILES) {
      expect(sha256(path.join(SCHEMAS, f)), f).toBe(lock[f]);
    }
  });

  test("CT-02 schemas copied from docs/contracts are byte-identical", () => {
    const docs = path.join(PKG, "..", "..", "docs", "contracts");
    for (const f of ["session", "ingest", "api", "config"]) {
      const name = `${f}.schema.json`;
      expect(readFileSync(path.join(SCHEMAS, name)).equals(readFileSync(path.join(docs, name))), name).toBe(true);
    }
  });

  test("CT-03 every valid ingest fixture validates", () => {
    const files = readdirSync(INGEST).filter((f) => f.endsWith(".json") && !f.startsWith("invalid-"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = validateEnvelope(JSON.parse(readFileSync(path.join(INGEST, f), "utf8")));
      expect(r.ok, `${f}: ${!r.ok ? r.errors.join("; ") : ""}`).toBe(true);
    }
  });

  test("CT-04 invalid-extra-env, invalid-tool-input and invalid-version are rejected", () => {
    for (const f of ["invalid-extra-env", "invalid-tool-input", "invalid-version"]) {
      const r = validateEnvelope(JSON.parse(readFileSync(path.join(INGEST, `${f}.json`), "utf8")));
      expect(r.ok, f).toBe(false);
    }
  });

  test("CT-05 every session fixture validates and covers all 8 states", () => {
    const seen: string[] = [];
    for (const f of readdirSync(SESSIONS).filter((n) => n.endsWith(".json"))) {
      const r = validateSession(JSON.parse(readFileSync(path.join(SESSIONS, f), "utf8")));
      expect(r.ok, `${f}: ${!r.ok ? r.errors.join("; ") : ""}`).toBe(true);
      if (r.ok) seen.push(r.value.state);
    }
    expect([...new Set(seen)].sort()).toEqual([...STATES].sort());
    expect(seen.length).toBe(8);
  });

  test("CT-06 validateConfig({}) returns the documented defaults", () => {
    const r = validateConfig({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value;
    expect(c.port).toBe(47800);
    expect(c.notifications.on.done).toBe(true);
    expect(c.restore.maximize).toBe("always");
    expect(c.sessions.lostAfterHours).toBe(12);
    expect(c.adapters.shell.enabled).toBe(false);
  });

  test("CT-07 validateConfig rejects an unknown key with its instancePath", () => {
    const r = validateConfig({ ui: { bogus: true } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith("/ui "))).toBe(true);
  });

  test("CT-08 generated types are up to date", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "mc-contracts-gen-"));
    try {
      await generate(tmp);
      for (const f of readdirSync(tmp)) {
        expect(readFileSync(path.join(tmp, f), "utf8"), f).toBe(
          readFileSync(path.join(PKG, "src", "generated", f), "utf8"),
        );
      }
      expect(readdirSync(tmp).length).toBe(5);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
