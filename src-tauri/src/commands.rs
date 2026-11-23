use tauri::{State, Window};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bench::{load_hardware_config, run_model_benchmark, save_hardware_config, BenchmarkResult};
use crate::memory_estimator::{estimate_memory, MemoryEstimate};
use crate::model_manifest::{load_evidence, scan_model_manifest, upsert_evidence, EvidenceRecord};
use crate::power::{get_power_status, set_sleep_inhibit, PowerStatusInfo};
use crate::settings::{load_settings, save_settings};
use crate::supervisor::{GenieXSupervisor, PreloadRequest, ServerStatus, StartServerRequest};
use crate::system;

#[repr(C)]
struct MemoryStatusEx {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meters {
    #[serde(rename = "ramPercent")]
    pub ram_percent: f64,
    #[serde(rename = "ramUsedGB")]
    pub ram_used_gb: f64,
    #[serde(rename = "ramTotalGB")]
    pub ram_total_gb: f64,
    #[serde(rename = "npuMemGB")]
    pub npu_mem_gb: Option<f64>,
    #[serde(rename = "npuBudgetGB")]
    pub npu_budget_gb: f64,
    #[serde(rename = "npuUtilPercent")]
    pub npu_util_percent: Option<f64>,
    #[serde(rename = "npuNote")]
    pub npu_note: Option<String>,
    #[serde(rename = "ramWarning")]
    pub ram_warning: bool,
}

#[tauri::command]
pub async fn get_meters_cmd() -> Result<Meters, String> {
    let mut mem = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut mem) };
    if ok == 0 {
        return Err("Failed to query memory status".to_string());
    }
    let gb = 1024.0 * 1024.0 * 1024.0;
    let total_gb = (mem.ull_total_phys as f64 / gb * 10.0).round() / 10.0;
    let used_gb = ((mem.ull_total_phys - mem.ull_avail_phys) as f64 / gb * 10.0).round() / 10.0;
    let percent = mem.dw_memory_load as f64;
    let npu_budget = (total_gb * 0.75 * 10.0).round() / 10.0;
    // The native NPU utilization: the monitor's classified sample while it is recent, or a
    // light PDH read taken here when that sample is stale (a rested monitor's cache can be
    // hours old). An unavailable or stale-with-nothing-readable case stays None — an old
    // number shown as the load now, or an invented one, would be worse than an honest
    // absence. There is no supported NPU memory measurement here, so npu_mem_gb stays None.
    // The light read may wait a quarter of a second between its two samples, so it runs off
    // the async runtime's blocking pool.
    let npu_util = tauri::async_runtime::spawn_blocking(crate::monitor::current_npu_utilization)
        .await
        .map_err(|e| format!("the NPU reading task failed: {}", e))?;

    Ok(Meters {
        ram_percent: percent,
        ram_used_gb: used_gb,
        ram_total_gb: total_gb,
        npu_mem_gb: None,
        npu_budget_gb: npu_budget,
        npu_util_percent: npu_util,
        npu_note: npu_util.map(|_| "NPU utilization from the native monitor counters".to_string()),
        ram_warning: percent > 85.0,
    })
}

#[tauri::command]
pub async fn estimate_memory_cmd(
    model_ref: String,
    nctx: Option<u32>,
    kv_type: Option<String>,
) -> Result<MemoryEstimate, String> {
    tauri::async_runtime::spawn_blocking(move || estimate_memory(&model_ref, nctx, kv_type.as_deref()))
        .await
        .map_err(|e| format!("memory estimate task failed: {}", e))
}

#[tauri::command]
pub fn get_power_status_cmd() -> Result<PowerStatusInfo, String> {
    Ok(get_power_status())
}

#[tauri::command]
pub async fn run_benchmark_cmd(
    sidecar: State<'_, crate::sidecar::SidecarHost>,
    model_ref: String,
    compute: Option<String>,
    power_mode: Option<String>,
    nctx: Option<u32>,
) -> Result<Value, String> {
    refuse_work_while_shutting_down()?;
    let generation = crate::bench::benchmark_generation();
    sidecar.call("benchmarkGeniexModel", serde_json::json!([model_ref, compute, power_mode, nctx, generation])).await
}

