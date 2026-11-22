// Run journals (Workspace\harness\*.jsonl) and offloaded payloads (Workspace\harness\offload\*.txt)
// were kept until removed by hand. The setting privacy.retentionDays removes the ones older than
// that many days, once at sidecar start; its default, null, keeps everything as before.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneForSettings, pruneOlderThan, retentionDaysOf } from "../src/core/retention";
import { SETTINGS_SCHEMA } from "../src/shared/settingsSchema";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 12);
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** A harness folder with its offload folder, and a file in either, aged `days` before NOW. */
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retention-"));
  roots.push(root);
  const journals = path.join(root, "harness");
  const offload = path.join(journals, "offload");
  fs.mkdirSync(offload, { recursive: true });
  const put = (dir: string, name: string, days: number) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "x");
    const t = (NOW - days * DAY) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  };
  return { journals, offload, put };
}

describe("retention of journals and offloaded payloads", () => {
  it("removes the files older than N days and keeps the newer ones", () => {
    const h = harness();
    const oldJournal = h.put(h.journals, "run-old.jsonl", 40);
    const oldPayload = h.put(h.offload, "reply-old.txt", 31);
    h.put(h.journals, "run-new.jsonl", 2);
    h.put(h.offload, "reply-new.txt", 29);
    expect(pruneOlderThan([h.journals, h.offload], 30, NOW).sort()).toEqual([oldJournal, oldPayload].sort());
    expect(fs.readdirSync(h.journals).sort()).toEqual(["offload", "run-new.jsonl"]);
    expect(fs.readdirSync(h.offload)).toEqual(["reply-new.txt"]);
  });

  it("the default, null, removes nothing (today's behaviour)", () => {
    const h = harness();
    h.put(h.journals, "run-old.jsonl", 400);
    expect(retentionDaysOf({})).toBeNull();
    expect(retentionDaysOf({ privacy: { retentionDays: null } })).toBeNull();
    expect(pruneForSettings({}, [h.journals, h.offload], NOW)).toEqual([]);
    expect(pruneForSettings({ privacy: { retentionDays: null } }, [h.journals, h.offload], NOW)).toEqual([]);
    expect(fs.readdirSync(h.journals).sort()).toEqual(["offload", "run-old.jsonl"]);
  });

  it("a value from the settings file is used, and a damaged one removes nothing", () => {
    const h = harness();
    h.put(h.journals, "run-old.jsonl", 40);
    for (const bad of [0, -5, "30", Number.NaN, 1.5, { days: 30 }]) {
      expect(retentionDaysOf({ privacy: { retentionDays: bad } }), String(bad)).toBeNull();
      expect(pruneForSettings({ privacy: { retentionDays: bad } }, [h.journals], NOW)).toEqual([]);
    }
    expect(pruneForSettings({ privacy: { retentionDays: 30 } }, [h.journals], NOW)).toHaveLength(1);
  });

  it("keeps the files an open chat still uses", () => {
    const h = harness();
    const inUse = h.put(h.journals, "run-open.jsonl", 90);
    const payload = h.put(h.offload, "fold-open.txt", 90);
    const done = h.put(h.journals, "run-done.jsonl", 90);
    expect(pruneOlderThan([h.journals, h.offload], 30, NOW, { keep: new Set([inUse, payload]) })).toEqual([done]);
    expect(fs.existsSync(inUse) && fs.existsSync(payload)).toBe(true);
  });

  it("touches only journals and payloads: other files, folders and missing folders are left alone", () => {
    const h = harness();
    const other = h.put(h.journals, "notes.md", 90);
    fs.mkdirSync(path.join(h.journals, "old-folder.jsonl"));
    expect(pruneOlderThan([h.journals, path.join(h.journals, "missing")], 30, NOW)).toEqual([]);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(path.join(h.journals, "old-folder.jsonl"))).toBe(true);
  });

  it("is declared once in the settings schema, off by default", () => {
    const decl = SETTINGS_SCHEMA.find((d) => d.key === "privacy.retentionDays");
    expect(decl?.default).toBeNull();
    expect(decl?.type).toBe("number");
  });
});
