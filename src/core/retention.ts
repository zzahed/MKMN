// How long run journals and offloaded payloads are kept (docs/design/data-at-rest.md).
//
// Journals (Workspace\harness\*.jsonl) hold each step of a turn, the sections sent and the
// replies; offloaded payloads (Workspace\harness\offload\*.txt) hold long replies, folded chat
// history and a project's full knowledge text. They were kept until removed by hand. With the
// setting privacy.retentionDays set, the ones not changed for that many days are removed once
// when the sidecar starts. Its default, null, keeps everything, as before.

import { readdirSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";

const DAY_MS = 86_400_000;
/** Only these are pruned: a journal or a payload. Any other file or folder is never touched. */
const PRUNABLE = /\.(jsonl|txt)$/i;

export interface PruneOptions {
  /** Files an open chat still uses: kept whatever their age. */
  keep?: ReadonlySet<string>;
}

/** The setting as read from settings.json: a whole number of days of at least 1, or null
 *  (keep everything). A missing, damaged or out-of-range value is null: it never removes. */
export function retentionDaysOf(settings: unknown): number | null {
  const v = (settings as { privacy?: { retentionDays?: unknown } } | null)?.privacy?.retentionDays;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * Removes the journals and payloads directly in `dirs` that were last changed more than `days`
 * days before `now`, except those in `keep`. Folders are not entered; a folder that is not there
 * is skipped. Returns the paths removed.
 */
export function pruneOlderThan(dirs: string[], days: number, now: number, opts: PruneOptions = {}): string[] {
  if (!Number.isFinite(days) || days < 1) return [];
  const before = now - days * DAY_MS;
  const removed: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!PRUNABLE.test(name)) continue;
      const file = path.join(dir, name);
      if (opts.keep?.has(file)) continue;
      try {
        const st = statSync(file);
        if (!st.isFile() || st.mtimeMs >= before) continue;
        rmSync(file, { force: true });
        removed.push(file);
      } catch {
        // a file that vanished or cannot be removed is left for the next start
      }
    }
  }
  return removed;
}

/** The start-up pass: prunes `dirs` by the settings' retention, or removes nothing when it is unset. */
export function pruneForSettings(settings: unknown, dirs: string[], now: number, opts: PruneOptions = {}): string[] {
  const days = retentionDaysOf(settings);
  return days === null ? [] : pruneOlderThan(dirs, days, now, opts);
}