pub(crate) async fn run_admitted_benchmark(
    supervisor: &GenieXSupervisor,
    model_ref: String,
    compute: Option<String>,
    power_mode: Option<String>,
    nctx: Option<u32>,
    generation: u64,
) -> Result<BenchmarkResult, String> {
    refuse_work_while_shutting_down()?;
    // Admission: the benchmark spawns its own `geniex infer`, which loads a full model
    // copy onto the NPU. Holding the supervisor's startup lock for the whole run keeps
    // it serialized with server starts, model switches and preloads — one model-changing
    // operation at a time, the same policy every other runtime user follows.
    let _admission = supervisor.admit().await;
    if generation != crate::bench::benchmark_generation() { return Err("Benchmark was cancelled.".into()); }
    // The busy flag is the generation's lease on the resident server, and it is
    // re-checked UNDER the admission lock: a generation that started while this
    // call waited for admission must still be seen, or the release below would
    // kill the very completion the user is watching (C04). An explicit user
    // stop stays deliberately outside this gate.
    if supervisor.is_generating().await {
        return Err("A generation is running on the resident server — the benchmark would have to kill it. Wait for the answer to finish, then run the benchmark.".to_string());
    }
    // The resident server would race the benchmark's own model copy for NPU memory:
    // release it first, while the admission lock guarantees nothing restarts it.
    supervisor.release_for_handoff().await?;
    // A benchmark is work the app is doing on the NPU: while it runs the hidden window
    // must not put the monitor to sleep over it, or the readings the report rests on go
    // stale mid-run. The flag is cleared on every exit, error included.
    crate::monitor::set_benchmarking(true);
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_model_benchmark(&model_ref, compute.as_deref(), power_mode.as_deref(), nctx, generation)
    })
    .await
    .map_err(|e| format!("benchmark task failed: {}", e));
    crate::monitor::set_benchmarking(false);
    result?
}

#[tauri::command]
pub fn cancel_benchmark_cmd() -> bool {
    // Invalidate the pending or running benchmark at its next cancellation check.
    crate::bench::cancel_benchmark();
    true
}

#[tauri::command]
pub fn get_hardware_config_cmd() -> Result<Value, String> {
    Ok(load_hardware_config())
}

#[tauri::command]
pub fn save_hardware_config_cmd(patch: Value) -> Result<Value, String> {
    save_hardware_config(patch)
}

#[tauri::command]
pub async fn preload_model(
    req: PreloadRequest,
    supervisor: State<'_, GenieXSupervisor>,
    sidecar: State<'_, crate::sidecar::SidecarHost>,
) -> Result<Value, String> {
    refuse_work_while_shutting_down()?;
    let generation = supervisor.cancel_generation().await;
    sidecar.call("preloadGeniexModel", serde_json::json!([StartServerRequest::from(req), generation])).await
}

#[tauri::command]
pub async fn start_server(
    req: StartServerRequest,
    supervisor: State<'_, GenieXSupervisor>,
    sidecar: State<'_, crate::sidecar::SidecarHost>,
) -> Result<Value, String> {
    refuse_work_while_shutting_down()?;
    let generation = supervisor.cancel_generation().await;
    sidecar.call("startGeniexModel", serde_json::json!([req, generation])).await
}

#[tauri::command]
pub async fn stop_server(
    supervisor: State<'_, GenieXSupervisor>,
) -> Result<(), String> {
    supervisor.stop().await
}

#[tauri::command]
pub async fn get_server_status(
    supervisor: State<'_, GenieXSupervisor>,
) -> Result<ServerStatus, String> {
    Ok(supervisor.get_status().await)
}

#[tauri::command]
pub async fn get_server_logs(
    supervisor: State<'_, GenieXSupervisor>,
) -> Result<Vec<String>, String> {
    Ok(supervisor.get_logs().await)
}

