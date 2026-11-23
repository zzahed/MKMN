import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { benchEmbedder, fixtureCorpus, frozenCases, indexTimings, largeCorpus, peakRssMB, REPORT_CASES, reportCorpus, runCase, summarize, type CaseResult } from "./knowledgeBench";

/**
 * The document-retrieval benchmark (tests/knowledgeBench.ts) as a gate: the
 * real chat turn over the frozen fixture corpus and the quarterly-report
 * corpus. `MKMN_BENCH_OUT=<file>` writes the whole report as JSON.
 */
const report: Record<string, unknown> = {};
const dirs: string[] = [];
afterAll(() => {
  if (process.env.MKMN_BENCH_OUT) fs.writeFileSync(process.env.MKMN_BENCH_OUT, JSON.stringify(report, null, 2), "utf8");
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("the document-retrieval benchmark", () => {
  it("runs every case through the real turn and reports recall, accuracy, calls, sizes and times", { timeout: 600_000 }, async () => {
    const fixtures = await fixtureCorpus();
    const reports = reportCorpus();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-bench-"));
    dirs.push(dir);
    report.index = {
      fixtures: indexTimings(fixtures, dir, "idx-fixtures", "How many seats does the reading room have?"),
      reports: indexTimings(reports, dir, "idx-reports", "What was Northwind's revenue in Q3 2026?"),
      large: indexTimings(largeCorpus(), dir, "idx-large", "lease liabilities item 42017 amount"),
    };
    const rows: CaseResult[] = [];
    const embedder = await benchEmbedder();
    report.vectors = embedder ? embedder.id : null;
    // each case twice: cold (a fresh store) then warm (the same store and process)
    for (const pass of ["cold", "warm"] as const) {
      const passDir = pass === "cold" ? fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-bench-")) : dirs.at(-1)!;
      if (pass === "cold") dirs.push(passDir);
      for (const c of [...frozenCases(), ...REPORT_CASES]) {
        const r = await runCase(c, c.project === "fixtures" ? fixtures : reports, passDir, embedder);
        if (pass === "warm") rows.push(r);
        else ((report.coldHostMs ??= {}) as Record<string, number>)[c.id] = r.hostMs;
      }
    }
    const groups = [...new Set(rows.map((r) => r.group))];
    report.summary = summarize(rows);
    report.byGroup = Object.fromEntries(groups.map((g) => [g, summarize(rows.filter((r) => r.group === g))]));
    report.coldHostMsP50 = (() => { const xs = Object.values(report.coldHostMs as Record<string, number>).sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)]; })();
    report.peakRssMB = peakRssMB();
    report.rows = rows;
    expect(rows.length).toBe(frozenCases().length + REPORT_CASES.length);
  });
});
