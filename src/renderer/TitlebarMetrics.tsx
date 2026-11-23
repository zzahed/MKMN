import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_METRICS, formatAccelerator, formatPercent, formatProcessCpu, formatProcessRam, lastUpdatedText, livePills, metricsAreLive, statusBadgeKind, type SystemMetricsPayload } from "./metricsModel";

export const TitlebarMetrics: React.FC = () => {
  // --- Hooks placed strictly at the top (CONTRIBUTING.md rule 1) ---
  const [metrics, setMetrics] = useState<SystemMetricsPayload>(DEFAULT_METRICS);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  // re-renders the staleness verdict: a payload that goes past MAX_METRICS_AGE_MS
  // must flip to "—" even when no event ever arrives to say so (M08)
  const [, setTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // the event subscription is registered once: read the flyout state through a ref
  const flyoutOpenRef = useRef(false);
  flyoutOpenRef.current = flyoutOpen;

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFlyoutOpen(false);
      }
    };
    if (flyoutOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [flyoutOpen]);

  useEffect(() => {
    const hasTauri =
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

    if (!hasTauri) return;

    // Fetch initial state
    void invoke<SystemMetricsPayload>("get_system_metrics")
      .then((data) => {
        if (data && data.processes && data.processes.length > 0) {
          setMetrics(data);
        }
      })
      .catch((err: unknown) => {
        console.warn("[TitlebarMetrics] get_system_metrics failed:", err);
      });

    // Subscribe to live push updates. With the flyout closed only the pills matter:
    // an unchanged reading (idle RAM/CPU round to the same numbers) is skipped, so a
    // quiet machine does not re-render the titlebar twice a second.
    const unlistenPromise = listen<SystemMetricsPayload>("metrics_update", (event) => {
      if (!event.payload) return;
      setMetrics((cur) => {
        if (!flyoutOpenRef.current && cur.timestamp !== 0) {
          const p = event.payload;
          const pillsSame =
            p.pills?.cpu === cur.pills.cpu && p.pills?.gpu === cur.pills.gpu && p.pills?.npu === cur.pills.npu &&
            p.pills?.npuActive === cur.pills.npuActive && p.pills?.ram === cur.pills.ram && p.pills?.power === cur.pills.power;
          const totalsSame =
            p.mkmnTotal?.cpuPercent === cur.mkmnTotal.cpuPercent && p.mkmnTotal?.ramPercent === cur.mkmnTotal.ramPercent &&
            p.systemTotal?.cpuPercent === cur.systemTotal.cpuPercent && p.systemTotal?.ramPercent === cur.systemTotal.ramPercent;
          // An unchanged reading still carries a FRESH timestamp: returning `cur`
          // whole kept the old payload's timestamp, so a healthy stream of identical
          // samples (an idle machine rounds to the same numbers) aged into "stale"
          // while events kept arriving. Only the VALUES are deduplicated; the
          // heartbeat is preserved.
          if (pillsSame && totalsSame) return { ...cur, timestamp: p.timestamp };
        }
        return event.payload;
      });
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // M08: opening the flyout asks for a FRESH sample instead of displaying
  // whatever the last hidden-cadence (up to 10 s old) or stale cached payload
  // holds; the monitor loop keeps its cadence, this is a one-off catch-up.
  const toggleFlyout = () => {
    const opening = !flyoutOpenRef.current;
    setFlyoutOpen(opening);
    if (opening) {
      const hasTauri =
        typeof window !== "undefined" &&
        ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
      if (hasTauri) {
        void invoke<SystemMetricsPayload>("get_system_metrics")
          .then((data) => {
            if (data && data.processes) setMetrics(data);
          })
          .catch(() => {});
      }
    }
  };

  const handleOpenTaskMgr = (e: React.MouseEvent) => {
    e.stopPropagation();
    const hasTauri =
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
    if (hasTauri) {
      void invoke("open_task_manager");
    }
  };

  const { pills: rawPills, processes, mkmnTotal, systemTotal } = metrics;
  // before the first real measurement the pills and the table show "—" instead of numbers that were never read
  const live = metricsAreLive(metrics);
  const pct = (v: number) => formatPercent(v, live);
  // every pill and every raw numeric readout is gated on freshness (M08): a stale
  // payload reads "—" everywhere, never minutes-old numbers
  const pills = livePills(rawPills, live);

  return (
    <div
      className="titlebar-hud"
      ref={containerRef}
      data-tauri-drag-region="false"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      {/* 5 Metric Pills */}
      <button
        type="button"
        className={`hud-pill hud-secondary ${flyoutOpen ? "active" : ""}`}
        title={`Activity: ${pills.power} (an estimate, not a wattage)\n${pills.powerTooltip}\nClick to view full resource breakdown`}
        onClick={toggleFlyout}
        data-tauri-drag-region="false"
      >
        <span style={{ opacity: 0.7 }}>⚡</span>
        <span>{pills.power}</span>
      </button>

      <button
        type="button"
        className={`hud-pill hud-secondary ${flyoutOpen ? "active" : ""}`}
        title={`MKMN CPU: ${pills.cpu}\nSystem Total: ${pct(systemTotal.cpuPercent)}\nClick to inspect process tree`}
        onClick={toggleFlyout}
        data-tauri-drag-region="false"
      >
        <span>{pills.cpu}</span>
      </button>

      <button
        type="button"
        className={`hud-pill hud-secondary ${flyoutOpen ? "active" : ""}`}
        title={`Qualcomm Adreno GPU: ${pills.gpu}\nClick to inspect process tree`}
        onClick={toggleFlyout}
        data-tauri-drag-region="false"
      >
        <span>{pills.gpu}</span>
      </button>

      <button
        type="button"
        className={`hud-pill ${pills.npuActive ? "npu-pulse" : ""} ${flyoutOpen ? "active" : ""}`}
        title={`Qualcomm Hexagon NPU: ${pills.npu}\n${!live ? "Readings are stale — waiting for fresh measurements" : pills.npuActive ? "NPU device busy (Hexagon HTP engine pegged) — a device-wide reading; it does not by itself prove which model is executing" : pills.npu.includes("N/A") ? "NPU counters unavailable" : "Idle / Standby"}\nClick to inspect process tree`}
        onClick={toggleFlyout}
        data-tauri-drag-region="false"
      >
        {pills.npuActive && <span className="hud-pill-dot" />}
        <span>{pills.npu}</span>
      </button>

      <button
        type="button"
        className={`hud-pill hud-secondary ${flyoutOpen ? "active" : ""}`}
        title={`MKMN RAM: ${pills.ram}${live ? ` (${pills.ramMB.toFixed(0)} MB)` : ""}\nSystem: ${live ? `${systemTotal.ramUsedGB.toFixed(1)} / ${systemTotal.ramTotalGB.toFixed(0)} GB (${systemTotal.ramPercent.toFixed(1)}%)` : "unavailable"}\nClick to inspect process tree`}
        onClick={toggleFlyout}
        data-tauri-drag-region="false"
      >
        <span>{pills.ram}</span>
      </button>

      {/* Flyout Inspector Popover */}
      {flyoutOpen && (
        <div
          className="metrics-flyout"
          data-tauri-drag-region="false"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="metrics-flyout-header">
            <div className="metrics-flyout-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2">
                <rect x="2" y="2" width="20" height="20" rx="4" />
                <path d="M6 12h3l2-5 3 10 2-5h2" />
              </svg>
              <span>MKMN Resource Inspector</span>
              <span className="metrics-flyout-badge">Hexagon NPU</span>
            </div>

            <div className="metrics-flyout-actions">
              <span className="metrics-flyout-syscpu">
                System Total: {pct(systemTotal.cpuPercent)} CPU
              </span>
              <button
                type="button"
                className="metrics-flyout-btn"
                title="Launch Windows 11 Task Manager"
                onClick={handleOpenTaskMgr}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <span>Task Manager</span>
              </button>
            </div>
          </div>

          {/* Structured Process Tree Table */}
          <table className="metrics-table">
            <thead>
              <tr>
                <th style={{ minWidth: "220px" }}>Component Name</th>
                <th style={{ width: "65px", textAlign: "right" }}>PID</th>
                <th style={{ width: "70px", textAlign: "right" }}>CPU %</th>
                <th style={{ width: "120px", textAlign: "right" }}>RAM (MB/%)</th>
                <th style={{ width: "65px", textAlign: "right" }}>NPU %</th>
                <th style={{ width: "65px", textAlign: "right" }}>GPU %</th>
                <th style={{ width: "125px", textAlign: "right" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {!live && (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--muted)", padding: "14px 0" }}>
                    {metrics.timestamp > 0
                      ? `Readings are stale — the last sample arrived ${lastUpdatedText(metrics.timestamp)}. Close and reopen this panel to ask for a fresh one.`
                      : "Metrics unavailable — no measurements received yet."}
                  </td>
                </tr>
              )}
              {processes.map((proc, idx) => {
                const isSubchild = proc.depth > 0;
                return (
                  <tr key={`${proc.pid}-${idx}`}>
                    <td>
                      <div className="metrics-comp-name" style={{ paddingLeft: isSubchild ? "16px" : "0px" }}>
                        <span style={{ opacity: 0.6, fontSize: "10px", width: "12px", display: "inline-block" }}>
                          {isSubchild ? "└─" : "▾"}
                        </span>
                        <span>{proc.name}</span>
                      </div>
                    </td>
                    <td style={{ textAlign: "right", color: "var(--muted)" }}>
                      {proc.pid > 0 ? proc.pid : "—"}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: proc.cpuPercent > 0.5 ? 600 : 400 }}>
                      {formatProcessCpu(proc.cpuPercent, live)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatProcessRam(proc, live)}
                    </td>
                    <td
                      style={{
                        textAlign: "right",
                        color: proc.npuPercent > 0 ? "var(--green)" : "inherit",
                        fontWeight: proc.npuPercent > 0 ? 600 : 400,
                      }}
                    >
                      {formatAccelerator(proc.npuPercent, live, systemTotal.npuAvailable)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatAccelerator(proc.gpuPercent, live, systemTotal.gpuAvailable, 1)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {statusBadgeKind(proc.status) === "eco" ? (
                        <span className="status-badge eco">🍃 EcoQoS</span>
                      ) : statusBadgeKind(proc.status) === "htp" ? (
                        <span className="status-badge htp">⚡ Hexagon HTP</span>
                      ) : (
                        <span className="status-badge standby">{proc.status}</span>
                      )}
                    </td>
                  </tr>
                );
              })}

              {/* Total MKMN Footprint */}
              <tr className="total-row">
                <td>
                  <div className="metrics-comp-name" style={{ fontWeight: 600 }}>
                    <span>Total MKMN Footprint</span>
                  </div>
                </td>
                <td style={{ textAlign: "right", color: "var(--muted)" }}>—</td>
                <td style={{ textAlign: "right" }}>{pct(mkmnTotal.cpuPercent)}</td>
                <td style={{ textAlign: "right" }}>
                  {live ? `${mkmnTotal.ramMB.toFixed(0)} MB (${mkmnTotal.ramPercent.toFixed(1)}%)` : "—"}
                </td>
                <td style={{ textAlign: "right", color: mkmnTotal.npuPercent > 0 ? "var(--green)" : "inherit" }}>
                  {formatAccelerator(mkmnTotal.npuPercent, live, systemTotal.npuAvailable)}
                </td>
                <td style={{ textAlign: "right" }}>
                  {formatAccelerator(mkmnTotal.gpuPercent, live, systemTotal.gpuAvailable, 1)}
                </td>
                <td style={{ textAlign: "right" }}>
                  <span className="status-badge htp" style={{ background: "rgba(16, 185, 129, 0.2)" }}>
                    {mkmnTotal.status}
                  </span>
                </td>
              </tr>

              {/* System-Wide Capacity */}
              <tr className="system-row">
                <td>
                  <div className="metrics-comp-name">
                    <span>System-Wide Capacity{live ? ` (${systemTotal.ramTotalGB.toFixed(0)} GB Unified)` : ""}</span>
                  </div>
                </td>
                <td style={{ textAlign: "right", color: "var(--muted)" }}>—</td>
                <td style={{ textAlign: "right" }}>{pct(systemTotal.cpuPercent)}</td>
                <td style={{ textAlign: "right" }}>
                  {live ? `${systemTotal.ramUsedGB.toFixed(1)} GB (${systemTotal.ramPercent.toFixed(1)}%)` : "—"}
                </td>
                <td style={{ textAlign: "right" }}>{formatAccelerator(systemTotal.npuPercent, live, systemTotal.npuAvailable)}</td>
                <td style={{ textAlign: "right" }}>{formatAccelerator(systemTotal.gpuPercent, live, systemTotal.gpuAvailable, 1)}</td>
                <td style={{ textAlign: "right" }}>
                  <span className="status-badge standby">{systemTotal.powerStatus}</span>
                </td>
              </tr>
            </tbody>
          </table>

          {/* Engine detail (M01): every physical engine on its own line — the
              headline numbers are the busiest engine, never a sum, and this
              table is where the individual engines stay visible. */}
          {(metrics.engines?.length ?? 0) > 0 && (
            <table className="metrics-table" style={{ marginTop: "8px" }}>
              <thead>
                <tr>
                  <th style={{ minWidth: "200px" }}>Engine</th>
                  <th style={{ width: "70px", textAlign: "right" }}>Class</th>
                  <th style={{ width: "70px", textAlign: "right" }}>Load %</th>
                </tr>
              </thead>
              <tbody>
                {metrics.engines!.map((eng, idx) => (
                  <tr key={`${eng.luid}-${eng.phys}-${eng.eng}-${eng.engineType}-${idx}`}>
                    <td style={{ color: "var(--muted)" }}>
                      {`${eng.adapter || eng.luid} · ${eng.engineType} · node ${eng.phys} engine ${eng.eng}`}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {eng.adapterClass === "npu" ? "NPU" : eng.adapterClass === "gpu" ? "GPU" : "Unknown"}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: eng.percent > 0.5 ? 600 : 400 }}>
                      {formatPercent(eng.percent, live)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Honesty footer (M06/M09): what the RAM numbers are, and what is
              missing from the table. */}
          <div style={{ padding: "6px 4px 2px", color: "var(--muted)", fontSize: "10px" }}>
            {metrics.memoryNote}
            {metrics.unopenedProcesses ? ` · ${metrics.unopenedProcesses} process(es) not readable (exited or protected)` : ""}
          </div>
        </div>
      )}
    </div>
  );
};