#[tauri::command]
pub async fn set_server_busy_cmd(
    busy: bool,
    supervisor: State<'_, GenieXSupervisor>,
) -> Result<(), String> {
    supervisor.set_busy(busy).await;
    // The live-metrics "inferring" signal is driven here, from the orchestrator's own
    // generation marking: the NPU pill and the sampling cadence read it, and nothing
    // on the main chat path set it before (only voice and sleep inhibition did).
    crate::monitor::set_inferring(busy);
    Ok(())
}

/// The versioned capability manifest of the installed GenieX executable: which serve
/// flags it documents, its version triple. The sidecar and the developer page both
/// read this instead of assuming a release's documented contract.
#[tauri::command]
pub async fn geniex_capabilities_cmd(exe: Option<String>) -> Result<crate::capabilities::GeniexCapabilities, String> {
    let resolved = GenieXSupervisor::find_geniex(exe.as_deref())
        .ok_or_else(|| "geniex.exe not found on system. Please verify GenieX CLI installation.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || crate::capabilities::probe(&resolved))
        .await
        .map_err(|e| format!("capability probe task failed: {}", e))
}

/// The artifact manifest: every model in the GenieX cache with the identity,
/// precision, compiled context, chipset requirements and revision its OWN
/// metadata declares (never inferred from a name). Spawn_blocking: the scan
/// walks multi-GB directories and must not block the main thread.
#[tauri::command]
pub async fn model_manifest_cmd() -> Result<Vec<crate::model_manifest::ArtifactManifestEntry>, String> {
    tauri::async_runtime::spawn_blocking(scan_model_manifest)
        .await
        .map_err(|e| format!("manifest scan task failed: {}", e))
        .map(Ok::<_, String>)?
}

/// The per-device evidence store: the records behind every evidence badge.
#[tauri::command]
pub fn get_model_evidence_cmd() -> Result<Vec<EvidenceRecord>, String> {
    Ok(load_evidence())
}

/// Upserts evidence records (kind-validated, upsert-by-id so a re-measurement
/// replaces instead of contradicting). Used by the sidecar's measurement paths.
#[tauri::command]
pub fn record_model_evidence_cmd(records: Vec<EvidenceRecord>) -> Result<Vec<EvidenceRecord>, String> {
    // The single owner of evidence writes: before persisting, each record is
    // enriched with the artifact identity (size, revision) from the cache scan,
    // so freshness can later compare what was measured against what is installed.
    let mut records = records;
    crate::model_manifest::enrich_with_artifact_identity(&mut records);
    upsert_evidence(&records)
}

#[tauri::command]
pub fn get_settings() -> Result<Value, String> {
    Ok(load_settings())
}

#[tauri::command]
pub fn save_settings_cmd(patch: Value) -> Result<Value, String> {
    save_settings(patch)
}

/// The last recorded repair of settings.json (a damaged file moved aside, keys
/// salvaged), or Null when nothing was ever repaired. The Settings page reads this
/// to tell the person what happened to their file and where the old bytes are.
#[tauri::command]
pub fn get_settings_repair_notice() -> Value {
    crate::settings::read_repair_notice()
}

// NOTE ON BLOCKING COMMANDS: synchronous Tauri commands run on the MAIN THREAD. Any
// command that spawns a process (geniex), hashes a file, or walks the registry freezes
// the whole UI while it runs — this is what made app start-up and the settings pages
// feel slow. Everything heavy below is therefore `async` + `spawn_blocking`.

#[tauri::command]
pub async fn get_app_info_cmd() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(system::get_app_info)
        .await
        .map_err(|e| format!("app info task failed: {}", e))
}

#[tauri::command]
pub async fn get_hardware_cmd() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(system::get_hardware)
        .await
        .map_err(|e| format!("hardware task failed: {}", e))
}

#[tauri::command]
pub async fn get_installed_models_cmd() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(system::list_installed_models)
        .await
        .map_err(|e| format!("installed models task failed: {}", e))
}

