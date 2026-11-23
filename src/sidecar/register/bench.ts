// The benchmark methods of the sidecar: the roster of models to test, the run (start,
// stop, state, results), its report and folder, and importing a run's measurements into
// the Models list. Moved out of main.ts as they were; main.ts owns the benchmark runner,
// the catalog and the host channel, and passes them in.
import { TEST_COUNT, testCosts } from "../../core/bench";
import type { BenchConfig, BenchRunner } from "../../core/benchRunner";
import { ref as entryRef } from "../../core/catalog";
import type { FoundryHost } from "../../core/foundryHost";
import { freeDiskGB, installedState, listInstalled, modelsDir } from "../../core/geniex";
import type { CatalogEntry, InstalledModel } from "../../shared/types";
import type { SidecarDispatcher, SidecarMessage } from "../protocol";

export interface BenchDeps {
  /** The benchmark runner, made on first use. */
  benchRunner: () => BenchRunner;
  /** The run in progress, if one was started. */
  currentBench: () => BenchRunner | null;
  startBench: (cfg: BenchConfig) => Promise<{ ok: boolean; error?: string }>;
  /** Where the runs and their reports are written. */
  benchRoot: () => string;
  benchRosterAll: () => Promise<Awaited<ReturnType<typeof import("../../core/bench").buildRoster>>>;
  foundryHost: () => Promise<FoundryHost | null>;
  allEntries: () => CatalogEntry[];
  isFoundryEntry: (e: CatalogEntry) => boolean;
  geniexExe: () => string;
  /** The stdio channel to the host (answers to host calls come back through the dispatcher). */
  write: (m: SidecarMessage) => Promise<void>;
}

export function registerBench(dispatcher: SidecarDispatcher, { benchRunner, currentBench, startBench, benchRoot, benchRosterAll, foundryHost, allEntries, isFoundryEntry, geniexExe, write }: BenchDeps): void {
  dispatcher.register("benchRoster", async () => {
    // Precision-aware inventory: a repository that only declares Q4_0 does not make a
    // Q8_0 target "installed". A failed list is an unknown state, not an empty cache.
    let listed: InstalledModel[] | null = null;
    try { listed = await listInstalled(geniexExe()); } catch { listed = null; }
    const entries = allEntries();
    // A Foundry model is installed when FOUNDRY's cache holds it, never the GenieX cache:
    // a Foundry entry read against `geniex list` would always show "not installed".
    let foundryCached: Set<string> | null | false = false; // false: not applicable · null: the cache could not be read
    if (entries.some((e) => isFoundryEntry(e))) {
      const f = await foundryHost();
      if (!f) foundryCached = null;
      else {
        const list = await f.cached().catch(() => null);
        foundryCached = list === null ? null : new Set(list.map((v) => v.alias.toLowerCase()));
      }
    }
    const tested = benchRunner().testedKeys();
    return {
      inventoryKnown: listed !== null,
      targets: (await benchRosterAll()).map((t) => {
        const e = entries.find((x) => (t.entryId && x.id === t.entryId) || (t.bundleRef && x.dynamicRef === t.bundleRef));
        const state = !e ? false
          : isFoundryEntry(e) ? (foundryCached === null ? null : foundryCached instanceof Set && foundryCached.has(String(e.repo).toLowerCase()))
          : installedState(e, listed, entryRef(e));
        return { ...t, tested: tested.has(t.key), installed: state === true, installedUnknown: state === null };
      }),
      tests: TEST_COUNT,
      costs: { launch: testCosts("launch"), express: testCosts("express"), quick: testCosts("quick"), full: testCosts("full") },
      freeGB: freeDiskGB(modelsDir()),
      folder: benchRoot()
    };
  });

  dispatcher.register("benchState", () => benchRunner().state());
  // The finished models of the run, without the long texts, for the charts and the table.
  dispatcher.register("benchResults", () => benchRunner().results().map((r) => ({ ...r, tests: r.tests.map((t) => ({ ...t, answer: "", thinking: "" })) })));
  // The report to publish, written next to the results; the bridge shows it in the file manager.
  dispatcher.register("benchExport", async () => {
    const r = await benchRunner().exportReport();
    if (!r) return { ok: false, error: "No finished model yet: there is nothing to export." };
    // The exact file list travels too: the renderer announces only what exists
    // (a launch-only export has no HTML report or charts to point at).
    return { ok: true, dir: r.dir, report: r.report, html: r.html, files: r.files };
  });
  dispatcher.register("benchReveal", async (file: string | null) => {
    // null means "the results folder": the latest run directory (or the bench root when
    // nothing has run yet) — the button was wired to a call that could only answer false.
    const target = typeof file === "string" && file ? file
      : benchRunner().state().runDir ?? benchRoot();
    try { await dispatcher.callHost((m) => { void write(m); }, "revealPath", [target]); return true; } catch { return false; }
  });
  dispatcher.register("benchStart", (cfg: BenchConfig) => startBench(cfg));
  dispatcher.register("benchStop", () => { currentBench()?.stop(); });
  // a completed run's measurements, written to the profiles the Models list reads (they were never shown there before)
  dispatcher.register("benchImportResults", () => benchRunner().importMeasured());
}
