import type { Meters } from "../shared/types";
import type { ObservationPhase } from "./metricsModel";
import { lastUpdatedText } from "./metricsModel";

function Bar({ label, value, max, text, warn, title, aria, stale }: { label: string; value: number | null; max: number; text: string; warn?: boolean; title: string; aria: string; stale?: boolean }) {
  const pct = value === null ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className={`meter ${stale ? "meter-stale" : ""}`} title={title} role="img" aria-label={aria}>
      <div className="meter-head"><span>{label}</span><span className="muted">{text}</span></div>
      <div className="track"><div className={`fill ${warn ? "warn" : ""}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/**
 * The meters of the AI status panel, with their observation state and PROVENANCE
 * made explicit. Every bar says what its number IS, and the visible text, the
 * tooltip and the accessible description are derived from that one state:
 *  - `phase` is the FEED's freshness (the 30 s contract of metricsModel.ts): fresh
 *    readings draw as numbers; a stale feed draws its last values dimmed with a
 *    "last updated" stamp and a Retry — never looking live; a feed that has never
 *    answered says so with a next action instead of nothing.
 *  - The NPU memory bar has three honest states: MEASURED (the backend's NPU memory
 *    reading), ESTIMATED (the loaded model's file size, marked as such, only while
 *    the loaded model is the selected one — App gates that), or unavailable.
 *  - `npuNote` describes the LOAD counters (the native monitor's utilization note),
 *    so it belongs to the load bar's tooltip alone — never to the memory bar.
 *  - RAM is a system-wide measurement (this whole PC), the NPU load is a device-wide
 *    one (every runtime on the NPU): scope is named in the accessible description.
 * Kept hookless: it renders inside the status panel body and must stay legal after
 * any early return (CONTRIBUTING.md rule 1).
 */
export function MetersBar({ meters, estNpuGB, busy, phase = "fresh", observedAt = 0, onRetry }: {
  meters: Meters | null; estNpuGB?: number | null; busy?: boolean;
  /** The feed's observation phase (App owns the observation metadata). */
  phase?: ObservationPhase;
  /** When the last successful reading landed (for the last-updated stamp). */
  observedAt?: number;
  /** Re-runs the poll right now (the poll effect's own tick — no new subscription). */
  onRetry?: () => void;
}) {
  const retry = onRetry ? <button type="button" className="ghost obs-retry" onClick={onRetry}>Try again</button> : null;

  if (phase === "failed" || phase === "disconnected") {
    return (
      <div className="meters obs-state" role="status">
        <div className="muted small">
          {phase === "disconnected"
            ? "Resource readings unavailable — MKMN's AI service isn't answering right now. The app keeps working with what is saved on this PC."
            : "Resource readings unavailable — no reading has arrived yet."}
          {retry}
        </div>
      </div>
    );
  }
  if (phase === "loading" || !meters) {
    return (
      <div className="meters obs-state" role="status">
        <div className="muted small">Reading resource use…</div>
      </div>
    );
  }
  const stale = phase === "stale";
  const noCounters = meters.npuMemGB === null && meters.npuUtilPercent === null;
  // --- provenance: what each bar's number IS (one state drives text, tooltip, aria) ---
  const why = meters.npuNote ?? undefined;
  // NPU memory: measured > estimated (only when App passed a gated estimate) > unavailable.
  const memMeasured = meters.npuMemGB !== null;
  const memEstimated = !memMeasured && estNpuGB != null && !stale;
  const memTitle = memMeasured ? "NPU memory — measured"
    : memEstimated ? "Model allocation — estimated from the loaded model's file size; Windows exposes no NPU memory counter"
    : "NPU memory unavailable — Windows exposes no memory counter for the NPU";
  const memText = memMeasured ? `${meters.npuMemGB} / ${meters.npuBudgetGB} GB`
    : memEstimated ? `~${estNpuGB} GB est. · limit ${meters.npuBudgetGB} GB`
    : `n/a · limit ${meters.npuBudgetGB} GB`;
  const memAria = memMeasured ? `NPU memory — measured: ${meters.npuMemGB} of ${meters.npuBudgetGB} GB`
    : memEstimated ? `NPU memory — estimated from the loaded model's file size: about ${estNpuGB} GB of a ${meters.npuBudgetGB} GB limit`
    : "NPU memory unavailable — this PC exposes no NPU memory counter";
  // NPU load: a measured device-wide utilization, or an honest absence. `npuNote`
  // explains the LOAD counters, so it lands here and nowhere else.
  const loadMeasured = meters.npuUtilPercent !== null;
  const loadTitle = loadMeasured
    ? (why ?? "NPU activity — measured · the whole NPU device (every runtime on it), not only this app")
    : why ? `NPU activity unavailable — ${why}` : "NPU activity unavailable — the NPU load counters did not answer";
  const loadText = loadMeasured ? `${meters.npuUtilPercent}%`
    : noCounters && busy && !stale ? "working (no counter)" : "n/a";
  const loadAria = loadMeasured
    ? `NPU activity — measured: ${meters.npuUtilPercent}% of the NPU device`
    : "NPU activity unavailable";
  return (
    <div className="meters">
      {stale && (
        <div className="muted small obs-stale-line" role="status">
          Readings stale · last updated {lastUpdatedText(observedAt)}{retry}
        </div>
      )}
      <Bar label="RAM" value={meters.ramPercent} max={100} warn={meters.ramWarning} stale={stale}
        text={`${meters.ramUsedGB} / ${meters.ramTotalGB} GB`}
        title="RAM — measured · system-wide (this whole PC, not just MKMN)"
        aria={`RAM — measured, system-wide: ${meters.ramUsedGB} of ${meters.ramTotalGB} GB in use`} />
      <Bar label="NPU memory" value={meters.npuMemGB ?? (stale ? null : (memEstimated ? (estNpuGB ?? null) : null))} max={meters.npuBudgetGB} stale={stale}
        text={memText} title={memTitle} aria={memAria} />
      <Bar label="NPU load" value={meters.npuUtilPercent} max={100} stale={stale}
        text={loadText} title={loadTitle} aria={loadAria} />
      {noCounters && !stale && why && <div className="muted small" title={why}>Windows gives no NPU counters here. Settings → Developer → Execution verification shows why (the deeper checks there need Developer tools on).</div>}
    </div>
  );
}