#[tauri::command]
pub fn inhibit_sleep(enable: bool) -> Result<(), String> {
    set_sleep_inhibit(enable);
    crate::monitor::set_inferring(enable);
    Ok(())
}

#[tauri::command]
pub async fn get_system_metrics(
    metrics_cache: State<'_, crate::monitor::SharedMetrics>,
) -> Result<crate::monitor::SystemMetricsPayload, String> {
    let guard = metrics_cache.read().await;
    Ok(guard.clone())
}

#[tauri::command]
pub fn set_inferring_state(active: bool) -> Result<(), String> {
    crate::monitor::set_inferring(active);
    Ok(())
}

#[tauri::command]
pub fn open_task_manager() -> Result<(), String> {
    std::process::Command::new("taskmgr.exe")
        .spawn()
        .map_err(|e| format!("Failed to launch Task Manager: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn npu_diagnostics_cmd() -> Result<crate::npudiag::NpuDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(crate::npudiag::collect)
        .await
        .map_err(|e| format!("NPU diagnostics task failed: {}", e))
}

#[tauri::command]
pub fn window_minimize(window: Window) -> Result<(), String> {
    crate::monitor::set_window_minimized_or_hidden(true);
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_maximize(window: Window) -> Result<(), String> {
    crate::monitor::set_window_minimized_or_hidden(false);
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn window_close(window: Window) -> Result<(), String> {
    // The ONE unified close setting ("closeAction"): the default is a full exit —
    // the close request falls through to the window event, the run loop ends, and
    // the coordinated shutdown runs in the Exit events. Hiding to the notification
    // area happens only on the explicit "tray" choice.
    if crate::settings::close_hides_to_tray() {
        crate::monitor::set_window_minimized_or_hidden(true);
        window.hide().map_err(|e| e.to_string())
    } else {
        window.close().map_err(|e| e.to_string())
    }
}

// ============================================================================
// Windows Efficiency Mode (EcoQoS) Commands
// ============================================================================

#[tauri::command]
pub fn get_qos_status_cmd(pid: Option<u32>) -> Result<crate::qos::QoSSummary, String> {
    match pid {
        Some(p) => crate::qos::get_process_qos_summary(p),
        None => crate::qos::get_current_process_qos_summary(),
    }
}

#[tauri::command]
pub fn set_qos_tier_cmd(pid: Option<u32>, tier: String) -> Result<crate::qos::QoSSummary, String> {
    let qos_tier = crate::qos::QoSTier::from_str_loose(&tier)
        .ok_or_else(|| format!("Invalid QoS tier '{}'. Valid tiers: interactive, inference_critical, background_eco", tier))?;

    let target_pid = pid.unwrap_or_else(|| unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() });
    crate::qos::apply_pid_tier(target_pid, qos_tier)?;
    crate::qos::get_process_qos_summary(target_pid)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sha256VerificationResult {
    pub path: String,
    pub sha256: String,
    pub matches: Option<bool>,
    #[serde(rename = "ecoqosVerified")]
    pub ecoqos_verified: bool,
}

#[tauri::command]
pub async fn verify_sha256_cmd(path: String, expected_sha256: Option<String>) -> Result<Sha256VerificationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path_buf = std::path::PathBuf::from(&path);
        if !path_buf.exists() {
            return Err(format!("File does not exist: {}", path));
        }
        // The reported verification comes from the EcoQoS guard's actual readback, not
        // an unconditional true.
        let (hash, ecoqos_verified) = crate::qos::compute_sha256_eco_verified(&path_buf)?;
        let matches = expected_sha256.map(|exp| exp.trim().eq_ignore_ascii_case(&hash));
        Ok(Sha256VerificationResult {
            path,
            sha256: hash,
            matches,
            ecoqos_verified,
        })
    })
    .await
    .map_err(|e| format!("hash task failed: {}", e))?
}

#[tauri::command]
pub fn chunk_document_text_cmd(
    text: String,
    chunk_size: Option<usize>,
    overlap: Option<usize>,
) -> Result<Vec<String>, String> {
    let size = chunk_size.unwrap_or(200);
    let over = overlap.unwrap_or(50);
    Ok(crate::qos::chunk_text_eco(&text, size, over))
}

/// One scanned PDF page, recognized on the device: the renderer drew the
/// text-less page into a PNG, Windows.Media.Ocr reads it. `lang` is the document's hint
/// ("ar", "en", or empty for the PC's own languages); a missing language comes back as
/// the message that names the pack to add — the app never changes the language settings.
#[tauri::command]
pub async fn ocr_page_cmd(png: Vec<u8>, lang: String) -> Result<crate::ocr::OcrPage, String> {
    crate::ocr::recognize_png(&png, &lang).await
}

// ============================================================================
// Node sidecar (the TypeScript main-process logic)
// ============================================================================

/// One call into the sidecar: `method` names a handler registered there, `args` is the
/// positional argument list as JSON. The sidecar is spawned on demand and supervised by
/// src-tauri/src/sidecar.rs.
#[tauri::command]
pub async fn sidecar_call(
    method: String,
    args: Value,
    sidecar: tauri::State<'_, crate::sidecar::SidecarHost>,
) -> Result<Value, String> {
    refuse_work_while_shutting_down()?;
    sidecar.call(&method, args).await
}

// ============================================================================
// Computer Use (the pinned agent-desktop driver; design: docs/design/computer-use.md)
// ============================================================================

/// The windows the person may grant, from the driver's own enumeration, with
/// MKMN's own windows removed. A driver that cannot start is an error the
/// picker shows, never an empty list that looks like "no windows".
#[tauri::command]
pub async fn agent_list_windows_cmd(
    driver: tauri::State<'_, crate::agent_driver::AgentDriverHost>,
) -> Result<Vec<crate::agent_wire::DriverWindow>, String> {
    refuse_work_while_shutting_down()?;
    let all = driver.list_windows().await?;
    Ok(all.into_iter().filter(|w| w.pid != std::process::id()).collect())
}

/// Records the ONE window grant for a run. The host is the grant's owner: the
/// renderer only names the window it picked.
#[tauri::command]
pub async fn agent_begin_run_cmd(
    hwnd: i64,
    driver: tauri::State<'_, crate::agent_driver::AgentDriverHost>,
) -> Result<Value, String> {
    refuse_work_while_shutting_down()?;
    let grant = driver.begin_grant(hwnd).await?;
    Ok(grant.to_json())
}

/// Stop: the sidecar's run is aborted (it settles `cancelled` and clears the
/// grant through agentEndRun in its finally), and the grant is cleared here too
/// in case the sidecar is already gone.
#[tauri::command]
pub async fn agent_stop_cmd(
    run_id: String,
    driver: tauri::State<'_, crate::agent_driver::AgentDriverHost>,
    sidecar: tauri::State<'_, crate::sidecar::SidecarHost>,
) -> Result<Value, String> {
    let _ = sidecar.call("agentStopRun", serde_json::json!([run_id])).await;
    driver.end_grant().await;
    Ok(serde_json::json!(true))
}

/// While the coordinated shutdown is running, the runtime must not be spun back up:
/// entry points that start server/benchmark/download/sidecar work refuse here. The
/// flag is only raised from the exit path, so this is a no-op in normal use.
fn refuse_work_while_shutting_down() -> Result<(), String> {
    if crate::shutdown::is_shutting_down() {
        return Err("MKMN is shutting down; this request was not started.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The commands that need no live window, supervisor or sidecar: their argument
    //! handling and the paths they read. Nothing here writes to the app's data folders.
    use super::*;

    /// A file of its own in the temp folder, removed when the guard drops.
    struct TempFile(std::path::PathBuf);
    impl TempFile {
        fn with(name: &str, bytes: &[u8]) -> Self {
            let path = std::env::temp_dir().join(format!("mkmn-commands-test-{}-{}", std::process::id(), name));
            std::fs::write(&path, bytes).expect("write temp file");
            TempFile(path)
        }
        fn path(&self) -> String { self.0.to_string_lossy().into_owned() }
    }
    impl Drop for TempFile {
        fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
    }

    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn verify_sha256_refuses_a_missing_file_and_names_it() {
        let missing = std::env::temp_dir().join(format!("mkmn-commands-test-{}-absent.bin", std::process::id()));
        let path = missing.to_string_lossy().into_owned();
        let err = tauri::async_runtime::block_on(verify_sha256_cmd(path.clone(), None)).unwrap_err();
        assert_eq!(err, format!("File does not exist: {}", path));
    }

    #[test]
    fn verify_sha256_hashes_the_file_and_compares_without_case_or_spaces() {
        let f = TempFile::with("abc.txt", b"abc");
        let plain = tauri::async_runtime::block_on(verify_sha256_cmd(f.path(), None)).unwrap();
        assert_eq!(plain.sha256, ABC_SHA256);
        assert_eq!(plain.path, f.path());
        assert_eq!(plain.matches, None, "no expected hash: no verdict");

        let loose = format!("  {}\n", ABC_SHA256.to_uppercase());
        let same = tauri::async_runtime::block_on(verify_sha256_cmd(f.path(), Some(loose))).unwrap();
        assert_eq!(same.matches, Some(true));

        let other = tauri::async_runtime::block_on(verify_sha256_cmd(f.path(), Some("0".repeat(64)))).unwrap();
        assert_eq!(other.matches, Some(false));
    }

    #[test]
    fn chunk_document_text_defaults_to_200_words_with_50_overlap() {
        let text: String = (0..300).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ");
        let chunks = chunk_document_text_cmd(text.clone(), None, None).unwrap();
        assert_eq!(chunks, crate::qos::chunk_text_eco(&text, 200, 50));
        assert_eq!(chunks[0].split_whitespace().count(), 200);
        assert_eq!(chunks[1].split_whitespace().next(), Some("w150"), "the second chunk starts 50 words back");
    }

    #[test]
    fn chunk_document_text_passes_explicit_sizes_and_returns_nothing_for_empty_text() {
        let text = "a b c d e f g h i j";
        assert_eq!(chunk_document_text_cmd(text.into(), Some(4), Some(1)).unwrap(), crate::qos::chunk_text_eco(text, 4, 1));
        assert!(chunk_document_text_cmd(String::new(), None, None).unwrap().is_empty());
        assert!(chunk_document_text_cmd("   ".into(), None, None).unwrap().is_empty());
    }

    #[test]
    fn set_qos_tier_rejects_an_unknown_tier_before_touching_any_process() {
        let err = set_qos_tier_cmd(Some(u32::MAX), "turbo".into()).unwrap_err();
        assert!(err.starts_with("Invalid QoS tier 'turbo'"), "{err}");
        assert!(err.contains("interactive, inference_critical, background_eco"), "{err}");
    }

    #[test]
    fn get_qos_status_reads_this_process_by_default_and_refuses_a_process_that_is_not_there() {
        let own = get_qos_status_cmd(None).expect("this process can be read");
        assert_eq!(own.pid, std::process::id());
        let err = get_qos_status_cmd(Some(u32::MAX)).unwrap_err();
        assert!(err.contains("OpenProcess(PID: 4294967295)"), "{err}");
    }

    #[test]
    fn cancel_benchmark_moves_the_generation_on() {
        let before = crate::bench::benchmark_generation();
        assert!(cancel_benchmark_cmd());
        assert!(crate::bench::benchmark_generation() > before);
    }

    #[test]
    fn work_is_admitted_while_the_app_is_not_shutting_down() {
        assert!(!crate::shutdown::is_shutting_down());
        assert_eq!(refuse_work_while_shutting_down(), Ok(()));
    }

    #[test]
    fn power_status_is_always_answered() {
        assert!(get_power_status_cmd().is_ok());
    }
}
