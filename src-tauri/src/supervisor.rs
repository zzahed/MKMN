use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::RwLock;

use crate::job_object::JobObjectGuard;
use crate::memory_estimator::{estimate_memory, estimate_memory_credited, get_available_ram_bytes, is_qairt_model, qairt_compiled_context};
use crate::paths::append_log;
use crate::power::resolve_effective_power_mode;
use crate::state_machine::ServerLifecycleState;

const MAX_LOG_LINES: usize = 60;
const POLL_INTERVAL_MS: u64 = 500;
const DEFAULT_TIMEOUT_SEC: u64 = 90;
const DEFAULT_PORT: u16 = 18181;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareVerification {
    #[serde(rename = "verifiedNpu")]
    pub verified_npu: bool,
    #[serde(rename = "cpuFallbackDetected")]
    pub cpu_fallback_detected: bool,
    #[serde(rename = "executionTarget")]
    pub execution_target: String,
    #[serde(rename = "powerModeActive")]
    pub power_mode_active: String,
    #[serde(rename = "lastTelemetryLog")]
    pub last_telemetry_log: Option<String>,
    #[serde(rename = "qosTier")]
    pub qos_tier: String,
    #[serde(rename = "ecoqosActive")]
    pub ecoqos_active: bool,
}

/// The state reported while a server is starting: nothing is verified yet, only what
/// was requested. `verified_npu` stays false until the child's own output proves HTP
/// execution (or a fallback proves the opposite).
pub fn requested_verification(compute: &str, power_mode: &str) -> HardwareVerification {
    let requested_target = match compute {
        "hybrid" => "Requested: Hybrid (NPU + CPU) — not verified yet".to_string(),
        "npu" => "Requested: Hexagon NPU (HTP) — not verified yet".to_string(),
        _ => "Requested: CPU (Oryon)".to_string(),
    };
    HardwareVerification {
        verified_npu: false,
        cpu_fallback_detected: false,
        execution_target: requested_target,
        power_mode_active: power_mode.to_string(),
        last_telemetry_log: None,
        qos_tier: "Tier 2: Inference-Critical (ABOVE_NORMAL)".to_string(),
        ecoqos_active: false,
    }
}

impl Default for HardwareVerification {
    fn default() -> Self {
        Self {
            verified_npu: false,
            cpu_fallback_detected: false,
            execution_target: "Idle / Unloaded".to_string(),
            power_mode_active: "sustained_high_performance".to_string(),
            last_telemetry_log: None,
            qos_tier: "Tier 1: Interactive".to_string(),
            ecoqos_active: false,
        }
    }
}

/// The state reported for an ADOPTED server (running before MKMN needed it, started
/// outside this app). Nothing is claimed: MKMN did not configure this process, so it
/// cannot say which power mode or QoS tier it uses — and its compute is only claimed
/// when the warm-up actually MEASURED NPU work on that exact PID.
pub fn adopted_verification(npu_peak: Option<f64>) -> HardwareVerification {
    let (verified, target) = match npu_peak {
        Some(p) if p >= 2.0 => (
            true,
            format!("Hexagon NPU (HTP, measured {:.0}% during the warm-up)", p),
        ),
        _ => (
            false,
            "Adopted server: execution target not verified (no NPU load was measurable \
             on it during the warm-up)"
                .to_string(),
        ),
    };
    HardwareVerification {
        verified_npu: verified,
        cpu_fallback_detected: false,
        execution_target: target,
        power_mode_active: "unknown (the adopted server was not configured by MKMN)"
            .to_string(),
        last_telemetry_log: None,
        qos_tier: "Not applied (the process is not owned by MKMN)".to_string(),
        ecoqos_active: false,
    }
}

/// True when `pid` still names a LIVE process that is (still) a GenieX server image.
/// Both halves matter: a bare `OpenProcess` success can be a recycled PID belonging
/// to an unrelated process, and a bare image-name match would say nothing about
/// liveness. Used by the adopted-server watcher — a dead or replaced process must
/// never keep a stale "ready" status alive.
fn adopted_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };
    const WAIT_OBJECT_0: u32 = 0;
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false; // already gone (or never was)
        }
        let wait = WaitForSingleObject(handle, 0); // 0 = poll, never blocks
        windows_sys::Win32::Foundation::CloseHandle(handle);
        if wait == WAIT_OBJECT_0 {
            return false; // the process has exited
        }
        // PID-reuse guard: whatever lives at this pid now must still be geniex.exe.
        match process_image_path(pid) {
            Some(path) => Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.to_lowercase().ends_with("geniex.exe"))
                .unwrap_or(false),
            None => false,
        }
    }
}

/// The result of a warm-up completion against a (would-be) resident server.
enum WarmupOutcome {
    /// The server answered a real completion; when NPU sampling ran, the measured
    /// peak utilization of the server's process is carried (None = not sampled).
    Ok { npu_peak: Option<f64>, generated: bool },
    /// The server refused the completion (HTTP error): it is not ready to serve.
    Rejected { status: u16, body: String },
    /// The server could not be reached at all.
    Unreachable(String),
}

/// One tiny real completion ("warm-up"): the evidence that a server does not just
/// LIST a model but actually serves it, and — when NPU sampling of the server's
/// process is wanted — the measured utilization peak of that process while it
/// answers. Shared by the spawn path (where a failure fails the startup) and the
/// adoption path (where a failure refuses the adoption).
/// How long the warm-up's first answer may take. It includes the end of the load: a 7-8 GB model answered
/// it in 56-97 s on this PC and the old 30 s limit recorded such models as failing to load.
pub(crate) const WARMUP_TIMEOUT: Duration = Duration::from_secs(180);

async fn run_warmup_probe(
    client: &reqwest::Client,
    port: u16,
    model: &str,
    pid: Option<u32>,
    wants_npu: bool,
) -> WarmupOutcome {
    let warm_url = format!("http://127.0.0.1:{}/v1/chat/completions", port);
    let warm_body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": " "}],
        "max_tokens": 16,
        "stream": false
    });
    let sampling_done = Arc::new(AtomicBool::new(false));
    let sampler = if wants_npu && pid.is_some() {
        let done = sampling_done.clone();
        let sampled_pid = pid.unwrap_or(0);
        Some(tokio::task::spawn_blocking(move || {
            let mut peak = 0.0f64;
            // A self-limiting loop: the request's completion sets the flag, and
            // a failure path that never does must still end the thread.
            let deadline = Instant::now() + WARMUP_TIMEOUT;
            if let Some(ref mut s) = crate::monitor::PdhGpuSampler::new() {
                while !done.load(Ordering::Relaxed) && Instant::now() < deadline {
                    // attribute to OUR server only: another process's NPU work
                    // must not verify this server
                    if let Some(v) = s.npu_for_pid(sampled_pid) {
                        peak = peak.max(v);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            peak
        }))
    } else {
        None
    };
    let warm_result = client
        .post(&warm_url)
        .json(&warm_body)
        .timeout(WARMUP_TIMEOUT)
        .send()
        .await;
    sampling_done.store(true, Ordering::Relaxed);
    match warm_result {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.json::<serde_json::Value>().await.unwrap_or_default();
            let generated = body.pointer("/choices/0/message").is_some_and(|message| {
                ["content", "reasoning_content"].iter().any(|key| {
                    message.get(key).and_then(|text| text.as_str()).is_some_and(|text| !text.trim().is_empty())
                })
            });
            let npu_peak = match sampler {
                Some(handle) => Some(handle.await.unwrap_or(0.0)),
                None => None,
            };
            WarmupOutcome::Ok { npu_peak, generated }
        }
        Ok(resp) => {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            WarmupOutcome::Rejected {
                status: status.as_u16(),
                body: body.chars().take(300).collect(),
            }
        }
        Err(e) => WarmupOutcome::Unreachable(e.to_string()),
    }
}

/// A load failure as the UI reports it: a category, a title, the fix to try and
/// the raw reason. The Rust host used to report a bare string under the key the
/// renderer never read (`last_error` vs `lastError`), so every load failure
/// reached the user as an unchanged endpoint tooltip instead of its reason.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendlyError {
    pub id: String,
    pub title: String,
    pub fix: String,
    pub raw: String,
}

/// Classifies a raw load failure into what the user can act on: a missing or
/// unsupported artifact, an incompatible runtime, insufficient memory, a
/// timeout, a crash, or an unresolved application id. The raw text is always
/// kept; the category only picks the honest title and the next step.
pub fn classify_load_error(raw: &str) -> FriendlyError {
    let l = raw.to_lowercase();
    // A held port is checked FIRST: it is a definitive, external cause. It used to be
    // collapsed into "memory pressure" and then reported as a readiness timeout, so it
    // had no honest category of its own.
    let port_conflict = l.contains("already in use")
        || l.contains("only one usage of each socket address")
        || l.contains("could not bind")
        || l.contains("address in use");
    let warmup_model_load = raw.starts_with("GenieX failed to load ") && is_model_load_rejection(&l);
    let (id, title, fix) = if port_conflict && !warmup_model_load {
        (
            "port-conflict",
            "Another program is using the port MKMN's AI needs",
            "Close other AI apps or another copy of MKMN, then try again. MKMN did not stop that program.",
        )
    } else if is_model_load_rejection(&l) {
        (
            "model-load",
            "The model failed to load",
            "Use Try again, or choose another installed model in Local Models. The engine's own message is under Raw message.",
        )
    } else if l.contains("model list does not hold") {
        (
            "model-not-listed",
            "This model isn't installed in the AI engine",
            "Install it again in Local Models, then choose it. Raw message lists the models the engine has.",
        )
    } else if l.contains("not found in local cache") || l.contains("file not found or inaccessible") {
        (
            "missing-artifact",
            "The model's files are missing",
            "Install the model again in Local Models (it may have been removed, or its folder moved).",
        )
    } else if l.contains("unknown flag") || l.contains("unrecognized") || l.contains("rejected the serve command line") || l.contains("no such flag") {
        (
            "unsupported-capability",
            "The installed AI engine doesn't support a setting you chose",
            "The setting was not applied. Update the engine, or clear the setting in Settings › Developer.",
        )
    } else if l.contains("pre-flight ram check") || l.contains("insufficient memory") || l.contains("not enough memory") || l.contains("memory required") {
        (
            "insufficient-memory",
            "Not enough free memory to load this model",
            "Close other apps, choose a smaller model in Local Models, or set a shorter conversation length in Settings › Speed & memory › Advanced. The NPU uses the PC's main memory.",
        )
    } else if l.contains("timed out") || l.contains("readiness check") || l.contains("did not answer") {
        (
            "timeout",
            "The model did not finish loading in time",
            "A big model can take minutes to load the first time. Try again. If it keeps timing out, see Settings › Developer › Last error.",
        )
    } else if l.contains("exited prematurely") || l.contains("exited during warm-up") || l.contains("exited unexpectedly") || l.contains("failed to spawn") {
        (
            "runtime-crash",
            "The AI engine stopped while loading the model",
            "Try again. If it happens again, see Settings › Developer › Last error for the engine's last message.",
        )
    } else if l.contains("is an application model id") || l.contains("was not resolved") {
        (
            "model-resolution",
            "MKMN couldn't find the installed model you chose",
            "Choose the model again in Local Models.",
        )
    } else if l.contains("not found on system") || l.contains("geniex.exe not found") {
        (
            "runtime-missing",
            "The NPU's AI engine isn't installed",
            "Install it from the setup screen, or point to it in Settings › Developer › Locate geniex.exe.",
        )
    } else {
        (
            "server",
            "The AI engine reported an error",
            "Try again. If it happens again, see Settings › Developer › Last error.",
        )
    };
    // a failed load names the model in plain words; the engine's own first line stays in raw
    let title = match raw.lines().next().and_then(|line| line.strip_prefix("GenieX failed to load ")) {
        Some(model) if id == "model-load" => format!("The model {model} failed to load"),
        _ => title.to_owned(),
    };
    let mut fix = fix.to_owned();
    if id == "model-load" {
        if let Some((supported, bundle)) = raw.lines().find_map(context_blob_versions) {
            fix = format!("This model was built for a newer NPU engine (format {bundle}) than the one installed (format {supported} or older). Choose another model in Local Models, or update the engine. Raw message has the details.");
        }
        if let Some(model) = raw.lines().find_map(|line| line.strip_prefix("Verified installed NPU model: ")) {
            fix.push_str(&format!(" {model} answered on the NPU with this runtime."));
        }
        if raw.lines().any(|line| line == WARMUP_PAUSED) {
            fix = format!("{WARMUP_PAUSED} {fix}");
        }
    }
    FriendlyError { id: id.to_owned(), title, fix, raw: raw.to_owned() }
}

fn is_model_load_rejection(message: &str) -> bool {
    message.contains("-100201") || message.to_ascii_lowercase().contains("model loading failed")
}

fn context_blob_versions(line: &str) -> Option<(&str, &str)> {
    let (_, versions) = line.split_once("Newest blob version supported: ")?;
    let (supported, current) = versions.split_once(". Current blob version: ")?;
    let current = current.trim().trim_end_matches('.');
    fn is_version(value: &str) -> bool {
        !value.is_empty()
            && value.bytes().next().is_some_and(|byte| byte.is_ascii_digit())
            && value.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'x'))
    }
    (is_version(supported) && is_version(current)).then_some((supported, current))
}

#[derive(Default)]
struct WarmupFailures(HashMap<String, (u8, String)>);

impl WarmupFailures {
    fn record(&mut self, key: &str, error: String) {
        let entry = self.0.entry(key.to_owned()).or_default();
        *entry = (entry.0.saturating_add(1), error);
    }

    fn blocked(&self, key: &str, explicit: bool) -> Option<&str> {
        let (attempts, error) = self.0.get(key)?;
        (!explicit && *attempts >= 2).then_some(error.as_str())
    }

    fn clear(&mut self, key: &str) {
        self.0.remove(key);
    }
}

fn file_identity(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let meta = path.metadata().ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

// Cached bundle identity without reading gigabytes of context binaries on every send.
fn bundle_identity(model: &str) -> Option<(PathBuf, u64)> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let dir = crate::memory_estimator::model_candidates(model)
        .into_iter().find(|dir| dir.join("geniex.json").is_file())?;
    let mut files = std::fs::read_dir(&dir).ok()?.collect::<Result<Vec<_>, _>>().ok()?;
    files.sort_by_key(|file| file.file_name());
    let mut digest = DefaultHasher::new();
    for file in files {
        if file.file_type().ok()?.is_file() && file.file_name() != ".lock" {
            file.file_name().hash(&mut digest);
            file_identity(&file.path())?.hash(&mut digest);
        }
    }
    Some((dir, digest.finish()))
}

fn qairt_runtime_files(dir: &Path, depth: u8, files: &mut Vec<(PathBuf, Option<(u64, std::time::SystemTime)>)>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(kind) = entry.file_type() {
                if kind.is_dir() && depth > 0 {
                    qairt_runtime_files(&path, depth - 1, files);
                } else if kind.is_file() {
                    let identity = file_identity(&path);
                    files.push((path, identity));
                }
            }
        }
    }
}

fn warmup_runtime(exe: &Path, qairt_lib: Option<&str>, caps: &crate::capabilities::GeniexCapabilities) -> (String, String) {
    let versions = format!("GenieX {}, QAIRT {}",
        caps.geniex_version.as_deref().unwrap_or("unknown"),
        caps.qairt_runtime.as_deref().unwrap_or("unknown"));
    let configured = qairt_lib.filter(|path| !path.trim().is_empty() && caps.supports("--qairt-lib"));
    let env_override = std::env::var("GENIEX_QAIRT_LIB").ok().filter(|path| !path.trim().is_empty());
    let override_path = configured.or(env_override.as_deref());
    let qairt = override_path.map(PathBuf::from).or_else(|| exe.parent().map(|dir| dir.join("qairt")));
    let mut files = Vec::new();
    if let Some(path) = &qairt {
        qairt_runtime_files(path, 4, &mut files);
    }
    files.sort();
    let driver = crate::system::started_npu_device().and_then(|(_, version)| version);
    let key = format!("{exe:?} {:?} {:?} {versions} {:?} {qairt:?} {:?} {files:?} {driver:?}",
        file_identity(exe), file_identity(&exe.with_extension("dll")),
        caps.llama_cpp_hash, qairt.as_deref().and_then(file_identity));
    let mut details = match override_path {
        Some(path) => format!("{versions} (bundled version reported by CLI; QAIRT override {path})"),
        None => versions,
    };
    if let Some(driver) = driver {
        details.push_str(&format!(", Windows NPU driver {driver}"));
    }
    (key, details)
}

fn warmup_build(model: &str) -> String {
    use sha2::{Digest, Sha256};
    let Some((dir, imprint)) = bundle_identity(model) else { return model.to_owned() };
    let registry = std::fs::read_to_string(dir.join("geniex.json")).ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let (requested_name, requested_variant) = model.split_once(':').map_or((model, None), |(name, variant)| (name, Some(variant)));
    let name = registry.as_ref().and_then(|reg| reg.get("Name")).and_then(|name| name.as_str()).unwrap_or(requested_name);
    let model_files = registry.as_ref().and_then(|reg| reg.get("ModelFile")).and_then(|files| files.as_object());
    let variant = match requested_variant {
        Some(requested) => model_files.and_then(|files| files.keys().find(|name| name.eq_ignore_ascii_case(requested)))
            .map(String::as_str).or(Some(requested)),
        None => model_files.filter(|files| files.len() == 1).and_then(|files| files.keys().next()).map(String::as_str),
    };
    let label = variant.map_or_else(|| name.to_owned(), |variant| format!("{name}:{variant}"));
    let metadata = std::fs::read(dir.join("metadata.json")).ok();
    let metadata_description = metadata.as_ref().map(|bytes| {
        let metadata = serde_json::from_slice::<serde_json::Value>(bytes).unwrap_or_default();
        let toolchain = metadata.pointer("/tool_versions/qairt").and_then(|v| v.as_str()).unwrap_or("unknown");
        let chipset = metadata.pointer("/chipset_attributes/marketing_name").and_then(|v| v.as_str()).unwrap_or("unknown");
        format!(", declared QAIRT toolchain {toolchain}, target {chipset}, metadata SHA-256 {}", Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>())
    }).unwrap_or_default();
    format!("{label} (cache build {imprint:016x} at {}{metadata_description})", dir.display())
}

const WARMUP_PAUSED: &str = "Automatic load attempts are paused for this build and runtime.";

fn warmup_recovery_details(state: &SupervisorState, raw: &str, runtime: &str, failed_build: &str, blocked: bool) -> String {
    let mut details = raw.to_owned();
    if blocked {
        details.push('\n');
        details.push_str(WARMUP_PAUSED);
    }
    let candidate = state.verified_npu_bundles.iter()
        .filter(|(_, (candidate_runtime, candidate_build))| candidate_build != failed_build && candidate_runtime == runtime)
        .filter(|(name, (_, build))| bundle_identity(name).is_some() && warmup_build(name) == *build)
        .map(|(name, _)| name).min();
    if let Some(name) = candidate {
        details.push_str(&format!("\nVerified installed NPU model: {name}"));
    }
    details
}

#[cfg(test)]
mod warmup_recovery_tests {
    use super::*;

    #[test]
    fn sdk_model_load_failure_is_not_a_timeout() {
        let raw = "qualcomm/Qwen3-8B:W4A16 did not answer (HTTP 500): SDKError(Model loading failed) (-100201); Could not create context from binary: err 1002";
        let error = classify_load_error(raw);
        assert_eq!(error.id, "model-load");
        assert_eq!(error.raw, raw);
    }

    #[test]
    fn repeat_failure_blocks_automatic_starts_until_explicit_retry() {
        let mut failures = WarmupFailures::default();
        assert!(failures.blocked("build/runtime", false).is_none());
        failures.record("build/runtime", "first".into());
        assert!(failures.blocked("build/runtime", false).is_none());
        failures.record("build/runtime", "second".into());
        assert_eq!(failures.blocked("build/runtime", false), Some("second"));
        assert!(failures.blocked("other build/runtime", false).is_none());
        assert!(failures.blocked("build/runtime", true).is_none());
        failures.clear("build/runtime");
        assert!(failures.blocked("build/runtime", false).is_none());
    }

    #[test]
    fn warmup_diagnostics_keep_this_childs_context_error() {
        let mut state = SupervisorState::new();
        state.set_state(ServerLifecycleState::Starting);
        state.set_state(ServerLifecycleState::Loading);
        state.epoch = 2;
        state.capture_warmup_error(1, "unrelated prior child's error");
        state.capture_warmup_error(2, "Could not create context from binary for context index = 0 : err 1002");
        state.capture_warmup_error(2, "GET /v1/models");
        assert_eq!(state.warmup_runtime_errors.into_iter().collect::<Vec<_>>(),
            ["Could not create context from binary for context index = 0 : err 1002"]);
    }

    #[test]
    fn context_format_rejection_survives_later_runtime_errors() {
        let mut state = SupervisorState::new();
        state.set_state(ServerLifecycleState::Starting);
        state.set_state(ServerLifecycleState::Loading);
        let mismatch = "Can't read future blob. Newest blob version supported: 3.3.x. Current blob version: 4.0.x.";
        state.capture_warmup_error(0, mismatch);
        for n in 0..25 {
            state.capture_warmup_error(0, &format!("Failed to create context {n}"));
        }
        let diagnostic = state.warmup_diagnostic();
        assert!(diagnostic.contains(mismatch));
        assert!(diagnostic.contains("Failed to create context 24"));
        let raw = format!("GenieX failed to load qualcomm/Qwen3-8B\nSDKError(Model loading failed)\n{diagnostic}");
        let error = classify_load_error(&raw);
        assert_eq!(error.id, "model-load");
        assert!(error.title.contains("qualcomm/Qwen3-8B"));
        assert!(error.fix.contains("format 4.0.x"));
        assert!(error.fix.contains("3.3.x"));
    }
}

/// How a `geniex serve` startup failed, judged from the CHILD's own output.
///
/// The old supervisor treated every premature exit (and every readiness timeout) as
/// memory pressure and auto-retried with a smaller context. A port another server
/// already held was therefore reported as "Memory pressure / allocation failure" and
/// retried pointlessly. The classification is extracted here so the production path
/// and its tests agree on what a real bind conflict, a real allocation failure and a
/// CLI usage error each look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartFailureKind {
    /// The port is held by another listener: retrying cannot help.
    PortConflict,
    /// The CLI rejected the command line (an unknown flag): retrying cannot help.
    UnknownFlag,
    /// A genuine allocation failure: a smaller context may fit.
    MemoryPressure,
    /// The runtime said the context window is too large (KV cache, trained length): a smaller one may fit.
    ContextSize,
    /// The server answered, but its model list never held the requested build: no context size can fix it.
    ModelNotListed,
    /// Nothing recognizable: a timeout or a crash that is neither of the above.
    Unknown,
}

/// True for a line in which the runtime reports the port is already taken.
pub fn is_bind_conflict_line(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("only one usage of each socket address")
        || l.contains("address already in use")
        || l.contains("eaddrinuse")
        || l.contains("failed to bind")
        || l.contains("cannot bind")
        || (l.contains("bind:") && (l.contains("in use") || l.contains("10048") || l.contains("permitted")))
}

/// True for a line in which the runtime reports a genuine allocation failure. `oom` is
/// matched as a whole word: a model id can contain the letters without meaning memory.
pub fn is_memory_pressure_line(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("out of memory")
        || l.contains("bad_alloc")
        || l.contains("failed to allocate")
        || l.contains("cannot allocate")
        || l.contains("unable to allocate")
        || l.contains("allocation fail")
        || l.contains("not enough memory")
        || l.contains("insufficient memory")
        || l.split(|c: char| !c.is_alphanumeric()).any(|w| w == "oom")
}

/// True for a line in which the runtime says the context window is too large for the model or the memory.
pub fn is_context_size_line(line: &str) -> bool {
    let l = line.to_lowercase();
    let about_context = l.contains("context") || l.contains("n_ctx") || l.contains("kv cache");
    about_context && (l.contains("exceed") || l.contains("too large") || l.contains("too long") || l.contains("too big"))
}

/// True for a line in which the runtime rejects a flag/option it does not know.
pub fn is_unknown_flag_line(line: &str) -> bool {
    let l = line.to_lowercase();
    (l.contains("unknown") || l.contains("unrecognized") || l.contains("no such") || l.contains("invalid"))
        && (l.contains("flag") || l.contains("option") || l.contains("argument"))
}

/// Whether a log line is output captured from the geniex child (rather than the
/// supervisor's own narration). Classification must look only at what the RUNTIME
/// said: a supervisor line left over from an earlier fallback ("Memory pressure /
/// allocation failure detected") must never be able to re-label a later, unrelated
/// failure.
fn child_output_line(line: &str) -> bool {
    line.contains("[geniex stdout]") || line.contains("[geniex stderr]")
}

/// Classifies a startup failure from the supervisor's log buffer. A bind conflict and
/// an unknown-flag rejection are DEFINITIVE and win over any memory wording.
pub fn classify_start_failure(logs: &[String]) -> StartFailureKind {
    let child: Vec<&str> = logs
        .iter()
        .filter(|l| child_output_line(l))
        .map(|l| l.as_str())
        .collect();
    if child.iter().any(|l| is_bind_conflict_line(l)) {
        return StartFailureKind::PortConflict;
    }
    if child.iter().any(|l| is_unknown_flag_line(l)) {
        return StartFailureKind::UnknownFlag;
    }
    if child.iter().any(|l| is_memory_pressure_line(l)) {
        return StartFailureKind::MemoryPressure;
    }
    if child.iter().any(|l| is_context_size_line(l)) {
        return StartFailureKind::ContextSize;
    }
    StartFailureKind::Unknown
}

/// The automatic smaller-context retry is only for a runtime that REPORTED a memory allocation or a context-size
/// problem. A failure with no identifiable cause (a timeout, a crash), a model the list does not hold, a port
/// conflict and a CLI usage error are reported instead: a model whose files were gone was "retried
/// with a smaller context" and the person waited 90 s twice for nothing. The person retries explicitly.
pub fn should_attempt_context_fallback(kind: StartFailureKind) -> bool {
    matches!(kind, StartFailureKind::MemoryPressure | StartFailureKind::ContextSize)
}

/// Consecutive model lists without the requested build that settle it. GenieX's `/v1/models` is its model CACHE
/// (it answers at once, loaded or not), so the answer does not change by waiting: 4 answers (2 s) rule out a race.
pub(crate) const MISSING_CONFIRM_PROBES: u32 = 4;

/// One readiness probe's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadinessVerdict {
    /// Keep polling.
    Wait,
    /// The requested build is listed: warm-up comes next.
    Ready,
    /// The server answers but its list does not hold the requested build: no wait can change it.
    NotListed,
}

/// What the readiness probe saw, kept so a failure says which thing happened: the server never answered, it
/// answered an empty list, or it answered a list without the requested build (the warm-up failure is reported
/// by the warm-up itself).
#[derive(Debug, Default)]
pub(crate) struct ReadinessTracker {
    /// The last connection or HTTP error, while no list was read.
    unreachable: Option<String>,
    /// The ids of the last list read (empty = an empty list was answered).
    last_ids: Option<Vec<String>>,
    missing_streak: u32,
}

impl ReadinessTracker {
    pub(crate) fn observe_unreachable(&mut self, error: String) -> ReadinessVerdict {
        self.unreachable = Some(error);
        self.missing_streak = 0;
        ReadinessVerdict::Wait
    }

    pub(crate) fn observe_list(&mut self, ids: &[String], wanted: Option<&str>) -> ReadinessVerdict {
        self.unreachable = None;
        self.last_ids = Some(ids.to_vec());
        if ids.is_empty() {
            // an empty list is what a serve with a bad data dir looks like: not ready, keep waiting
            self.missing_streak = 0;
            return ReadinessVerdict::Wait;
        }
        if requested_model_listed(ids, wanted) {
            return ReadinessVerdict::Ready;
        }
        self.missing_streak += 1;
        if self.missing_streak >= MISSING_CONFIRM_PROBES { ReadinessVerdict::NotListed } else { ReadinessVerdict::Wait }
    }

    /// The failure, naming the requested build and what the server really answered.
    pub(crate) fn failure_message(&self, wanted: Option<&str>, probe_url: &str, timeout_sec: u64) -> String {
        let want = wanted.unwrap_or("the requested model");
        match &self.last_ids {
            Some(ids) if !ids.is_empty() => {
                let base = |s: &str| s.split(':').next().unwrap_or(s).replace("models--", "").replace("--", "/").to_lowercase();
                let want_base = base(want);
                let near: Vec<&str> = ids.iter().filter(|id| base(id) == want_base).map(|s| s.as_str()).collect();
                let mut msg = format!(
                    "GenieX is running, but its model list does not hold {want}. Requested: {want}. Returned ({}): {}.",
                    ids.len(),
                    ids.join(", ")
                );
                if !near.is_empty() {
                    msg.push_str(&format!(
                        " The same model is installed in another precision (other precision: {}); only the exact build is loaded.",
                        near.join(", ")
                    ));
                }
                msg.push_str(" GenieX lists the models of its cache, so this build's files are not in the cache (removed, or never fully installed): install it again in Models.");
                msg
            }
            Some(_) => format!(
                "GenieX answered its readiness check at {probe_url} with an empty model list for {timeout_sec}s, so {want} could not be found (its model cache looks empty or unreadable)."
            ),
            None => format!(
                "GenieX failed to respond to readiness check at {probe_url} within {timeout_sec}s while starting {want}{}",
                self.unreachable.as_deref().map(|e| format!(" (last error: {e})")).unwrap_or_default()
            ),
        }
    }
}

/// The process holding a TCP port, when it could be identified. Reported only — never
/// used to kill anything.
#[derive(Debug, Clone)]
pub struct PortOwner {
    pub pid: u32,
    /// The full image path when it could be read (it may be refused for an elevated or
    /// other-user process); None when unknown.
    pub image: Option<String>,
}

impl PortOwner {
    /// A short, human label: the executable name and PID when both are known.
    fn label(&self) -> String {
        match self
            .image
            .as_deref()
            .and_then(|p| Path::new(p).file_name())
            .and_then(|n| n.to_str())
        {
            Some(name) => format!("{} (PID {})", name, self.pid),
            None => format!("another process (PID {})", self.pid),
        }
    }
}

/// AF_INET, used for the IPv4 loopback listener table MKMN reads.
const AF_INET: u32 = 2;

/// The process LISTENING on `port`, read from the OS TCP table. None when the port is
/// free or the table could not be read. This never connects to or touches the owner: it
/// only reports who is there, so the caller can avoid killing a process it did not
/// start.
pub fn tcp_listener_owner(port: u16) -> Option<PortOwner> {
    unsafe {
        use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
        use windows_sys::Win32::NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        };
        let mut size: u32 = 0;
        let first = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if first != 0 && first != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let second = GetExtendedTcpTable(
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if second != 0 {
            return None;
        }
        let table = buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let rows = std::slice::from_raw_parts((*table).table.as_ptr(), (*table).dwNumEntries as usize);
        for row in rows {
            // dwLocalPort holds the port in network byte order in its low 16 bits.
            let local_port = u16::from_be_bytes([
                (row.dwLocalPort & 0xff) as u8,
                ((row.dwLocalPort >> 8) & 0xff) as u8,
            ]);
            if local_port == port {
                return Some(PortOwner {
                    pid: row.dwOwningPid,
                    image: process_image_path(row.dwOwningPid),
                });
            }
        }
        None
    }
}

/// The full image path of a process, or None when it cannot be read (the process is
/// gone, or access was refused for an elevated/other-user process).
pub(crate) fn process_image_path(pid: u32) -> Option<String> {
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// The honest, actionable message for a port already in use. It names the owner when
/// known and states plainly that MKMN did NOT stop it — killing another program's
/// server is never MKMN's call.
pub fn port_conflict_message(port: u16, owner: Option<&PortOwner>) -> String {
    let by = owner
        .map(|o| o.label())
        .unwrap_or_else(|| "another process".to_string());
    format!(
        "Port {port} is already in use by {by}. Another GenieX or MKMN server is holding it; MKMN did not stop that process. Close it (or the other MKMN instance), or choose a different port in Settings, then retry."
    )
}

/// The message for a startup that failed for the classified reason: what the user sees
/// (via `classify_load_error`) and what the log records. A port conflict keeps its
/// named-owner message instead of the generic exit text.
fn start_failure_message(
    kind: StartFailureKind,
    port: u16,
    status: &str,
    owner: Option<&PortOwner>,
) -> String {
    match kind {
        StartFailureKind::PortConflict => format!(
            "{} GenieX could not bind to it ({}).",
            port_conflict_message(port, owner),
            status
        ),
        StartFailureKind::UnknownFlag => {
            format!("GenieX rejected the serve command line (unknown flag); status: {}", status)
        }
        StartFailureKind::MemoryPressure => format!(
            "GenieX exited prematurely: insufficient memory to load the model; status: {}",
            status
        ),
        StartFailureKind::ContextSize => format!(
            "GenieX exited prematurely: the context window is too large for this model or memory; status: {}",
            status
        ),
        StartFailureKind::ModelNotListed | StartFailureKind::Unknown => {
            format!("GenieX exited prematurely with status: {}", status)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerStatus {
    pub state: ServerLifecycleState,
    pub endpoint: String,
    pub pid: Option<u32>,
    pub restarts: u32,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<FriendlyError>,
    #[serde(rename = "hardwareVerification")]
    pub hardware_verification: HardwareVerification,
    #[serde(default)]
    pub model: Option<String>,
    /// The context window the running server was ACTUALLY started with (what
    /// `geniex serve` received, after the supervisor's own resolution). None when no
    /// dynamic context was configured (QAIRT compiles it statically) or nothing runs.
    #[serde(rename = "servedNctx", default)]
    pub served_nctx: Option<u32>,
    /// How the running server's context window is determined: `"compiled"` when the
    /// model is a QAIRT bundle (the context is baked into the Hexagon graph and no
    /// `--nctx` is sent), `"configurable"` when the server was started with a dynamic
    /// `--nctx`, or None when nothing runs / no model was named.
    #[serde(rename = "contextKind", default)]
    pub context_kind: Option<String>,
    #[serde(rename = "servedKvType", default)]
    pub served_kv_type: Option<String>,
    #[serde(rename = "servedKvInRam", default)]
    pub served_kv_in_ram: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreloadRequest {
    pub exe: Option<String>,
    pub port: Option<u16>,
    pub model: Option<String>,
    pub compute: Option<String>,
    pub timeout_sec: Option<u64>,
    pub keepalive_sec: Option<u64>,
    pub strategy: Option<String>, // "always" (86400) or "demand" (300)
    pub power_mode: Option<String>, // "burst" | "sustained_high_performance" | "power_saver" | "auto"
    pub nctx: Option<u32>,
    pub kv_type: Option<String>,
    pub kv_in_ram: Option<bool>,
    pub spec_type: Option<String>,
    pub draft_model: Option<String>,
    pub draft_tokens: Option<u32>,
    pub draft_min: Option<u32>,
    pub draft_p_min: Option<f32>,
    pub metrics: Option<bool>,
    pub vit_compute: Option<String>,
    pub qairt_lib: Option<String>,
    pub ngl: Option<i32>,
    pub log_level: Option<String>,
    #[serde(default)]
    pub skip_update: Option<bool>,
    pub extra_args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartServerRequest {
    #[serde(default)]
    pub retry_model_load: bool,
    pub exe: Option<String>,
    pub port: Option<u16>,
    pub model: Option<String>,
    pub compute: Option<String>,
    pub timeout_sec: Option<u64>,
    pub keepalive_sec: Option<u64>,
    pub strategy: Option<String>, // "always" (86400) or "demand" (300)
    pub power_mode: Option<String>, // "burst" | "sustained_high_performance" | "power_saver" | "auto"
    pub nctx: Option<u32>,
    pub kv_type: Option<String>,
    pub kv_in_ram: Option<bool>,
    pub spec_type: Option<String>, // "ngram-simple", "draft-simple", etc.
    pub draft_model: Option<String>,
    pub draft_tokens: Option<u32>,
    pub draft_min: Option<u32>,
    pub draft_p_min: Option<f32>,
    pub metrics: Option<bool>,
    pub vit_compute: Option<String>,
    pub qairt_lib: Option<String>,
    pub ngl: Option<i32>,
    pub log_level: Option<String>, // GenieX's own --log (none/error/warn/info/debug/trace)
    #[serde(default)]
    pub skip_update: Option<bool>, // --skip-update: no update probe when the server starts
    pub extra_args: Option<Vec<String>>,
}

impl StartServerRequest {
    fn effective_keepalive(&self) -> u64 {
        self.keepalive_sec.unwrap_or(if self.strategy.as_deref() == Some("always") { 86_400 } else { 300 })
    }
}

impl From<PreloadRequest> for StartServerRequest {
    fn from(p: PreloadRequest) -> Self {
        Self {
            retry_model_load: false,
            exe: p.exe,
            port: p.port,
            model: p.model,
            compute: p.compute,
            timeout_sec: p.timeout_sec,
            keepalive_sec: p.keepalive_sec,
            strategy: p.strategy,
            power_mode: p.power_mode,
            nctx: p.nctx,
            kv_type: p.kv_type,
            kv_in_ram: p.kv_in_ram,
            spec_type: p.spec_type,
            draft_model: p.draft_model,
            draft_tokens: p.draft_tokens,
            draft_min: p.draft_min,
            draft_p_min: p.draft_p_min,
            metrics: p.metrics,
            vit_compute: p.vit_compute,
            qairt_lib: p.qairt_lib,
            ngl: p.ngl,
            log_level: p.log_level,
            skip_update: p.skip_update,
            extra_args: p.extra_args,
        }
    }
}

pub struct SupervisorState {
    child: Option<Child>,
    pub pid: Option<u32>,
    pub port: u16,
    pub state: ServerLifecycleState,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub logs: VecDeque<String>,
    pub job: Option<JobObjectGuard>,
    pub hw_verification: HardwareVerification,
    pub current_model: Option<String>,
    /// The context window and KV cache settings the running server was ACTUALLY started
    /// with (what `geniex serve` was told), so every consumer reports the real window
    /// instead of a recommended one. Cleared on stop.
    pub served_nctx: Option<u32>,
    pub served_kv_type: Option<String>,
    pub served_kv_in_ram: bool,
    /// How the context window is determined for the running model: "compiled" (QAIRT,
    /// static in the graph) or "configurable" (dynamic --nctx). Cleared on stop.
    pub context_kind: Option<String>,
    /// True while a chat completion runs against the ready server. The INTERNAL state
    /// stays "ready" (reuse checks compare against it); `get_status_from_state` reports
    /// the combined "busy" state so the UI can show that the model is generating.
    pub busy: bool,
    /// True when the ready server was ADOPTED (running before MKMN needed it, started
    /// outside this app). It is never stored as `child`, never killed, never QoS-tuned,
    /// and its health is watched separately so a death cannot leave a stale "ready".
    pub adopted: bool,
    /// Bumped on every stop: a startup that began under an older epoch must not mark
    /// the server ready after a concurrent stop tore it down.
    epoch: u64,
    cancel_generation: u64,
    /// The request that produced the running server, so the tray "Restart" can start
    /// the same configuration again.
    last_request: Option<StartServerRequest>,
    warmup_failures: WarmupFailures,
    verified_npu_bundles: HashMap<String, (String, String)>,
    warmup_runtime_errors: VecDeque<String>,
    warmup_context_error: Option<String>,
}

impl SupervisorState {
    fn capture_warmup_error(&mut self, epoch: u64, line: &str) {
        let lower = line.to_ascii_lowercase();
        if self.epoch != epoch
            || !matches!(self.state, ServerLifecycleState::Starting | ServerLifecycleState::Loading)
        {
            return;
        }
        if context_blob_versions(line).is_some() {
            // A rejection can be followed by many retries across protection domains.
            // Keep the format evidence outside the rolling tail of generic failures.
            self.warmup_context_error.get_or_insert_with(|| line.chars().take(1024).collect());
        } else if ["error", "failed", "err ", "could not"].iter().any(|word| lower.contains(word)) {
            if self.warmup_runtime_errors.len() == 16 {
                self.warmup_runtime_errors.pop_front();
            }
            self.warmup_runtime_errors.push_back(line.chars().take(1024).collect());
        }
    }

    fn warmup_diagnostic(&self) -> String {
        self.warmup_context_error.iter().chain(&self.warmup_runtime_errors)
            .map(String::as_str).collect::<Vec<_>>().join("\n")
    }

    pub fn new() -> Self {
        Self {
            child: None,
            pid: None,
            port: DEFAULT_PORT,
            state: ServerLifecycleState::Stopped,
            restarts: 0,
            last_error: None,
            logs: VecDeque::with_capacity(MAX_LOG_LINES),
            job: JobObjectGuard::new(),
            hw_verification: HardwareVerification::default(),
            current_model: None,
            served_nctx: None,
            served_kv_type: None,
            served_kv_in_ram: false,
            context_kind: None,
            busy: false,
            adopted: false,
            epoch: 0,
            cancel_generation: 0,
            last_request: None,
            warmup_failures: WarmupFailures::default(),
            verified_npu_bundles: HashMap::new(),
            warmup_runtime_errors: VecDeque::new(),
            warmup_context_error: None,
        }
    }

    pub fn append_log(&mut self, line: String) {
        append_log("geniex", &line);
        if self.logs.len() >= MAX_LOG_LINES {
            self.logs.pop_front();
        }
        self.logs.push_back(line);
    }

    /// Moves the lifecycle state through the registry. An illegal jump is a bug:
    /// a debug build stops at the exact pair, and a release build records it and
    /// applies the new state so the server can still recover.
    pub fn set_state(&mut self, next: ServerLifecycleState) {
        if !self.state.can_transition_to(next) {
            debug_assert!(
                false,
                "illegal server state change: {} -> {}",
                self.state.as_str(),
                next.as_str()
            );
            self.append_log(format!(
                "[supervisor] Unexpected server state change {} -> {} (not in the state machine).",
                self.state.as_str(),
                next.as_str()
            ));
        }
        self.state = next;
    }
}

impl Default for SupervisorState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct GenieXSupervisor {
    inner: Arc<RwLock<SupervisorState>>,
    client: reqwest::Client,
    startup_lock: Arc<tokio::sync::Mutex<()>>,
    startup_notify: Arc<tokio::sync::Notify>,
    /// How often the adopted-server watcher re-checks its process. Production uses
    /// the same cadence as the child watcher; tests shorten it so a death is
    /// observed in milliseconds rather than seconds.
    watch_interval: Duration,
}

/// The outcome of trying to adopt whatever already listens on the requested port.
enum Adoption {
    /// A compatible, warm-up-verified server is adopted and reported ready.
    Adopted(Box<ServerStatus>),
    /// The port owner is not something MKMN can adopt: the caller reports the
    /// generic named port conflict.
    NotAdoptable,
    /// The owner IS a geniex that lists the model but could not prove it is ready:
    /// report this specific, honest conflict instead of the generic one.
    Conflict(String),
}

/// What `start` should do with a request, given the current supervisor state.
/// See [`GenieXSupervisor::start_reuse`].
enum ReuseDecision {
    /// The identical configuration is resident and ready: reuse it, no spawn.
    Ready,
    /// The identical configuration is already starting: await that startup instead
    /// of competing with it.
    Await,
    /// Nothing reusable (different configuration, or stopped/failed/unloaded):
    /// proceed to the memory gate and a full start.
    Proceed,
}

/// Flags the CURRENTLY requested request may use, taken from the installed
/// executable's probed capability manifest (see [`crate::capabilities`]). GenieX
/// releases differ here — v0.10.0 rejects `--kv-type` and `--kv-in-ram` outright with
/// an unknown-flag error — so only flags the installed CLI documents are ever
/// emitted; an unsupported user choice is reported, not sent. The probe is cached
/// per executable identity (path, length, mtime — an in-place update invalidates it)
/// and runs under a deadline, off the async runtime so a wedged CLI cannot block it.
async fn supported_kv_flags(req: &StartServerRequest, exe: &Path) -> (Option<String>, bool) {
    let owned = exe.to_path_buf();
    let kv_type_wanted = req.kv_type.clone();
    let kv_in_ram_wanted = req.kv_in_ram == Some(true);
    let caps = tokio::task::spawn_blocking(move || crate::capabilities::probe(&owned))
        .await
        .unwrap_or_else(|_| crate::capabilities::probe(Path::new("")));
    let kv_type = if caps.kv_type_supported { kv_type_wanted } else { None };
    let kv_in_ram = caps.kv_in_ram_supported && kv_in_ram_wanted;
    (kv_type, kv_in_ram)
}

/// True when the readiness probe's `/v1/models` listing proves the REQUESTED model is
/// served. The match is deliberately narrow: an arbitrary suffix or prefix must never
/// pass (a model called `xother/model` is not `other/model`), while the harmless
/// spelling differences of one identity are tolerated — a `:precision` suffix the
/// server omits from its listing, and the cache-style `--` for `/` separator. When
/// BOTH sides name a precision, they must agree: it is a different artifact otherwise.
fn requested_model_listed(ids: &[String], wanted: Option<&str>) -> bool {
    let Some(wanted) = wanted else { return true };
    let wanted = wanted.trim().to_lowercase();
    if wanted.is_empty() {
        return true;
    }
    let split_precision = |s: &str| match s.split_once(':') {
        Some((base, prec)) => (base.to_string(), Some(prec.to_string())),
        None => (s.to_string(), None),
    };
    // "models--org--model" is the HuggingFace cache spelling of "org/model".
    let sep_normalized = |s: &str| s.replace("models--", "").replace("--", "/");
    let (want_base, want_prec) = split_precision(&wanted);
    ids.iter().any(|id| {
        let id = id.trim().to_lowercase();
        if id == wanted {
            return true;
        }
        let (id_base, id_prec) = split_precision(&id);
        let same_base = id_base == want_base || sep_normalized(&id_base) == sep_normalized(&want_base);
        let same_precision = match (&id_prec, &want_prec) {
            (Some(a), Some(b)) => a == b,
            _ => true, // one side omits the precision from its listing
        };
        same_base && same_precision
    })
}

/// Builds the `geniex serve` command line — the PRODUCTION command, extracted as one
/// pure function so the real construction (not a smoke-test impersonation) is what the
/// unit tests pin down. Returns the args plus what the server will actually run with
/// (`served*`), so the report and the command can never drift apart.
// one argument per thing the command line is made of; a struct would only rename them
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
fn build_serve_args(
    req: &StartServerRequest,
    host_arg: &str,
    eff_power_mode: &str,
    keepalive: u64,
    kv_type_supported: Option<&str>,
    kv_in_ram_supported: bool,
    is_qairt: bool,
    recommended_nctx: Option<u32>,
    caps: Option<&crate::capabilities::GeniexCapabilities>,
) -> (Vec<String>, Option<u32>, Option<String>, bool, Vec<String>) {
    let compute = req.compute.clone().unwrap_or_else(|| "npu".to_string());
    let mut args = vec![
        "serve".to_string(),
        "--host".to_string(),
        host_arg.to_string(),
        "--compute".to_string(),
        compute,
        "--power-mode".to_string(),
        eff_power_mode.to_string(),
        "--keepalive".to_string(),
        keepalive.to_string(),
        "--metrics".to_string(),
    ];

    if let Some(ref m) = req.model {
        args.push("--model".to_string());
        args.push(m.clone());
    }

    // QAIRT models compile context statically into the Hexagon NPU graph: no dynamic
    // context or KV cache flags are sent for them at all.
    let served_nctx: Option<u32> = if !is_qairt {
        let nctx = req.nctx.unwrap_or_else(|| recommended_nctx.unwrap_or(4096));
        args.push("--nctx".to_string());
        args.push(nctx.to_string());
        if kv_in_ram_supported {
            args.push("--kv-in-ram".to_string());
        }
        Some(nctx)
    } else {
        None
    };

    // NOTE: `--origins` is deliberately NOT sent. Probed against GenieX v0.10.0: the
    // flag is accepted but only sets CORS headers — it cannot block non-browser
    // clients (a request with no Origin or a foreign Origin still gets 200), and the
    // header it emits is a comma-joined origin list (`Access-Control-Allow-Origin:
    // a,b`), which browsers treat as invalid. MKMN's renderer never talks to the
    // endpoint directly (everything goes over the Tauri IPC bridge), and the Node
    // sidecar's requests carry no Origin header, so the flag would restrict nothing
    // that is not already restricted while risking malformed CORS headers. The
    // boundary that matters is `--host 127.0.0.1` (loopback-only binding), which is
    // always sent.

    // KV cache type: affects the memory estimate and the real process alike, so it is
    // forwarded (an OOM fallback that claims q4_0 has to actually run q4_0) — but only
    // when the installed CLI accepts the flag at all.
    if !is_qairt
        && let Some(kv) = kv_type_supported {
            args.push("--kv-type".to_string());
            args.push(kv.to_string());
        }

    // F13: an OPTIONAL flag is only sent when the INSTALLED executable's own help
    // documents it (the probed capability manifest — the same contract the KV
    // flags follow). An unknown flag makes geniex refuse to start at all, so an
    // undocumented REQUESTED flag is omitted AND reported, never dropped
    // silently. With no probe available, no optional flag may be assumed.
    let mut rejected: Vec<String> = Vec::new();
    let may = |flag: &str| caps.map(|c| c.supports(flag)).unwrap_or(false);
    let mut gate = |args: &mut Vec<String>, flag: &str, value: Option<&String>| {
        if let Some(v) = value {
            if may(flag) {
                args.push(flag.to_string());
                args.push(v.clone());
            } else {
                rejected.push(match caps {
                    Some(c) => format!("{} (this GenieX {} does not document it)", flag, c.geniex_version.as_deref().unwrap_or("build")),
                    None => format!("{} (the installed GenieX could not be probed)", flag),
                });
            }
        }
    };

    // Speculative decoding options (llama.cpp models only: a QAIRT bundle has no
    // llama.cpp draft machinery to configure).
    if !is_qairt {
        gate(&mut args, "--spec-type", req.spec_type.as_ref());
        gate(&mut args, "--draft-model", req.draft_model.as_ref());
        gate(&mut args, "--draft-tokens", req.draft_tokens.as_ref().map(|t| t.to_string()).as_ref());
        // 0 is "the runtime's own default" for both floors: never sent as an explicit flag.
        gate(&mut args, "--draft-min", req.draft_min.as_ref().filter(|t| **t > 0).map(|t| t.to_string()).as_ref());
        gate(&mut args, "--draft-p-min", req.draft_p_min.as_ref().filter(|t| **t > 0.0).map(|t| t.to_string()).as_ref());
        // Layer offload (-1 = all, the runtime's own default: nothing to send).
        if let Some(n) = req.ngl
            && n != -1 {
                gate(&mut args, "--ngl", Some(&n.to_string()));
            }
    }

    // Modality lazy-loading: only pass --vit-compute if explicitly requested (e.g. image analysis)
    gate(&mut args, "--vit-compute", req.vit_compute.as_ref());

    // A different QAIRT runtime is a QAIRT-only concern: never sent for a llama.cpp model.
    if is_qairt
        && let Some(ref lib) = req.qairt_lib
            && !lib.trim().is_empty() {
                gate(&mut args, "--qairt-lib", Some(lib));
            }

    // The runtime's own log level (--log / GENIEX_LOG): sent only when the person
    // asked for one; "none" (the CLI's own default) sends no flag.
    if let Some(ref lvl) = req.log_level
        && !lvl.is_empty() && lvl != "none" {
            gate(&mut args, "--log", Some(lvl));
        }

    // GenieX looks for its own updates (a network request) at every start unless it is
    // told not to; the setting decides, and the bare flag follows the same rule as the
    // others: sent only when this executable documents it, else reported.
    if req.skip_update == Some(true) {
        if may("--skip-update") {
            args.push("--skip-update".to_string());
        } else {
            rejected.push(match caps {
                Some(c) => format!("--skip-update (this GenieX {} does not document it)", c.geniex_version.as_deref().unwrap_or("build")),
                None => "--skip-update (the installed GenieX could not be probed)".to_string(),
            });
        }
    }

    if let Some(ref extra) = req.extra_args {
        args.extend(extra.clone());
    }

    // What is REPORTED must be what is actually sent: a QAIRT model gets no --kv-type
    // on its command line, so it must not be reported as served either.
    let served_kv_type = if is_qairt { None } else { kv_type_supported.map(|s| s.to_string()) };
    let served_kv_in_ram = !is_qairt && kv_in_ram_supported && req.kv_in_ram == Some(true);
    (args, served_nctx, served_kv_type, served_kv_in_ram, rejected)
}

impl GenieXSupervisor {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(SupervisorState::new())),
            client: reqwest::Client::builder()
                .timeout(Duration::from_millis(1500))
                .build()
                .unwrap_or_default(),
            startup_lock: Arc::new(tokio::sync::Mutex::new(())),
            startup_notify: Arc::new(tokio::sync::Notify::new()),
            watch_interval: Duration::from_secs(3),
        }
    }

    /// Test (and diagnostics) constructor with a shorter adopted-server watch
    /// cadence; production always uses `new`.
    pub fn with_watch_interval(interval: Duration) -> Self {
        let sup = Self::new();
        let mut sup = sup;
        sup.watch_interval = interval;
        sup
    }

    pub fn inner(&self) -> Arc<RwLock<SupervisorState>> {
        self.inner.clone()
    }

    pub fn find_geniex(custom_path: Option<&str>) -> Option<PathBuf> {
        // Overrides first, most explicit wins: an argument, then the saved setting
        // (settings.geniexPath), then the GENIEX_PATH environment variable. Every
        // consumer (setup, inventory, serving) resolves through here, so a custom
        // install is used consistently by all of them.
        let mut overrides: Vec<String> = Vec::new();
        if let Some(p) = custom_path
            && !p.trim().is_empty() {
                overrides.push(p.trim().to_string());
            }
        if let Some(p) = crate::settings::load_settings()
            .get("geniexPath")
            .and_then(|v| v.as_str())
            && !p.trim().is_empty() {
                overrides.push(p.trim().to_string());
            }
        if let Ok(p) = std::env::var("GENIEX_PATH")
            && !p.trim().is_empty() {
                overrides.push(p.trim().to_string());
            }
        for p in overrides {
            let path = PathBuf::from(&p);
            // The override comes from the webview (an argument or a saved setting): only
            // a file named geniex.exe is ever run from it, never any other program.
            if is_geniex_exe(&path) && path.is_file() {
                return Some(path);
            }
        }

        // 1. Check bundled runtime next to MKMN.exe: <Install_Root>\Runtime\geniex.exe
        if let Ok(exe_path) = std::env::current_exe()
            && let Some(dir) = exe_path.parent() {
                let candidate = dir.join("Runtime").join("geniex.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
            }

        // 2. Check Per-User install runtime (%LOCALAPPDATA%\Programs\MKMN\Runtime\geniex.exe)
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let candidate = Path::new(&local).join("Programs").join("MKMN").join("Runtime").join("geniex.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }

        // 3. Check Per-Machine install runtime (C:\Program Files\MKMN\Runtime\geniex.exe)
        if let Ok(pf) = std::env::var("ProgramFiles") {
            let candidate = Path::new(&pf).join("MKMN").join("Runtime").join("geniex.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }

        // 4. Check GenieX CLI default install location (%LOCALAPPDATA%\GenieX CLI\geniex.exe)
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let path = Path::new(&local_appdata)
                .join("GenieX CLI")
                .join("geniex.exe");
            if path.exists() {
                return Some(path);
            }
        }

        // 5. Check PATH environment variable
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join("geniex.exe");
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }

        None
    }

    pub fn get_status_from_state(&self, state: &SupervisorState) -> ServerStatus {
        // The busy flag is a property of the ready server, not a lifecycle step of its
        // own: the internal state stays "ready" (every reuse check compares against
        // "ready"), and only the reported status combines the two.
        let reported_state = if state.state == ServerLifecycleState::Ready && state.busy {
            ServerLifecycleState::Busy
        } else {
            state.state
        };
        ServerStatus {
            state: reported_state,
            endpoint: format!("http://127.0.0.1:{}/v1", state.port),
            pid: state.pid,
            restarts: state.restarts,
            // Classified here, at the single place the status is built: every consumer
            // (renderer, sidecar, tray) gets the same honest title/fix, never a raw
            // string under a key nobody reads.
            last_error: state.last_error.as_ref().map(|raw| classify_load_error(raw)),
            hardware_verification: state.hw_verification.clone(),
            model: state.current_model.clone(),
            served_nctx: state.served_nctx,
            context_kind: state.context_kind.clone(),
            served_kv_type: state.served_kv_type.clone(),
            served_kv_in_ram: state.served_kv_in_ram,
        }
    }

    pub async fn get_status(&self) -> ServerStatus {
        let state = self.inner.read().await;
        self.get_status_from_state(&state)
    }

    pub async fn get_logs(&self) -> Vec<String> {
        let state = self.inner.read().await;
        state.logs.iter().cloned().collect()
    }

    /// Marks the ready server as generating (or finished generating). Called by the
    /// chat orchestrator around each completion so the UI can show "busy" instead of
    /// a ready server that only LOOKS idle. Setting the flag on a non-ready server is
    /// a no-op: the lifecycle state always wins over the generation flag.
    pub async fn set_busy(&self, busy: bool) {
        let mut state = self.inner.write().await;
        if busy {
            if state.state == ServerLifecycleState::Ready {
                state.busy = true;
            }
        } else {
            state.busy = false;
        }
    }

    /// Whether a generation is running on the ready server. The benchmark
    /// consults this AFTER taking the admission lock: a generation that started
    /// while the lock was being awaited must still be seen — the busy flag is
    /// the generation's LEASE on the resident server, and releasing the server
    /// under an active lease would kill a running completion (C04).
    pub async fn is_generating(&self) -> bool {
        let state = self.inner.read().await;
        state.busy
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut state = self.inner.write().await;
        state.cancel_generation += 1;
        self.stop_locked(&mut state).await?;
        self.startup_notify.notify_waiters();
        Ok(())
    }

    /// Releases the model before a different engine or a standalone benchmark can load.
    /// The caller holds admission. A foreign listener remains under its owner's control.
    pub(crate) async fn release_for_handoff(&self) -> Result<(), String> {
        let mut state = self.inner.write().await;
        if state.busy {
            return Err("A GenieX generation is running. Wait for it to finish before switching engines.".into());
        }
        let external_pid = state.pid.filter(|pid| state.adopted && adopted_process_alive(*pid))
            .or_else(|| {
                if state.child.is_some() { return None; }
                let listener = tcp_listener_owner(state.port)?;
                listener.image.as_deref().filter(|image| is_geniex_exe(Path::new(image)))?;
                Some(listener.pid)
            });
        if let Some(pid) = external_pid {
            return Err(format!("An external GenieX server (PID {pid}) may still hold the NPU. Stop it from its own session before switching engines or benchmarking."));
        }
        self.stop_locked(&mut state).await
    }

    async fn stop_locked(&self, state: &mut SupervisorState) -> Result<(), String> {
        let owned = state.child.is_some();
        let adopted = released_server_was_adopted(owned, state.adopted);
        Self::terminate_child(state).await?;
        state.pid = None;
        state.adopted = false;
        state.set_state(ServerLifecycleState::Stopped);
        state.current_model = None;
        state.served_nctx = None;
        state.served_kv_type = None;
        state.served_kv_in_ram = false;
        state.context_kind = None;
        state.busy = false;
        state.epoch += 1;
        state.hw_verification = HardwareVerification::default();
        // Tier 2 QoS inhibits sleep for the runtime; stopping it must release that
        // inhibition (the dedicated owner thread makes this process-global).
        crate::power::set_sleep_inhibit(false);
        if adopted {
            // This server was adopted, not started by MKMN: it must not be killed, and
            // the log must not claim it was stopped.
            state.append_log(
                "[supervisor] Released an adopted GenieX server; it was started outside MKMN and was left running.".to_string(),
            );
        } else {
            state.append_log("[supervisor] GenieX server stopped.".to_string());
        }
        Ok(())
    }

    async fn terminate_child(state: &mut SupervisorState) -> Result<(), String> {
        if let Some(child) = state.child.as_mut()
            && let Err(err) = child.kill().await
            && !matches!(child.try_wait(), Ok(Some(_))) {
            return Err(format!("GenieX could not be stopped: {err}"));
        }
        state.child = None;
        Ok(())
    }

    async fn await_startup(&self, requested_model: Option<&str>) -> Result<ServerStatus, String> {
        let start_time = Instant::now();
        let timeout = Duration::from_secs(120);

        while start_time.elapsed() < timeout {
            {
                let state = self.inner.read().await;
                if requested_model.is_some() && state.current_model.as_deref() != requested_model {
                    return Err("Model switched during startup".to_string());
                }
                if state.state == ServerLifecycleState::Ready {
                    return Ok(self.get_status_from_state(&state));
                } else if state.state == ServerLifecycleState::Failed {
                    return Err(state.last_error.clone().unwrap_or_else(|| "Server startup failed".to_string()));
                } else if state.state == ServerLifecycleState::Stopped {
                    return Err("Server was stopped during startup".to_string());
                }
            }

            tokio::select! {
                _ = self.startup_notify.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }

        Err("Timed out waiting for server startup".to_string())
    }

    pub(crate) async fn cancel_generation(&self) -> u64 {
        self.inner.read().await.cancel_generation
    }

    /// True when `req` describes exactly the configuration that produced the currently
    /// running/starting server: model, compute, context, KV, executable, power mode and
    /// keepalive all change what `geniex serve` runs with, so a reuse decision must
    /// compare the whole effective request, not the model name alone.
    fn same_request(state: &SupervisorState, req: &StartServerRequest) -> bool {
        match state.last_request.as_ref() {
            Some(last) => {
                let effective = |request: &StartServerRequest| {
                    let mut request = request.clone();
                    request.retry_model_load = false;
                    request.keepalive_sec = Some(request.effective_keepalive());
                    request.strategy = None;
                    request.log_level = request.log_level.filter(|value| !matches!(value.as_str(), "" | "none"));
                    serde_json::to_value(request).ok()
                };
                effective(last) == effective(req)
            }
            None => false,
        }
    }

    /// The reuse decision for a start request against the current state, extracted as a
    /// pure function so the idempotency contract is pinned by tests: an identical
    /// ready server is reused, an identical in-flight startup is awaited, and every
    /// other state (different configuration, stopped, failed, or `unloaded` after the
    /// keepalive idle timeout) proceeds to a full start so the model auto-reloads.
    fn start_reuse(state: &SupervisorState, req: &StartServerRequest) -> ReuseDecision {
        if !Self::same_request(state, req) {
            return ReuseDecision::Proceed;
        }
        match state.state {
            ServerLifecycleState::Ready => ReuseDecision::Ready,
            ServerLifecycleState::Starting | ServerLifecycleState::Loading => ReuseDecision::Await,
            _ => ReuseDecision::Proceed,
        }
    }

    /// THE admission gate for model-changing runtime work. Chat starts, preloads and
    /// restarts serialize on the startup lock; the benchmark path spawns its own
    /// `geniex infer`, which loads a full model copy onto the NPU and would otherwise
    /// bypass admission entirely. Any model-changing operation must hold this lock for
    /// its whole load/run, so two such operations can never race for NPU memory.
    pub async fn admit(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.startup_lock.lock().await
    }

    /// `req` with the `--qairt-lib` folder its start will really use (`effective_qairt_lib`).
    fn with_qairt_runtime(mut req: StartServerRequest) -> StartServerRequest {
        let is_qairt = req.model.as_deref().is_some_and(is_qairt_model);
        let exe = if is_qairt { Self::find_geniex(req.exe.as_deref()) } else { None };
        let flag = exe.as_deref().is_some_and(|e| crate::capabilities::probe(e).supports("--qairt-lib"));
        let env = std::env::var("GENIEX_QAIRT_LIB").ok();
        req.qairt_lib = crate::qairt_runtime::effective_qairt_lib(
            req.qairt_lib.as_deref(), env.as_deref(), is_qairt, flag,
            || exe.as_deref().and_then(crate::qairt_runtime::pinned_runtime),
        );
        req
    }

    pub async fn start(&self, req: StartServerRequest) -> Result<ServerStatus, String> {
        self.start_with_generation(req, self.cancel_generation().await).await
    }

    pub(crate) async fn start_with_generation(&self, req: StartServerRequest, generation: u64) -> Result<ServerStatus, String> {
        // The GenieX process boundary: internal application ids ("custom:...", "dynamic:<tier>")
        // are NOT cache names. One reaching here means the renderer's identity resolution was
        // skipped or failed — GenieX answers `SDKError(File not found or inaccessible)` for
        // them, so fail fast with the reason instead of launching a server that cannot load.
        if let Some(ref m) = req.model
            && is_app_model_id(m)
        {
            return Err(format!(
                "'{}' is an application model id, not a cache name: it was not resolved to an installed model. Pick the model again in Models.",
                m
            ));
        }
        // A name with no namespace is not in GenieX's cache (a Foundry Local alias): GenieX would serve
        // nothing, and the start waited 90 s, then 90 s more with a smaller context, before failing.
        if let Some(ref m) = req.model
            && !is_cache_shaped(m)
        {
            return Err(format!(
                "'{}' is not a GenieX model name (a GenieX model is named org/model). A Foundry Local model is loaded by Foundry Local, not GenieX.",
                m
            ));
        }

        // GenieX v0.11.0 or newer is mandatory for inference: a missing CLI, an older one or
        // one that reports no valid version is refused here, before a server is reused,
        // adopted or spawned (a custom geniex.exe passes the same gate).
        crate::capabilities::require_geniex(req.exe.as_deref())?;

        // The QAIRT runtime of a native model is settled ONCE, before anything compares or
        // builds the request: with no folder of the person's own, the installed GenieX's
        // own runtime is pinned (qairt_runtime.rs: the DSP otherwise loaded an older V81
        // skel a driver package put in the DriverStore, and every QAIRT 2.50 bundle failed).
        let req = Self::with_qairt_runtime(req);

        // Resident-model idempotency FIRST: a model that is already resident and ready
        // must never be refused by a free-RAM check that assumes a second full copy has
        // to fit alongside it.
        {
            let state = self.inner.read().await;
            if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
            match Self::start_reuse(&state, &req) {
                ReuseDecision::Ready => return Ok(self.get_status_from_state(&state)),
                ReuseDecision::Await => {
                    drop(state);
                    return self.await_startup(req.model.as_deref()).await;
                }
                ReuseDecision::Proceed => {}
            }
        }

        // The startup lock is taken BEFORE the memory gate: when the switch only fits
        // because the resident copy we own will be released, the release has to happen
        // under the same lock that spawns the replacement.
        let _guard = self.startup_lock.lock().await;

        // Double check state inside the lock
        {
            let state = self.inner.read().await;
            if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
            match Self::start_reuse(&state, &req) {
                ReuseDecision::Ready => return Ok(self.get_status_from_state(&state)),
                ReuseDecision::Await => {
                    drop(state);
                    return self.await_startup(req.model.as_deref()).await;
                }
                ReuseDecision::Proceed => {}
            }
            // A reply is being generated on the resident server: starting a different
            // model now would kill it mid-answer. The same request re-entering is
            // already handled above (ReuseDecision); only a CHANGE is refused here.
            if state.busy {
                return Err("A reply is still being generated. Wait for it to finish, or stop it first.".to_string());
            }
        }

        let has_warmup_failures = !self.inner.read().await.warmup_failures.0.is_empty();
        if has_warmup_failures && !req.retry_model_load
            && let Some(model) = req.model.as_deref()
            && let Some(exe) = Self::find_geniex(req.exe.as_deref())
        {
            let compute = req.compute.as_deref().unwrap_or("npu");
            let caps = crate::capabilities::probe(&exe);
            let (runtime, _) = warmup_runtime(&exe, req.qairt_lib.as_deref().filter(|_| is_qairt_model(model)), &caps);
            let build = warmup_build(model);
            let key = format!("{runtime} {compute} {build}");
            let state = self.inner.read().await;
            if let Some(error) = state.warmup_failures.blocked(&key, false) {
                return Err(warmup_recovery_details(&state, error, &runtime, &build, true));
            }
        }

        // Pre-flight port probe: only when WE own no server under this supervisor. If
        // the port is already held, that is either a compatible GenieX server we can
        // honestly adopt (it already serves the requested model) or a conflict to
        // report — never a reason to kill a process we did not start, and never memory
        // pressure. When we DO own a resident server (a model switch), the probe is
        // skipped: our own server holds the port until `start_internal` stops it.
        {
            let owns_child = { self.inner.read().await.child.is_some() };
            let port = req.port.unwrap_or(DEFAULT_PORT);
            if !owns_child
                && let Some(owner) = tcp_listener_owner(port) {
                    match self.try_adopt_existing(&req, port, &owner, generation).await {
                        Adoption::Adopted(status) => return Ok(*status),
                        Adoption::Conflict(err) => {
                            {
                                let mut state = self.inner.write().await;
                                if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
                                // A ready adopted server is still running: do not claim it
                                // failed just because a switch to another model was refused.
                                if state.state != ServerLifecycleState::Ready {
                                    state.set_state(ServerLifecycleState::Failed);
                                }
                                state.last_error = Some(err.clone());
                                state.append_log(format!("[supervisor] {}", err));
                            }
                            return Err(err);
                        }
                        Adoption::NotAdoptable => {
                            let err = port_conflict_message(port, Some(&owner));
                            {
                                let mut state = self.inner.write().await;
                                if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
                                // A ready adopted server is still running: do not claim it
                                // failed just because a switch to another model was refused.
                                if state.state != ServerLifecycleState::Ready {
                                    state.set_state(ServerLifecycleState::Failed);
                                }
                                state.last_error = Some(err.clone());
                                state.append_log(format!("[supervisor] {}", err));
                            }
                            return Err(err);
                        }
                    }
                }
        }

        // Pre-flight memory verification using GlobalMemoryStatusEx, credited with the
        // RAM the runtime WE OWN will release: switching models stops the resident copy
        // before the new one spawns, so its footprint is available again. The credited
        // figure goes into the estimate itself, so `fits` cannot reject a switch that
        // the credited `available_ram_gb` would allow.
        if let Some(ref m) = req.model {
            // The estimate must reflect what the server will ACTUALLY run with: a
            // --kv-type this installed GenieX does not support is omitted at start,
            // so it must not inflate the pre-flight estimate as though applied.
            let effective_kv = match Self::find_geniex(req.exe.as_deref()) {
                Some(exe) => supported_kv_flags(&req, &exe).await.0,
                None => req.kv_type.clone(),
            };
            let (avail_bytes, _total_bytes) = get_available_ram_bytes();
            let mut avail_gb = avail_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
            let resident_gb = {
                let state = self.inner.read().await;
                match state.current_model.as_deref() {
                    Some(resident) if matches!(state.state, ServerLifecycleState::Ready | ServerLifecycleState::Starting) => {
                        estimate_memory(resident, None, None).total_required_gb
                    }
                    _ => 0.0,
                }
            };
            avail_gb += resident_gb;
            let est = estimate_memory_credited(m, req.nctx, effective_kv.as_deref(), resident_gb);
            if !est.fits || avail_gb < est.total_required_gb {
                // The credited estimate still refuses. If we own a resident server,
                // measure the RAM that ACTUALLY comes back after releasing it before
                // the final verdict: estimates must not get the last word over a real
                // measurement of memory we control.
                let released_resident = if resident_gb > 0.0 {
                    {
                        let mut state = self.inner.write().await;
                        if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
                        self.stop_locked(&mut state).await?;
                    }
                    let (after_bytes, _t) = get_available_ram_bytes();
                    let after_gb = after_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
                    let est_after = estimate_memory_credited(m, req.nctx, effective_kv.as_deref(), 0.0);
                    if est_after.fits && after_gb >= est_after.total_required_gb {
                        None // the measured reality is enough: proceed with the switch
                    } else {
                        Some(after_gb)
                    }
                } else {
                    Some(avail_gb)
                };
                if let Some(reject_avail_gb) = released_resident {
                    // Say WHICH constraint failed: the NPU budget is an ESTIMATE
                    // (75% of RAM), so "over budget" is not the physical truth and
                    // the wording must invite the override, while "over free RAM"
                    // is a measured fact.
                    let why = if est.total_required_gb > est.npu_budget_gb && est.total_required_gb <= reject_avail_gb {
                        format!(
                            "the estimated footprint ({:.2} GB) exceeds the app's NPU memory budget ({:.2} GB, estimated from RAM — set an exact NPU budget in Settings if this device allows more)",
                            est.total_required_gb, est.npu_budget_gb
                        )
                    } else {
                        format!(
                            "the estimated footprint ({:.2} GB) exceeds available RAM ({:.2} GB)",
                            est.total_required_gb, reject_avail_gb
                        )
                    };
                    let err = format!(
                        "Pre-flight memory check failed: {}{}.",
                        why,
                        if resident_gb > 0.0 {
                            // The resident copy was already stopped for the measurement: say so.
                            " (the resident model was stopped to measure the freed RAM and could not be restarted)".to_string()
                        } else {
                            String::new()
                        }
                    );
                    {
                        let mut state = self.inner.write().await;
                        state.append_log(format!("[supervisor] {}", err));
                    }
                    return Err(err);
                }
            }
        }

        let res = self.start_internal(req, false, generation).await;
        self.startup_notify.notify_waiters();
        res
    }

    /// Restart the server with the same request that started it (tray "Restart Runtime").
    /// A restart must ACTUALLY restart: it stops the running server and starts a fresh
    /// process, bypassing same-model reuse (which would hand back the ready server
    /// untouched). Returns an error when nothing was ever started.
    pub async fn restart(&self, generation: u64) -> Result<ServerStatus, String> {
        let req = {
            let state = self.inner.read().await;
            state.last_request.clone()
        };
        let Some(req) = req else {
            return Err("No runtime has been started yet; nothing to restart.".to_string());
        };
        let _guard = self.startup_lock.lock().await;
        let res = self.start_internal(req, false, generation).await;
        self.startup_notify.notify_waiters();
        res
    }

    /// Adopts a GenieX server that is ALREADY listening on `port` and can PROVE it
    /// serves the requested model, instead of spawning a second one that would fail
    /// to bind.
    ///
    /// Adoption is deliberately narrow and non-destructive:
    /// - the owner must be the same `geniex.exe` this app would run;
    /// - its `/v1/models` listing must contain the requested identity (a listing
    ///   alone is NOT enough — it proves the model is KNOWN, not that it is
    ///   resident or that the server answers: a warm-up completion is required);
    /// - the warm-up's NPU sampling of the owner's PID measures what compute the
    ///   adopted server ACTUALLY uses; nothing about compute, power mode or QoS is
    ///   claimed without that measurement.
    ///
    /// The adopted process is NEVER stored as `state.child`, so stopping MKMN (or
    /// the runtime) can never kill a process this app did not start; `state.pid`
    /// records it only for reporting, and a dedicated watcher invalidates the
    /// "ready" status when that process dies. Returns None when the port is held by
    /// something MKMN must not adopt (a different program, a different model, or an
    /// unreadable owner).
    async fn try_adopt_existing(
        &self,
        req: &StartServerRequest,
        port: u16,
        owner: &PortOwner,
        generation: u64,
    ) -> Adoption {
        // Only a geniex runtime we can positively identify is adoptable.
        let owner_name = owner
            .image
            .as_deref()
            .and_then(|p| Path::new(p).file_name())
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase());
        let our_name = Self::find_geniex(req.exe.as_deref())
            .as_deref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase());
        if owner_name.is_none() || owner_name != our_name {
            return Adoption::NotAdoptable;
        }
        // Connecting to a server is inference too: the executable that serves the port must
        // pass the same minimum-version gate as one MKMN would start itself.
        if let Some(image) = owner.image.as_deref()
            && let Err(e) = crate::capabilities::require_compatible(Path::new(image))
        {
            return Adoption::Conflict(format!("The GenieX server already on port {port} was not used. {e}"));
        }

        // Ask it what it serves — the same readiness contract a spawned server must meet.
        let probe_url = format!("http://127.0.0.1:{}/v1/models", port);
        let resp = match self.client.get(&probe_url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => return Adoption::NotAdoptable,
        };
        let body = match resp.json::<serde_json::Value>().await {
            Ok(b) => b,
            Err(_) => return Adoption::NotAdoptable,
        };
        let ids: Vec<String> = body
            .get("data")
            .and_then(|d| d.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                    .map(|s| s.trim().to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        if ids.is_empty() || !requested_model_listed(&ids, req.model.as_deref()) {
            return Adoption::NotAdoptable;
        }

        // The listing proves the model is KNOWN, nothing more: prove the server is
        // actually READY by making it answer a real (tiny) completion, and measure
        // what compute it really used while answering. A server that refuses (a
        // listed-but-unloaded model) or cannot be reached is reported, never adopted
        // and never killed — it was started outside MKMN.
        let model = match req.model.as_deref() {
            Some(m) => m,
            None => return Adoption::NotAdoptable,
        };
        let compute = req.compute.as_deref().unwrap_or("npu");
        let wants_npu = compute == "npu" || compute == "hybrid";
        let npu_peak = match run_warmup_probe(&self.client, port, model, Some(owner.pid), wants_npu).await {
            WarmupOutcome::Ok { npu_peak, .. } => npu_peak,
            WarmupOutcome::Rejected { status, body } => {
                return Adoption::Conflict(format!(
                    "Port {} already hosts geniex.exe (PID {}), which lists the requested \
                     model but did not answer a warm-up completion (HTTP {}): {}. MKMN \
                     adopted nothing and started no second server: that server is not \
                     ready to serve. It was started outside MKMN — stop it there, or \
                     choose another port in Settings, then retry.",
                    port,
                    owner.pid,
                    status,
                    body
                ));
            }
            WarmupOutcome::Unreachable(e) => {
                return Adoption::Conflict(format!(
                    "Port {} already hosts geniex.exe (PID {}), which lists the requested \
                     model but stopped answering during the warm-up request ({}). MKMN \
                     adopted nothing and started no second server. It was started outside \
                     MKMN — stop it there, or choose another port in Settings, then retry.",
                    port, owner.pid, e
                ));
            }
        };

        // Adopt: report the running server as ready WITHOUT taking ownership. No child
        // handle is stored, so no stop path can kill it and the post-ready child
        // watcher is not used for it (there is no handle to watch) — a dedicated
        // watcher polls the process instead.
        let adopt_epoch;
        {
            let mut state = self.inner.write().await;
            if state.cancel_generation != generation {
                return Adoption::Conflict("The GenieX start was cancelled.".into());
            }
            state.port = port;
            state.set_state(ServerLifecycleState::Ready);
            state.pid = Some(owner.pid);
            state.adopted = true;
            state.current_model = Some(model.to_string());
            state.busy = false;
            state.last_error = None;
            state.served_nctx = None;
            state.served_kv_type = None;
            state.served_kv_in_ram = false;
            state.context_kind = None;
            state.hw_verification = adopted_verification(npu_peak);
            state.last_request = Some(req.clone());
            adopt_epoch = state.epoch;
            state.append_log(format!(
                "[supervisor] Port {} already hosts a compatible GenieX ({}); adopting it instead of starting a second server (MKMN did not start it and will not stop it). Warm-up answered; NPU load measured: {}.",
                port,
                owner.label(),
                npu_peak.map(|p| format!("{:.0}%", p)).unwrap_or_else(|| "not measurable".to_string())
            ));
        }
        self.spawn_adopted_watcher(adopt_epoch, owner.pid);
        Adoption::Adopted(Box::new(self.get_status().await))
    }

    /// Watches an ADOPTED server's process: MKMN holds no child handle for it, so
    /// nothing else would notice its death, and a stale "ready" would send every
    /// chat into a dead endpoint. When the process exits (or the PID was recycled
    /// by a different image), the stale status is invalidated honestly. The server
    /// itself is NEVER touched — MKMN did not start it.
    fn spawn_adopted_watcher(&self, adopt_epoch: u64, pid: u32) {
        let watcher_state = self.inner.clone();
        let watcher_notify = self.startup_notify.clone();
        let interval = self.watch_interval;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let mut s = watcher_state.write().await;
                // Only the adopted server this watcher was created for: any stop,
                // new start (epoch bump) or replacement ends this watcher.
                if s.epoch != adopt_epoch || s.state != ServerLifecycleState::Ready || s.child.is_some() {
                    return;
                }
                if s.pid != Some(pid) {
                    return;
                }
                if adopted_process_alive(pid) {
                    continue;
                }
                s.pid = None;
                s.adopted = false;
                s.hw_verification = HardwareVerification::default();
                s.set_state(ServerLifecycleState::Failed);
                s.last_error = Some(format!(
                    "The adopted GenieX server (PID {}, started outside MKMN) is no longer \
                     running; its ready status was invalid. The next request starts a \
                     fresh server.",
                    pid
                ));
                s.append_log(format!(
                    "[supervisor] Adopted GenieX process {} exited; the stale ready status was invalidated.",
                    pid
                ));
                watcher_notify.notify_waiters();
                return;
            }
        });
    }

    async fn start_internal(&self, req: StartServerRequest, is_retry: bool, generation: u64) -> Result<ServerStatus, String> {
        // Stop any currently running instance under lock
        {
            let mut state = self.inner.write().await;
            if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
            self.stop_locked(&mut state).await?;
        }

        // every spawn (a restart and the tray's restart included) passes the minimum-version gate
        let exe_path = crate::capabilities::require_geniex(req.exe.as_deref())?;

        let port = req.port.unwrap_or(DEFAULT_PORT);
        let host_arg = format!("127.0.0.1:{}", port);
        let compute = req.compute.clone().unwrap_or_else(|| "npu".to_string());

        // Resolve power mode: burst, sustained_high_performance, power_saver, or auto adaptive
        let raw_power_mode = req.power_mode.as_deref().unwrap_or("burst");
        let eff_power_mode = resolve_effective_power_mode(raw_power_mode);

        // Loading strategy: "always" = 86400 (24h keepalive), "demand" = 300 (5min keepalive)
        let keepalive = req.effective_keepalive();

        // Startup readiness timeout: 30s to 300s, default 90s
        let timeout_sec = req.timeout_sec.unwrap_or(DEFAULT_TIMEOUT_SEC).clamp(30, 300);

        // No --data-dir override: GenieX serves its own default cache (~/.cache/geniex).
        // Pointing it at %LOCALAPPDATA%\GenieX started a server with an EMPTY model set:
        // /v1/models answered 200 immediately, the probe called it ready, and every chat
        // completion then failed with 400 Bad Request because no model was loaded.
        let model_ref = req.model.clone();
        let is_qairt = model_ref.as_deref().is_some_and(is_qairt_model);

        // Which optional KV flags this installed GenieX actually accepts (probed once
        // per executable identity, cached, under a deadline). A flag the CLI does not
        // know makes geniex refuse to start at all, so unsupported choices are reported
        // and omitted rather than sent.
        let (kv_type_supported_req, kv_in_ram_supported) = supported_kv_flags(&req, &exe_path).await;
        if req.kv_type.is_some() && kv_type_supported_req.is_none() {
            let mut state = self.inner.write().await;
            state.append_log(format!(
                "[supervisor] This GenieX build does not support --kv-type; the requested KV cache type {:?} was not applied.",
                req.kv_type
            ));
        }
        if req.kv_in_ram == Some(true) && !kv_in_ram_supported {
            let mut state = self.inner.write().await;
            state.append_log("[supervisor] This GenieX build does not support --kv-in-ram; the request was not applied.".to_string());
        }

        // The context kind decides how the context window reaches the server: a QAIRT
        // bundle compiled its context into the Hexagon graph statically (no --nctx is
        // sent, and requesting one is reported as not applied), while a GGUF model
        // takes a dynamic --nctx. The QAIRT compiled window is read from the bundle's
        // own geniex.json so the report says what the graph can actually hold.
        let context_kind: Option<String> = if is_qairt {
            Some("compiled".to_string())
        } else if model_ref.is_some() {
            Some("configurable".to_string())
        } else {
            None
        };
        let compiled_nctx = if is_qairt {
            model_ref.as_deref().and_then(qairt_compiled_context)
        } else {
            None
        };
        if is_qairt
            && let Some(wanted) = req.nctx {
                let mut state = self.inner.write().await;
                state.append_log(format!(
                    "[supervisor] Requested context {} not applied: the QAIRT model's context is compiled into the graph ({}).",
                    wanted,
                    compiled_nctx.map(|n| n.to_string()).unwrap_or_else(|| "unknown compiled length".to_string())
                ));
            }

        // F13: the capability manifest of THIS executable gates every optional
        // flag (the probe is cached per executable identity, so this is cheap).
        let caps = crate::capabilities::probe(&exe_path);
        let (runtime_key, runtime_details) = warmup_runtime(&exe_path,
            req.qairt_lib.as_deref().filter(|_| is_qairt), &caps);
        let build = model_ref.as_deref().map(warmup_build);
        let warmup_key = build.as_ref().map(|build| format!("{runtime_key} {compute} {build}"));
        let recommended_nctx = model_ref
            .as_ref()
            .map(|m| estimate_memory(m, None, kv_type_supported_req.as_deref()).recommended_nctx);
        // Keep runtime errors visible even when verbose logging is disabled.
        let mut launch_req = req.clone();
        if warmup_key.is_some() && matches!(launch_req.log_level.as_deref(), None | Some("" | "none")) {
            launch_req.log_level = Some("error".to_owned());
        }
        let (args, mut served_nctx, served_kv_type, served_kv_in_ram, rejected_flags) = build_serve_args(
            &launch_req,
            &host_arg,
            eff_power_mode,
            keepalive,
            kv_type_supported_req.as_deref(),
            kv_in_ram_supported,
            is_qairt,
            recommended_nctx,
            Some(&caps),
        );
        if !rejected_flags.is_empty() {
            let mut state = self.inner.write().await;
            state.append_log(format!(
                "[supervisor] Requested options NOT applied (the installed GenieX does not support them): {}.",
                rejected_flags.join(", ")
            ));
        }
        // For a QAIRT model the compiled graph IS the served context: report the window
        // the bundle was built with instead of a bare "no dynamic context".
        if is_qairt && served_nctx.is_none() {
            served_nctx = compiled_nctx;
        }

        {
            let mut state = self.inner.write().await;
            if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
            state.port = port;
            state.set_state(ServerLifecycleState::Starting);
            state.current_model = model_ref.clone();
            state.served_nctx = served_nctx;
            state.served_kv_type = served_kv_type;
            state.served_kv_in_ram = served_kv_in_ram;
            state.context_kind = context_kind.clone();
            state.busy = false;
            state.last_error = None;
            // Only what was REQUESTED is recorded here, clearly marked as such; nothing
            // is claimed as verified before the process has even spawned.
            state.hw_verification = requested_verification(&compute, eff_power_mode);
            state.last_request = Some(req.clone());
            // The ONE window decision, logged with its reason at serve start: an explicit request (a kept load
            // profile or a call that asked), the RAM tier's recommendation, or the 4096 default — so a meter
            // or a prompt budget can always be checked against what the server really runs with.
            let window_reason = if is_qairt {
                format!(
                    "QAIRT: compiled into the graph ({})",
                    compiled_nctx.map(|n| n.to_string()).unwrap_or_else(|| "unknown compiled length".to_string())
                )
            } else if req.nctx.is_some() {
                "asked for: a kept load profile or an explicit request".to_string()
            } else {
                match recommended_nctx {
                    Some(n) => format!("RAM tier default; the memory estimate suggests {} when it fits", n),
                    None => "RAM tier default; no size estimate for this model".to_string(),
                }
            };
            state.append_log(format!(
                "[supervisor] Context window: {} tokens ({}); recommends {:?}",
                served_nctx.map(|n| n.to_string()).unwrap_or_else(|| "dynamic".to_string()),
                window_reason,
                recommended_nctx
            ));
            state.append_log(format!(
                "[supervisor] GenieX capabilities: context kind {}; served context {}",
                context_kind.as_deref().unwrap_or("n/a"),
                served_nctx.map(|n| format!("{} tokens", n)).unwrap_or_else(|| "dynamic (no --nctx)".to_string())
            ));
            state.append_log(format!("[supervisor] Spawning GenieX: {:?} {:?}", exe_path, args));
        }

        let mut cmd = Command::new(&exe_path);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Publish the child under the same lock as cancellation so a stop either sees
        // the child or prevents it from being created.
        let (stdout, stderr, spawn_epoch) = {
            let mut state = self.inner.write().await;
            if state.cancel_generation != generation { return Err("The GenieX start was cancelled.".into()); }
            let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn geniex.exe: {}", e))?;
            let pid = child.id().ok_or_else(|| "Failed to obtain process ID".to_string())?;
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            if let Some(ref job) = state.job {
                job.assign_process(pid);
                state.append_log(format!("[supervisor] Process {} assigned to Windows Job Object (Auto-Kill on Close)", pid));
            }
            state.pid = Some(pid);
            state.child = Some(child);
            state.warmup_runtime_errors.clear();
            state.warmup_context_error = None;
            match crate::qos::apply_pid_tier(pid, crate::qos::QoSTier::InferenceCritical) {
                Ok(()) => state.append_log(format!("[supervisor] Process {pid} configured with Tier 2 Inference-Critical (ABOVE_NORMAL, Unthrottled)")),
                Err(e) => state.append_log(format!("[supervisor] Warning: Failed to apply Tier 2 QoS to PID {pid}: {e}")),
            }
            (stdout, stderr, state.epoch)
        };

        // Spawn background log reader tasks for stdout & stderr with active hardware verification
        let state_clone = self.inner.clone();

        let stdout_reader = stdout.map(|out| {
            let sc = state_clone.clone();
            let reader_epoch = spawn_epoch;
            tokio::spawn(async move {
                let mut reader = BufReader::new(out).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let mut s = sc.write().await;
                    s.capture_warmup_error(reader_epoch, &line);
                    // Hardware execution verification, scoped to this child's epoch and
                    // never taken from an error/diagnostic line that merely MENTIONS the
                    // backend. A detected fallback contradicts and outranks any earlier
                    // NPU claim; evidence is not flipped back and forth by later lines.
                    // The fallback check runs FIRST: a normal-looking line can mention
                    // both backends ("HTP requested, falling back to cpu"), and the
                    // fallback is the truth about what will execute.
                    let lower = line.to_lowercase();
                    let looks_like_error = ["error", "warn", "fail", "unknown", "unrecognized", "no such", "invalid"]
                        .iter().any(|w| lower.contains(w));
                    if s.epoch == reader_epoch
                        && (line.contains("ignoring device='npu'") || lower.contains("fallback to cpu") || lower.contains("device: cpu"))
                    {
                        let newly = !s.hw_verification.cpu_fallback_detected;
                        s.hw_verification.cpu_fallback_detected = true;
                        s.hw_verification.verified_npu = false;
                        s.hw_verification.execution_target = "CPU Fallback (Warning)".to_string();
                        s.hw_verification.last_telemetry_log = Some(line.clone());
                        if newly {
                            s.append_log(
                                "[supervisor] GenieX is running on the CPU although the NPU was requested — this is a fallback the runtime made on its own, not a choice. MKMN never switches compute silently: the NPU is always the default target, and hybrid CPU+GPU execution only runs when it is explicitly selected in Settings.".to_string(),
                            );
                        }
                    } else if !looks_like_error && !s.hw_verification.cpu_fallback_detected && s.epoch == reader_epoch
                        && (line.contains("HTP") || line.contains("Hexagon NPU") || line.contains("qairt") || line.contains("device: HTP"))
                    {
                        s.hw_verification.verified_npu = true;
                        s.hw_verification.execution_target = "Hexagon NPU (HTP)".to_string();
                        s.hw_verification.last_telemetry_log = Some(line.clone());
                    }
                    s.append_log(format!("[geniex stdout] {}", line));
                }
            })
        });

        let stderr_reader = stderr.map(|err| {
            let sc = state_clone.clone();
            let reader_epoch = spawn_epoch;
            tokio::spawn(async move {
                let mut reader = BufReader::new(err).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let mut s = sc.write().await;
                    s.capture_warmup_error(reader_epoch, &line);
                    // Same precedence as the stdout reader: the fallback check wins,
                    // even when the line also advertises HTP.
                    let lower = line.to_lowercase();
                    let looks_like_error = ["error", "warn", "fail", "unknown", "unrecognized", "no such", "invalid"]
                        .iter().any(|w| lower.contains(w));
                    if s.epoch == reader_epoch
                        && (line.contains("ignoring device='npu'") || lower.contains("fallback to cpu") || lower.contains("device: cpu"))
                    {
                        let newly = !s.hw_verification.cpu_fallback_detected;
                        s.hw_verification.cpu_fallback_detected = true;
                        s.hw_verification.verified_npu = false;
                        s.hw_verification.execution_target = "CPU Fallback (Warning)".to_string();
                        s.hw_verification.last_telemetry_log = Some(line.clone());
                        if newly {
                            s.append_log(
                                "[supervisor] GenieX is running on the CPU although the NPU was requested — this is a fallback the runtime made on its own, not a choice. MKMN never switches compute silently: the NPU is always the default target, and hybrid CPU+GPU execution only runs when it is explicitly selected in Settings.".to_string(),
                            );
                        }
                    } else if !looks_like_error && !s.hw_verification.cpu_fallback_detected && s.epoch == reader_epoch
                        && (line.contains("HTP") || line.contains("Hexagon NPU"))
                    {
                        s.hw_verification.verified_npu = true;
                        s.hw_verification.execution_target = "Hexagon NPU (HTP)".to_string();
                        s.hw_verification.last_telemetry_log = Some(line.clone());
                    }
                    s.append_log(format!("[geniex stderr] {}", line));
                }
            })
        });

        // Readiness probe loop: Poll http://127.0.0.1:<port>/v1/models every 500ms
        let probe_url = format!("http://127.0.0.1:{}/v1/models", port);
        let start_time = Instant::now();
        let deadline = Duration::from_secs(timeout_sec);
        let mut is_ready = false;
        let mut premature_exit = false;
        let mut premature_status = String::new();
        let mut failure_kind = StartFailureKind::Unknown;
        let mut readiness = ReadinessTracker::default();

        while start_time.elapsed() < deadline {
            tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;

            // Check if the process exited early, or if a concurrent stop tore this
            // startup down (stop takes the child and bumps the epoch).
            let mut exited = false;
            {
                let mut state = self.inner.write().await;
                if state.epoch != spawn_epoch || state.child.is_none() {
                    return Err("Server was stopped during startup".to_string());
                }
                if let Some(ref mut ch) = state.child
                    && let Ok(Some(status)) = ch.try_wait() {
                        exited = true;
                        premature_exit = true;
                        premature_status = format!("{}", status);
                        // Classify from the CHILD's own output: a held port and a CLI
                        // usage error are definitive, and neither is memory pressure.
                        let logs: Vec<String> = state.logs.iter().cloned().collect();
                        failure_kind = classify_start_failure(&logs);
                        let owner = if failure_kind == StartFailureKind::PortConflict {
                            tcp_listener_owner(port)
                        } else {
                            None
                        };
                        let err_msg =
                            start_failure_message(failure_kind, port, &premature_status, owner.as_ref());
                        state.set_state(ServerLifecycleState::Failed);
                        state.last_error = Some(err_msg.clone());
                        state.append_log(format!("[supervisor] {}", err_msg));
                    }
            }
            if exited {
                break;
            }

            match self.client.get(&probe_url).send().await {
                Err(e) => { readiness.observe_unreachable(e.to_string()); }
                Ok(resp) if !resp.status().is_success() => { readiness.observe_unreachable(format!("HTTP {}", resp.status())); }
                Ok(resp) => {
                    // A 200 with an EMPTY model list is not ready: that is what a serve
                    // with a bad data dir looks like, and every later completion would
                    // fail with 400. And a populated list is still not evidence that the
                    // REQUESTED model loaded (`--model` is only the default): the probe
                    // must see the requested identity among the served models.
                    if let Ok(body) = resp.json::<serde_json::Value>().await {
                        let ids: Vec<String> = body
                            .get("data")
                            .and_then(|d| d.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                                    .map(|s| s.trim().to_lowercase())
                                    .collect()
                            })
                            .unwrap_or_default();
                        let verdict = readiness.observe_list(&ids, model_ref.as_deref());
                        if verdict == ReadinessVerdict::NotListed {
                            // GenieX lists its cache: a build it does not hold now will not appear by waiting
                            failure_kind = StartFailureKind::ModelNotListed;
                            break;
                        }
                        if verdict == ReadinessVerdict::Ready {
                            // The requested identity is served: the load has actually
                            // begun. "loading" separates this proven step from the
                            // earlier "starting" (spawned, nothing verified yet).
                            let mut state = self.inner.write().await;
                            if state.epoch == spawn_epoch && state.state == ServerLifecycleState::Starting {
                                state.set_state(ServerLifecycleState::Loading);
                                state.append_log(format!(
                                    "[supervisor] Requested model {} is served; warming up.",
                                    model_ref.clone().unwrap_or_default()
                                ));
                            }
                            is_ready = true;
                            break;
                        }
                    } else {
                        readiness.observe_unreachable("the model list could not be read".to_string());
                    }
                }
            }
        }

        // Graceful OOM recovery: a genuine allocation failure (or a load that failed
        // for no identifiable reason, e.g. a readiness timeout) may retry once with a
        // smaller context. A PORT CONFLICT and a CLI usage error must not: retrying
        // cannot fix them, and the retry must not be reported as memory pressure.
        if (!is_ready || premature_exit)
            && !is_retry
            && !is_qairt
            && should_attempt_context_fallback(failure_kind)
        {
            let cur_nctx = req.nctx.unwrap_or(4096);
            if cur_nctx > 2048 {
                // A concurrent stop wins: never respawn the runtime behind a user's
                // stop, even when an automatic fallback retry would be due.
                {
                    let state = self.inner.read().await;
                    if state.epoch != spawn_epoch {
                        return Err("Server was stopped during startup".to_string());
                    }
                }
                {
                    let mut state = self.inner.write().await;
                    let reason = match failure_kind {
                        StartFailureKind::MemoryPressure => "Memory allocation failed",
                        _ => "The runtime reported a context size it cannot hold",
                    };
                    state.append_log(format!(
                        "[supervisor] {} ({}). Retrying once with a smaller context (nctx=2048)...",
                        reason,
                        load_status_detail(&premature_status, model_ref.as_deref())
                    ));
                }
                let mut fallback_req = req.clone();
                fallback_req.nctx = Some(2048);
                fallback_req.kv_type = kv_type_supported_req.map(|_| "q4_0".to_string());
                return Box::pin(self.start_internal(fallback_req, true, generation)).await;
            }
        }

        if !is_ready {
            let mut state = self.inner.write().await;
            if state.epoch != spawn_epoch { return Err("Server was stopped during startup".into()); }
            Self::terminate_child(&mut state).await?;
            state.set_state(ServerLifecycleState::Failed);
            // A premature exit already has its classified, honest reason (a port
            // conflict, a usage error, ...): keep it. Overwriting it with a generic
            // readiness timeout is exactly how a held port was reported as a timeout.
            let err = if premature_exit {
                state.last_error.clone().unwrap_or_else(|| {
                    start_failure_message(failure_kind, port, &premature_status, tcp_listener_owner(port).as_ref())
                })
            } else {
                let msg = readiness.failure_message(model_ref.as_deref(), &probe_url, timeout_sec);
                state.last_error = Some(msg.clone());
                state.append_log(format!("[supervisor] {}", msg));
                msg
            };
            return Err(err);
        }

        // Zero-Latency NPU Warm-Up Ping: Force graph compilation and NPU memory residency during pre-flight.
        // A warm-up that fails (HTTP error, network refusal, or the process dying under
        // the load) means the model is NOT ready to answer: say so instead of marking ready.
        //
        // Measured hardware verification: while the warm-up generates, the NPU's PDH
        // counters (compute-only adapter detection, see monitor.rs::PdhGpuSampler) are
        // sampled in a blocking thread. The old string match on the child's output said
        // "HTP Verified: false" whenever geniex's logs never name HTP — which measurably
        // running on the NPU does not fix — and "true" from any line that mentions it.
        // Utilization cannot lie that way. Sixteen tokens instead of one give the rate
        // counter a window to catch (~0.3 s of engine time), still well under a second.
        let wants_npu = compute == "npu" || compute == "hybrid";
        if let Some(ref m) = model_ref {
            let child_pid = {
                let state = self.inner.read().await;
                state.child.as_ref().and_then(|c| c.id())
            };
            let warm = run_warmup_probe(&self.client, port, m, child_pid, wants_npu).await;
            match warm {
                WarmupOutcome::Ok { npu_peak, generated } => {
                    // The child must still be alive after the warm-up: a crash under the
                    // first real request is a failed startup, not a ready server.
                    {
                        let mut state = self.inner.write().await;
                        if state.epoch != spawn_epoch || state.child.is_none() {
                            return Err("Server was stopped during startup".to_string());
                        }
                        if let Some(ref mut ch) = state.child
                            && let Ok(Some(status)) = ch.try_wait() {
                                let err = format!("GenieX exited during warm-up with status: {}", status);
                                state.child = None;
                                state.set_state(ServerLifecycleState::Failed);
                                state.last_error = Some(err.clone());
                                state.append_log(format!("[supervisor] {}", err));
                                return Err(err);
                            }
                    }
                    // The sampler has stopped by now: the warm-up answer arrived (or
                    // failed and returned above). A measured peak over the noise floor
                    // proves HTP execution regardless of what the logs say; no
                    // measurement (None or 0.0 = no counter, or the request was too
                    // short to catch) leaves the verdict unverified, and the log says
                    // what is and is not proven.
                    let measured_peak = npu_peak.unwrap_or(0.0);
                    let mut state = self.inner.write().await;
                    if state.epoch == spawn_epoch && state.child.is_some() {
                        if let Some(key) = &warmup_key {
                            state.warmup_failures.clear(key);
                            if generated && is_qairt && compute == "npu" && !state.hw_verification.cpu_fallback_detected
                                && let Some(build) = &build {
                                state.verified_npu_bundles.insert(m.to_owned(), (runtime_key.clone(), build.clone()));
                            }
                        }
                        if measured_peak >= 2.0 {
                            if !state.hw_verification.verified_npu {
                                state.append_log(format!(
                                    "[supervisor] NPU execution measured, not just claimed: this GenieX process used the Hexagon NPU during the warm-up (PDH utilization peaked at {:.0}%).",
                                    measured_peak
                                ));
                            }
                            state.hw_verification.verified_npu = true;
                            state.hw_verification.execution_target = "Hexagon NPU (HTP, measured)".to_string();
                            state.hw_verification.last_telemetry_log = Some(format!("PDH NPU utilization of the server process peaked at {:.0}% during warm-up", measured_peak));
                        } else if !state.hw_verification.verified_npu {
                            state.append_log(format!(
                                "[supervisor] NPU load was not measurable during the warm-up (peak {:.0}%). The execution target stays unverified until the live counters show load.",
                                measured_peak
                            ));
                        }
                    }
                }
                WarmupOutcome::Rejected { status, body } => {
                    let mut state = self.inner.write().await;
                    if state.epoch != spawn_epoch || state.child.is_none() {
                        return Err("Server was stopped during startup".to_string());
                    }
                    Self::terminate_child(&mut state).await?;
                    drop(state);
                    let _ = tokio::time::timeout(Duration::from_millis(500), async {
                        for reader in [stdout_reader, stderr_reader].into_iter().flatten() {
                            let _ = reader.await;
                        }
                    }).await;
                    let mut state = self.inner.write().await;
                    if state.epoch != spawn_epoch {
                        return Err("Server was stopped during startup".to_string());
                    }
                    state.set_state(ServerLifecycleState::Failed);
                    state.pid = None;
                    // A native bundle with no
                    // metadata.json (made for an older GenieX) is named from the files themselves
                    let old_bundle = model_ref
                        .as_deref()
                        .is_some_and(crate::memory_estimator::qairt_bundle_lacks_metadata);
                    let mut err = format!(
                        "The model did not answer its warm-up request (HTTP {}): {}{}",
                        status,
                        body,
                        if old_bundle { " (cannot read metadata.json: the model's package lacks the metadata this GenieX needs)" } else { "" }
                    );
                    if is_model_load_rejection(&body) {
                        err = format!("GenieX failed to load {m}\nBuild: {}\nRuntime: {runtime_details}\nRequested compute: {compute}\n{err}",
                            build.as_deref().unwrap_or(m));
                        let diagnostic = state.warmup_diagnostic();
                        if !diagnostic.is_empty() {
                            err.push('\n');
                            err.push_str(&diagnostic);
                        }
                        // "Model loading failed" says nothing; a GenieX install missing its NPU
                        // files is named, with the fix (qairt_runtime::install_gaps).
                        let gaps = crate::qairt_runtime::install_gaps(&exe_path, is_qairt, &compute,
                            req.qairt_lib.as_deref().is_some_and(|l| !l.trim().is_empty()));
                        if let Some(note) = crate::qairt_runtime::install_gaps_note(&gaps) {
                            err.push('\n');
                            err.push_str(&note);
                        }
                        if let (Some(key), Some(build)) = (&warmup_key, &build) {
                            state.verified_npu_bundles.retain(|_, (_, verified)| verified != build);
                            state.warmup_failures.record(key, err.clone());
                            err = warmup_recovery_details(&state, &err, &runtime_key, build,
                                state.warmup_failures.blocked(key, false).is_some());
                        }
                    }
                    state.last_error = Some(err.clone());
                    state.append_log(format!("[supervisor] {}", err));
                    return Err(err);
                }
                WarmupOutcome::Unreachable(e) => {
                    let mut state = self.inner.write().await;
                    if state.epoch != spawn_epoch || state.child.is_none() {
                        return Err("Server was stopped during startup".to_string());
                    }
                    Self::terminate_child(&mut state).await?;
                    state.set_state(ServerLifecycleState::Failed);
                    let err = format!("The model server stopped answering during warm-up: {}", e);
                    state.last_error = Some(err.clone());
                    state.append_log(format!("[supervisor] {}", err));
                    return Err(err);
                }
            }
        }

        {
            let mut state = self.inner.write().await;
            if state.epoch != spawn_epoch || state.child.is_none() {
                // A stop won the race: do not resurrect the server as "ready".
                return Err("Server was stopped during startup".to_string());
            }
            state.set_state(ServerLifecycleState::Ready);
            let verified = state.hw_verification.verified_npu;
            let target = state.hw_verification.execution_target.clone();
            state.append_log(format!(
                "[supervisor] GenieX is ready on http://127.0.0.1:{} (HTP Verified: {}{})",
                port,
                verified,
                if verified { format!(" — {}", target) } else { String::new() }
            ));
        }

        // Post-ready supervision: a geniex.exe that dies AFTER ready (crash, OOM kill,
        // idle unload) must not leave a stale "ready" status and a dead PID behind.
        // The watcher owns the child's exit for the ready epoch it was spawned under.
        {
            let watcher_state = self.inner.clone();
            let watcher_notify = self.startup_notify.clone();
            let status_url = format!("http://127.0.0.1:{}/status", port);
            tokio::spawn(async move {
                let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().unwrap_or_default();
                let mut tick: u32 = 0;
                loop {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    tick = tick.wrapping_add(1);
                    let mut exited = false;
                    let mut exit_code: Option<i32> = None;
                    {
                        let s = watcher_state.read().await;
                        if s.epoch != spawn_epoch {
                            return; // replaced by another start
                        }
                        match s.state {
                            // a reply is being written: the model is in memory, nothing to check until it ends
                            ServerLifecycleState::Busy => continue,
                            ServerLifecycleState::Ready => {}
                            _ => return, // already stopped, failed or unloaded
                        }
                    }
                    // every 15 s: did GenieX release the model while it kept running (its own idle timeout)?
                    if tick.is_multiple_of(5) {
                        let answer = client.get(&status_url).send().await.ok();
                        let body = match answer {
                            Some(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
                            _ => None,
                        };
                        if let Some(body) = body {
                            let mut s = watcher_state.write().await;
                            if s.epoch == spawn_epoch && s.state == ServerLifecycleState::Ready
                                && runtime_released_model(&body, s.current_model.as_deref())
                            {
                                s.set_state(ServerLifecycleState::Unloaded);
                                s.hw_verification = HardwareVerification::default();
                                s.append_log(
                                    "[supervisor] GenieX released the model after its idle timeout and kept running: the model is unloaded and reloads on the next start (a warm-up while typing included).".to_string(),
                                );
                                watcher_notify.notify_waiters();
                                return;
                            }
                        }
                    }
                    {
                        let mut s = watcher_state.write().await;
                        if s.epoch != spawn_epoch || s.state != ServerLifecycleState::Ready {
                            if s.state == ServerLifecycleState::Busy && s.epoch == spawn_epoch { continue; }
                            return; // replaced by another start, or already stopped/failed
                        }
                        match s.child.as_mut() {
                            Some(ch) => {
                                if let Ok(Some(status)) = ch.try_wait() {
                                    exited = true;
                                    exit_code = status.code();
                                }
                            }
                            None => exited = true,
                        }
                    }
                    if exited {
                        let mut s = watcher_state.write().await;
                        if s.epoch != spawn_epoch || s.state != ServerLifecycleState::Ready {
                            return;
                        }
                        s.child = None;
                        s.pid = None;
                        s.hw_verification = HardwareVerification::default();
                        // A clean exit (code 0) while ready is the runtime's own idle
                        // unload (`--keepalive` elapsed): the model is GONE, but that is
                        // not a failure — the next start simply reloads it. A crash gets
                        // the failed state and its reason.
                        if exit_code == Some(0) {
                            s.set_state(ServerLifecycleState::Unloaded);
                            s.last_error = None;
                            s.append_log(
                                "[supervisor] GenieX exited cleanly after its idle timeout: the model is unloaded and reloads on the next request.".to_string(),
                            );
                        } else {
                            s.set_state(ServerLifecycleState::Failed);
                            s.last_error = Some(format!(
                                "The GenieX runtime exited unexpectedly after it was ready (exit code: {}).",
                                exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())
                            ));
                            s.append_log(format!(
                                "[supervisor] GenieX process exited after ready with code {:?}; status reset to failed.",
                                exit_code
                            ));
                        }
                        watcher_notify.notify_waiters();
                        return;
                    }
                }
            });
        }

        Ok(self.get_status().await)
    }
}

impl Default for GenieXSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

/// True when GenieX's `/status` shows that the runtime itself released our model. GenieX 0.11.0 releases an idle
/// model (`--keepalive`) WITHOUT exiting: the process keeps serving and `/status` lists no model, so the exit watcher
/// never saw it and MKMN kept saying "ready" (seen on an installed build). A status with no model list (an older
/// GenieX) or no model of ours to compare says nothing and is never read as a release.
pub(crate) fn runtime_released_model(status: &serde_json::Value, model: Option<&str>) -> bool {
    let (Some(models), Some(model)) = (status.get("models").and_then(|m| m.as_array()), model) else {
        return false;
    };
    let ids: Vec<String> = models
        .iter()
        .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
        .map(|s| s.trim().to_lowercase())
        .collect();
    !requested_model_listed(&ids, Some(model))
}

/// True when the path names a file called geniex.exe (any case): the only program an
/// override path may name.
fn is_geniex_exe(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("geniex.exe"))
        .unwrap_or(false)
}

/// Whether a server being released was adopted (started outside MKMN). Read from the adoption flag, never
/// guessed from "a pid but no child": a failed start that had already killed its own child left its pid,
/// and the log then called MKMN's own server one "started outside MKMN".
fn released_server_was_adopted(owned: bool, adopted_flag: bool) -> bool {
    !owned && adopted_flag
}

/// What a load that did not complete looked like: the exit status of a server that died, or, when it kept
/// running, that it never listed the requested model (an empty status read "(status: )").
fn load_status_detail(premature_status: &str, model: Option<&str>) -> String {
    if premature_status.is_empty() {
        format!("the server kept running but never listed {} before the startup timeout", model.unwrap_or("the requested model"))
    } else {
        format!("the server exited: {}", premature_status)
    }
}

/// An application model id, never a GenieX cache name. A cache name has its namespace before any colon
/// ("org/model:Q4_0", "qualcomm/Qwen3-4B"); an app id has its colon first ("custom:…", "dynamic:9B",
/// "installed:…"). Read from the shape, not a list of prefixes: a list missed "installed:".
pub(crate) fn is_app_model_id(model: &str) -> bool {
    match model.find(':') {
        Some(colon) => !model[..colon].contains('/'),
        None => false,
    }
}

/// A GenieX cache name carries its namespace ("org/model", "org/model:Q4_0"); an alias without one is not GenieX's.
pub(crate) fn is_cache_shaped(model: &str) -> bool {
    model.contains('/')
}

#[cfg(test)]
mod cache_shape_tests {
    #[test]
    fn a_foundry_alias_is_refused_at_once() {
        assert!(!super::is_cache_shaped("deepseek-r1-7b"));
        assert!(super::is_cache_shaped("qualcomm/Qwen3-8B"));
        assert!(super::is_cache_shaped("bartowski/Qwen_Qwen3-8B-GGUF:Q4_0"));
    }
}

#[cfg(test)]
mod app_model_id_tests {
    use super::is_app_model_id;
    #[test]
    fn any_app_id_is_refused_whatever_its_prefix() {
        for id in ["custom:org/m:q4_0", "dynamic:9B", "installed:ggml-org/gemma-4-12b-it-gguf:q4_0", "foundry:phi-4-mini", "humain:chat", "anything-new:org/m"] {
            assert!(is_app_model_id(id), "{id}");
        }
    }
    #[test]
    fn a_cache_name_passes() {
        for name in ["ggml-org/gemma-4-12B-it-GGUF:Q4_0", "qualcomm/Qwen3-4B", "unsloth/Qwen3-0.6B-GGUF", "bartowski/Qwen_Qwen3-8B-GGUF:Q4_0"] {
            assert!(!is_app_model_id(name), "{name}");
        }
    }
}

#[cfg(test)]
mod warmup_timeout_tests {
    #[test]
    fn a_large_model_has_time_for_its_first_answer() {
        // measured: 56 to 97 s for an 8 GB vision model's first answer after its load
        assert!(super::WARMUP_TIMEOUT >= std::time::Duration::from_secs(120));
    }
}

#[cfg(test)]
mod adopted_release_tests {
    #[test]
    fn our_own_server_is_never_called_adopted() {
        // a failed start killed its child and left the pid: not adopted, it was ours
        assert!(!super::released_server_was_adopted(false, false));
        assert!(super::released_server_was_adopted(false, true));
        assert!(!super::released_server_was_adopted(true, false));
    }
}

#[cfg(test)]
mod load_status_tests {
    #[test]
    fn a_load_that_never_listed_its_model_says_so() {
        let d = super::load_status_detail("", Some("org/model:Q4_0"));
        assert!(d.contains("never listed org/model:Q4_0"), "{d}");
        assert!(super::load_status_detail("exit code: 3", None).contains("exited: exit code: 3"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idv(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_lowercase()).collect() }

    /// Seen on an installed build: GenieX 0.11.0 released the idle qualcomm/Qwen3-4B at 12:38:13 but kept running
    /// (`/status` answered `"models":[]`), so MKMN said "ready" and "Warm up model while typing" skipped the load.
    #[test]
    fn a_model_the_runtime_released_is_read_from_its_status() {
        let released = serde_json::json!({"alive": true, "version": "v0.11.0", "keepalive_seconds": 900, "models": []});
        let loaded = serde_json::json!({"alive": true, "models": [{"id": "qualcomm/Qwen3-4B", "runtime": "qairt", "device": "NPU", "state": "idle"}]});
        let gguf = serde_json::json!({"models": [{"id": "unsloth/Qwen3-0.6B-GGUF:Q4_0", "state": "active"}]});
        assert!(runtime_released_model(&released, Some("qualcomm/Qwen3-4B")));
        assert!(!runtime_released_model(&loaded, Some("qualcomm/Qwen3-4B")));
        assert!(!runtime_released_model(&loaded, Some("qualcomm/Qwen3-4B:W4A16")), "the precision the listing omits");
        assert!(!runtime_released_model(&gguf, Some("unsloth/Qwen3-0.6B-GGUF:Q4_0")));
        assert!(runtime_released_model(&gguf, Some("qualcomm/Qwen3-4B")), "another model in memory is not ours");
        // an older GenieX with no model list in /status says nothing: never read as a release
        assert!(!runtime_released_model(&serde_json::json!({"alive": true}), Some("qualcomm/Qwen3-4B")));
        assert!(!runtime_released_model(&serde_json::json!({"models": []}), None));
    }

    /// Observed: GenieX answered HTTP 200 on /v1/models every 0.5 s for 90 s, but its list (read from its
    /// model cache) no longer held ggml-org/gemma-4-12B-it-GGUF:Q4_0: the folder had been removed during the previous
    /// load. The list is GenieX's cache, so the answer cannot change by waiting: a few identical answers settle it.
    #[test]
    fn a_list_without_the_requested_model_fails_at_once_and_names_both_sides() {
        let wanted = Some("ggml-org/gemma-4-12B-it-GGUF:Q4_0");
        let returned = idv(&["bartowski/Qwen_Qwen3-8B-GGUF:Q4_0", "ggml-org/Qwen3.6-27B-GGUF:Q4_K_M", "ggml-org/gemma-4-12B-it-GGUF:Q8_0", "unsloth/Qwen3-0.6B-GGUF:Q4_0"]);
        let mut t = ReadinessTracker::default();
        let mut verdicts = Vec::new();
        for _ in 0..MISSING_CONFIRM_PROBES {
            verdicts.push(t.observe_list(&returned, wanted));
        }
        assert!(verdicts[..verdicts.len() - 1].iter().all(|v| *v == ReadinessVerdict::Wait), "{verdicts:?}");
        assert_eq!(*verdicts.last().unwrap(), ReadinessVerdict::NotListed);
        let msg = t.failure_message(wanted, "http://127.0.0.1:18181/v1/models", 90);
        assert!(msg.contains("ggml-org/gemma-4-12B-it-GGUF:Q4_0"), "{msg}");
        assert!(msg.contains("unsloth/qwen3-0.6b-gguf:q4_0"), "every returned id is named: {msg}");
        // the same model in another quantization is pointed out, never accepted (exact builds only)
        assert!(msg.contains("other precision: ggml-org/gemma-4-12b-it-gguf:q8_0"), "{msg}");
        assert!(!requested_model_listed(&returned, wanted));
        assert!(!msg.contains("failed to respond"), "a server that answered is not unreachable: {msg}");
    }

    #[test]
    fn the_requested_model_listed_is_ready_and_a_missing_streak_restarts() {
        let wanted = Some("org/model:Q4_0");
        let mut t = ReadinessTracker::default();
        assert_eq!(t.observe_list(&idv(&["other/model"]), wanted), ReadinessVerdict::Wait);
        assert_eq!(t.observe_unreachable("connection refused".into()), ReadinessVerdict::Wait);
        // the streak counts only consecutive answers: the refusal above broke it
        for _ in 0..MISSING_CONFIRM_PROBES - 1 {
            assert_eq!(t.observe_list(&idv(&["other/model"]), wanted), ReadinessVerdict::Wait);
        }
        assert_eq!(t.observe_list(&idv(&["org/model:q4_0"]), wanted), ReadinessVerdict::Ready);
    }

    #[test]
    fn unreachable_and_empty_lists_are_named_apart() {
        let wanted = Some("org/model:Q4_0");
        let mut down = ReadinessTracker::default();
        down.observe_unreachable("error sending request: connection refused".into());
        let m = down.failure_message(wanted, "http://127.0.0.1:18181/v1/models", 90);
        assert!(m.starts_with("GenieX failed to respond to readiness check at http://127.0.0.1:18181/v1/models within 90s"), "{m}");
        assert!(m.contains("connection refused") && m.contains("org/model:Q4_0"), "{m}");
        let mut empty = ReadinessTracker::default();
        for _ in 0..3 { assert_eq!(empty.observe_list(&[], wanted), ReadinessVerdict::Wait); }
        let m = empty.failure_message(wanted, "http://127.0.0.1:18181/v1/models", 90);
        assert!(m.contains("empty model list") && m.contains("org/model:Q4_0"), "{m}");
        assert_eq!(classify_load_error(&m).id, "timeout");
        let mut missing = ReadinessTracker::default();
        for _ in 0..MISSING_CONFIRM_PROBES { missing.observe_list(&idv(&["a/b"]), wanted); }
        assert_eq!(classify_load_error(&missing.failure_message(wanted, "u", 90)).id, "model-not-listed");
    }

    /// The smaller-context retry is for a runtime that SAID memory or context: a load with no cause (a timeout,
    /// a crash, a missing model) is reported, never re-run silently at another size.
    #[test]
    fn only_a_reported_memory_or_context_problem_retries_smaller() {
        assert!(should_attempt_context_fallback(StartFailureKind::MemoryPressure));
        assert!(should_attempt_context_fallback(StartFailureKind::ContextSize));
        assert!(!should_attempt_context_fallback(StartFailureKind::Unknown));
        assert!(!should_attempt_context_fallback(StartFailureKind::ModelNotListed));
        let ctx = vec!["[geniex stderr] llama_init_from_model: n_ctx_per_seq (8192) exceeds the context the model was trained with".to_string()];
        assert_eq!(classify_start_failure(&ctx), StartFailureKind::ContextSize);
        let kv = vec!["[geniex stderr] failed to create the KV cache: context too large".to_string()];
        assert_eq!(classify_start_failure(&kv), StartFailureKind::ContextSize);
    }

    #[test]
    fn an_override_path_must_name_geniex_exe() {
        assert!(is_geniex_exe(Path::new(r"C:\Tools\GenieX CLI\geniex.exe")));
        assert!(is_geniex_exe(Path::new(r"C:\Tools\GENIEX.EXE")));
        assert!(!is_geniex_exe(Path::new(r"C:\Users\x\Downloads\payload.exe")));
        assert!(!is_geniex_exe(Path::new(r"C:\Windows\System32\cmd.exe")));
        assert!(!is_geniex_exe(Path::new(r"C:\Tools\geniex.exe.bat")));
        // an existing program that is not geniex.exe is never resolved from an override
        let other = std::env::current_exe().unwrap();
        assert_ne!(GenieXSupervisor::find_geniex(other.to_str()), Some(other));
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn load_errors_are_classified_into_what_the_user_can_act_on() {
        // Each category must be hit by the raw text the failing path actually emits.
        let cases: &[(&str, &str)] = &[
            ("SDKError(File not found or inaccessible), model 'custom:x' not found in local cache", "missing-artifact"),
            ("GenieX rejected the serve command line (unknown flag); status: exit code 101", "unsupported-capability"),
            ("Pre-flight RAM check failed: model requires 6.20 GB, but only 2.00 GB available.", "insufficient-memory"),
            ("GenieX failed to respond to readiness check at http://127.0.0.1:18181/v1/models within 90s", "timeout"),
            ("GenieX exited prematurely with status: exit code 3221225786", "runtime-crash"),
            ("'custom:x' is an application model id, not a cache name: it was not resolved to an installed model. Pick the model again in Models.", "model-resolution"),
            ("geniex.exe not found on system. Please verify GenieX CLI installation.", "runtime-missing"),
            ("Port 18181 is already in use by geniex.exe (PID 19348). Another GenieX or MKMN server is holding it; MKMN did not stop that process. Close it (or the other MKMN instance), or choose a different port in Settings, then retry. GenieX could not bind to it (exit code: 0).", "port-conflict"),
            ("something entirely unclassifiable", "server"),
        ];
        for (raw, want_id) in cases {
            let e = classify_load_error(raw);
            assert_eq!(e.id, *want_id, "raw: {}", raw);
            assert!(!e.title.is_empty());
            assert!(!e.fix.is_empty());
            // The raw reason is ALWAYS kept: support and logs need the exact text.
            assert_eq!(e.raw, *raw);
        }
    }

    #[test]
    fn a_held_port_is_a_bind_conflict_and_never_memory_pressure() {
        // The EXACT line the production geniex printed when the port was already held
        // (geniex.log): it must classify as a port conflict, not an allocation failure.
        let bind_line = "[geniex stdout] HTTP/HTTPS Server Error: listen tcp 127.0.0.1:18181: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.";
        assert!(is_bind_conflict_line(bind_line));
        assert!(!is_memory_pressure_line(bind_line));
        let logs = vec![
            "[geniex stdout] Local hosting on http://127.0.0.1:18181/".to_string(),
            bind_line.to_string(),
            // A leftover supervisor narration line must NOT be able to re-label it: the
            // old fallback wrote exactly this, and it was the source of the misreport.
            "[supervisor] Memory pressure / allocation failure detected (status: exit code: 0). Auto-recovering with safe fallback (nctx=2048)...".to_string(),
        ];
        assert_eq!(classify_start_failure(&logs), StartFailureKind::PortConflict);
        // The definitive cause must never be retried with a smaller context.
        assert!(!should_attempt_context_fallback(StartFailureKind::PortConflict));
    }

    #[test]
    fn bind_conflict_outranks_an_unrelated_memory_line_from_the_child() {
        // Even if the child itself printed an allocation error, a later/earlier bind
        // conflict is the real reason a second server cannot start.
        let logs = vec![
            "[geniex stderr] failed to allocate 4096 bytes".to_string(),
            "[geniex stdout] listen tcp 127.0.0.1:18181: bind: Only one usage of each socket address".to_string(),
        ];
        assert_eq!(classify_start_failure(&logs), StartFailureKind::PortConflict);
    }

    #[test]
    fn a_real_allocation_failure_is_memory_pressure_and_may_retry() {
        let logs = vec!["[geniex stderr] ggml_backend_alloc: failed to allocate 8192 bytes".to_string()];
        assert!(is_memory_pressure_line(&logs[0]));
        assert_eq!(classify_start_failure(&logs), StartFailureKind::MemoryPressure);
        assert!(should_attempt_context_fallback(StartFailureKind::MemoryPressure));
    }

    #[test]
    fn oom_is_matched_as_a_word_not_a_substring() {
        // A model id containing "oom" must not read as out-of-memory.
        assert!(!is_memory_pressure_line("[geniex stdout] loading boomerang/zoomroom-model"));
        assert!(is_memory_pressure_line("[geniex stderr] fatal: OOM"));
    }

    #[test]
    fn an_unknown_flag_is_its_own_failure_and_is_not_retried() {
        let logs = vec!["[geniex stderr] error: unknown flag --kv-type".to_string()];
        assert!(is_unknown_flag_line(&logs[0]));
        assert_eq!(classify_start_failure(&logs), StartFailureKind::UnknownFlag);
        assert!(!should_attempt_context_fallback(StartFailureKind::UnknownFlag));
    }

    #[test]
    fn an_unidentifiable_failure_stays_unknown_and_is_not_retried_smaller() {
        assert_eq!(classify_start_failure(&[]), StartFailureKind::Unknown);
        assert_eq!(
            classify_start_failure(&["[geniex stdout] hello".to_string()]),
            StartFailureKind::Unknown
        );
        // A timeout has no exit and no child line: it is reported, and the person retries
        // explicitly (the silent smaller-context retry doubled a 90 s wait for nothing).
        assert!(!should_attempt_context_fallback(StartFailureKind::Unknown));
    }

    #[test]
    fn the_port_conflict_message_names_the_owner_and_says_it_was_not_stopped() {
        let owner = PortOwner {
            pid: 4242,
            image: Some("C:\\Users\\x\\AppData\\Local\\GenieX CLI\\geniex.exe".to_string()),
        };
        let msg = port_conflict_message(18181, Some(&owner));
        assert!(msg.contains("18181"), "{msg}");
        assert!(msg.contains("geniex.exe"), "{msg}");
        assert!(msg.contains("4242"), "{msg}");
        assert!(msg.contains("did not stop"), "{msg}");
        // The classified message is what the user reads: it must be a port conflict.
        assert_eq!(classify_load_error(&msg).id, "port-conflict");

        // An unreadable owner still names the port and states MKMN did not stop it.
        let unknown = port_conflict_message(18181, None);
        assert!(unknown.contains("18181"));
        assert!(unknown.contains("did not stop"));
        assert_eq!(classify_load_error(&unknown).id, "port-conflict");
    }

    #[test]
    fn start_failure_messages_keep_the_classified_cause() {
        let owner = PortOwner {
            pid: 7,
            image: Some("geniex.exe".to_string()),
        };
        let port = start_failure_message(StartFailureKind::PortConflict, 18181, "exit code: 0", Some(&owner));
        assert_eq!(classify_load_error(&port).id, "port-conflict");
        let flag = start_failure_message(StartFailureKind::UnknownFlag, 18181, "exit code: 101", None);
        assert_eq!(classify_load_error(&flag).id, "unsupported-capability");
        let mem = start_failure_message(StartFailureKind::MemoryPressure, 18181, "exit code: 1", None);
        assert_eq!(classify_load_error(&mem).id, "insufficient-memory");
    }

    #[test]
    fn the_tcp_owner_lookup_finds_the_process_listening_on_a_port() {
        // Deterministic, no live server: bind an ephemeral loopback port and confirm
        // the real Win32 lookup attributes it to THIS process, then that closing it
        // removes it. This exercises the exact code the pre-flight port probe uses.
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        let owner = tcp_listener_owner(port).expect("the listener must be found in the TCP table");
        assert_eq!(owner.pid, me, "the listener must be attributed to this process");
        if let Some(ref image) = owner.image {
            assert!(image.to_lowercase().contains(".exe"), "image path: {image}");
        }
        drop(listener);
        // The closed listener must disappear from the table. The OS updates the table
        // synchronously, but allow a short bounded grace period so the assertion cannot
        // be flaky on a loaded machine.
        let gone = (0..50).any(|_| {
            if tcp_listener_owner(port).is_none() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
            false
        });
        assert!(gone, "a closed listener must not be reported as an owner");
    }

    #[tokio::test]
    async fn a_held_port_is_reported_as_a_conflict_without_spawning_a_server() {
        // End-to-end pre-flight path: a real listener holds the port, so `start` must
        // report a named conflict (and the classified `port-conflict` status) WITHOUT
        // spawning a geniex that would fail to bind — and without touching the owner.
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let sup = GenieXSupervisor::new();
        let mut req = serve_req(Some("org/model"));
        req.port = Some(port);
        // a geniex.exe of the test's own, so the test does not depend on GenieX being
        // installed on the machine that runs it (a CI runner has none); it is never run
        req.exe = Some(installed_fake_exe().to_string_lossy().into_owned());

        let err = sup.start(req).await.expect_err("a held port must not start");
        assert!(err.contains(&port.to_string()), "{err}");
        assert!(err.contains("did not stop"), "{err}");

        let st = sup.get_status().await;
        assert_eq!(st.state, ServerLifecycleState::Failed);
        assert_eq!(st.last_error.map(|e| e.id), Some("port-conflict".to_string()));
        // Nothing was spawned: this app still owns no child and the owner is untouched.
        assert!(sup.inner.read().await.child.is_none());
        drop(listener);
    }

    /// The window reads the state through JSON: the enum must serialize as the
    /// same lowercase name the registry and the TypeScript type use.
    #[test]
    fn the_reported_state_serializes_as_its_registry_name() {
        let sup = GenieXSupervisor::new();
        let mut state = SupervisorState::new();
        state.state = ServerLifecycleState::Ready;
        state.busy = true;
        let status = sup.get_status_from_state(&state);
        let json = serde_json::to_value(&status).expect("a status serializes");
        assert_eq!(json["state"], "busy");
        state.busy = false;
        let json = serde_json::to_value(sup.get_status_from_state(&state)).expect("a status serializes");
        assert_eq!(json["state"], "ready");
    }

    #[test]
    fn status_maps_the_raw_error_to_the_friendly_form_and_reports_busy() {
        let sup = GenieXSupervisor::new();
        let mut state = SupervisorState::new();
        state.state = ServerLifecycleState::Ready;
        state.current_model = Some("qualcomm/Qwen3-1.7B:W4A16".to_string());
        // The reproduced UI bug: the host stored a raw string; the renderer read
        // `lastError` and got undefined. The status must carry the CLASSIFIED error
        // under `lastError`, always.
        state.last_error = Some("GenieX failed to respond to readiness check at http://127.0.0.1:18181/v1/models within 90s".to_string());

        // Generating: the reported state combines ready + busy.
        state.busy = true;
        let st = sup.get_status_from_state(&state);
        assert_eq!(st.state, ServerLifecycleState::Busy);
        let err = st.last_error.expect("the classified error must be present");
        assert_eq!(err.id, "timeout");
        assert_eq!(err.title, "The model did not finish loading in time");
        assert_eq!(st.context_kind, None);

        // Not generating: plain ready again — busy is a flag, not a lifecycle step.
        state.busy = false;
        assert_eq!(sup.get_status_from_state(&state).state, ServerLifecycleState::Ready);

        // A QAIRT model reports its context as compiled into the graph.
        state.context_kind = Some("compiled".to_string());
        state.served_nctx = Some(4096);
        let st = sup.get_status_from_state(&state);
        assert_eq!(st.context_kind.as_deref(), Some("compiled"));
        assert_eq!(st.served_nctx, Some(4096));
    }

    #[test]
    fn readiness_identity_rejects_prefix_and_suffix_lookalikes() {
        let served = ids(&["org/model-q4", "other/model", "xorg/model"]);
        // exact hit
        assert!(requested_model_listed(&served, Some("other/model")));
        // a model that merely CONTAINS the wanted name as a suffix/prefix is not it:
        // the old ends_with leniency accepted "xorg/model" for "org/model".
        assert!(!requested_model_listed(&served, Some("org/model")));
        assert!(!requested_model_listed(&ids(&["xorg/model"]), Some("org/model")));
        assert!(!requested_model_listed(&ids(&["org/models-extra"]), Some("org/model")), "arbitrary suffix must not match");
    }

    #[test]
    fn readiness_identity_tolerates_precision_and_separator_spellings() {
        // The server may list the bare model for a requested precision...
        assert!(requested_model_listed(&ids(&["org/model"]), Some("org/model:q4_0")));
        // ...or use the cache-style separator for the namespace.
        assert!(requested_model_listed(&ids(&["models--org--model"]), Some("org/model")));
        assert!(requested_model_listed(&ids(&["models--org--model"]), Some("org/model:q4_0")));
        // Precision must agree when both sides name one.
        assert!(!requested_model_listed(&ids(&["org/model:q8_0"]), Some("org/model:q4_0")));
    }

    #[test]
    fn readiness_identity_accepts_any_model_when_none_was_requested() {
        assert!(requested_model_listed(&ids(&["whatever"]), None));
        assert!(requested_model_listed(&[], None));
        assert!(!requested_model_listed(&[], Some("org/model")));
    }

    fn serve_req(model: Option<&str>) -> StartServerRequest {
        StartServerRequest {
            retry_model_load: false,
            exe: None,
            port: Some(18181),
            model: model.map(|m| m.to_string()),
            compute: Some("npu".to_string()),
            timeout_sec: None,
            keepalive_sec: None,
            strategy: Some("demand".to_string()),
            power_mode: Some("burst".to_string()),
            nctx: None,
            kv_type: None,
            kv_in_ram: None,
            spec_type: None,
            draft_model: None,
            draft_tokens: None,
            draft_min: None,
            draft_p_min: None,
            metrics: Some(true),
            vit_compute: None,
            qairt_lib: None,
            ngl: None,
            log_level: None,
            skip_update: None,
            extra_args: None,
        }
    }

    fn flags_of(args: &[String]) -> Vec<&str> {
        args.iter().map(|s| s.as_str()).collect()
    }

    // ---- adoption integration tests -----------------------------------------
    //
    // A REAL process named geniex.exe (this machine's PowerShell, copied under the
    // name, hosting a minimal HTTP responder inside its own process) listens on an
    // isolated loopback port. That is the exact shape `try_adopt_existing` must
    // recognize: the right image name on the right port answering /v1/models — and
    // the exact shape it must REFUSE when the model, readiness or liveness does not
    // hold. The test owns the process and kills it; nothing outside the test is
    // ever touched.

    struct FakeGeniex {
        child: std::process::Child,
        port: u16,
        exe: PathBuf,
    }

    impl FakeGeniex {
        fn kill_now(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    impl Drop for FakeGeniex {
        fn drop(&mut self) {
            self.kill_now();
            // each fake has its own folder (a copy of PowerShell): leave nothing in TEMP
            if let Some(dir) = self.exe.parent() { remove_test_dir(dir); }
        }
    }

    /// Delete a test folder, retrying briefly while Windows still holds the exited image.
    fn remove_test_dir(dir: &Path) {
        for _ in 0..20 {
            if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() { return; }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Copy `powershell.exe` to a fake `geniex.exe`, retrying only a sharing or lock
    /// violation: the suite runs in parallel and another test may execute PowerShell
    /// while this copy reads it. Every other error is returned at once.
    fn copy_powershell(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        let mut last = None;
        for _ in 0..40 {
            match std::fs::copy(from, to) {
                Ok(_) => return Ok(()),
                Err(e) if matches!(e.raw_os_error(), Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)) => {
                    last = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => return Err(e),
            }
        }
        Err(last.expect("at least one sharing violation"))
    }

    /// Spawns the fake server. `models_body` is the exact JSON answered to every
    /// request (a different model id makes the server INCOMPATIBLE); `reject_chat`
    /// answers HTTP 400 to completions, the shape of a server that lists a model
    /// it has not loaded.
    fn spawn_fake_geniex(models_body: &str, reject_chat: bool) -> FakeGeniex {
        use std::os::windows::process::CommandExt;
        use std::sync::atomic::{AtomicUsize, Ordering};
        // The tests run in parallel. Two `spawn_fake_geniex` calls can otherwise be
        // handed the SAME ephemeral port (bind :0, drop the probe, then start the
        // child), and one test would talk to the other test's server — the observed
        // "model not loaded" adoption failure. The lock covers only the pick-and-bind
        // window: once the child has written its ready file, its port is really held.
        static SPAWN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _spawn = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("mkmn-adopt-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let exe = dir.join("geniex.exe");
        // the fake answers HTTP like GenieX v0.11.0; the minimum-version gate reads this declaration
        crate::capabilities::test_versions::declare(&exe, "v0.11.0");
        if !exe.exists() {
            let windir = std::env::var("WINDIR").expect("WINDIR");
            let ps = Path::new(&windir).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
            copy_powershell(&ps, &exe).expect("copy powershell as geniex.exe");
        }
        // Take an ephemeral port and free it again for the fake server.
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let ready_file = dir.join("ready.txt");
        let _ = std::fs::remove_file(&ready_file);
        // PowerShell's booleans are $true/$false, not true/false.
        let reject_ps = if reject_chat { "$true" } else { "$false" };
        let reply = format!(
            r#"$body='{models_body}'
$reject = {reject_ps}
$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,{port})
$l.Start()
[IO.File]::WriteAllText('{}','ok')
while($true){{
  try{{
    $c=$l.AcceptTcpClient()
    $s=$c.GetStream()
    $req=New-Object byte[] 16384
    [void]$s.Read($req,0,16384)
    $status=200
    if($reject -and [Text.Encoding]::ASCII.GetString($req).StartsWith('POST')){{ $body='{{"error":{{"message":"model not loaded"}}}}'; $code='400 Bad Request' }}else{{ $code='200 OK' }}
    $hb=[Text.Encoding]::ASCII.GetBytes("HTTP/1.1 "+$code+"`r`nContent-Type: application/json`r`nContent-Length: "+$body.Length+"`r`nConnection: close`r`n`r`n"+$body)
    $s.Write($hb,0,$hb.Length);$s.Flush()
    $c.Close()
  }}catch{{}}
}}"#,
            ready_file.display()
        );
        let child = std::process::Command::new(&exe)
            .args(["-NoProfile", "-NonInteractive", "-Command", &reply])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .expect("spawn the fake geniex server");
        // Bounded wait for OUR listener. The ready file is written only after this
        // child binds the port, so a foreign server cannot satisfy the wait.
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if ready_file.exists() && std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                panic!("the fake geniex server never started listening");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        FakeGeniex { child, port, exe }
    }

    /// A geniex.exe that passes the install and version checks but serves nothing: a copy
    /// of PowerShell under that name, declared as v0.11.0, in a folder of its own.
    fn installed_fake_exe() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mkmn-installed-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let exe = dir.join("geniex.exe");
        crate::capabilities::test_versions::declare(&exe, "v0.11.0");
        if !exe.exists() {
            let windir = std::env::var("WINDIR").expect("WINDIR");
            let ps = Path::new(&windir).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
            copy_powershell(&ps, &exe).expect("copy powershell as geniex.exe");
        }
        exe
    }

    fn adopt_req(fake: &FakeGeniex, model: &str) -> StartServerRequest {
        let mut req = serve_req(Some(model));
        req.exe = Some(fake.exe.to_string_lossy().into_owned());
        req.port = Some(fake.port);
        req
    }

    /// THE adoption contract: a geniex.exe already serving the requested model is
    /// adopted as ready after it PROVES it answers a completion — but it is never
    /// our child, and nothing about its compute or configuration is claimed without
    /// evidence (an adopted server that no counter measured stays unverified).
    #[tokio::test]
    async fn a_compatible_running_server_is_adopted_after_it_answers_a_warmup() {
        let mut fake = spawn_fake_geniex(r#"{"data":[{"id":"org/model"}]}"#, false);
        let sup = GenieXSupervisor::with_watch_interval(Duration::from_millis(50));
        let req = adopt_req(&fake, "org/model");
        let st = sup.start(req).await.expect("adoption must succeed");
        assert_eq!(st.state, ServerLifecycleState::Ready);
        assert_eq!(st.pid, Some(fake.child.id()), "the reported PID is the external server's");
        {
            let s = sup.inner.read().await;
            assert!(s.child.is_none(), "the adopted process must NEVER be stored as our child");
            assert!(s.adopted);
            // Honesty: nothing about compute/configuration is claimed without evidence.
            assert!(!s.hw_verification.verified_npu, "no NPU evidence exists for a fake server");
            assert!(
                s.hw_verification.power_mode_active.contains("unknown"),
                "power mode was not configured by MKMN: {}",
                s.hw_verification.power_mode_active
            );
            assert!(
                s.hw_verification.qos_tier.contains("Not applied"),
                "QoS was never applied to a foreign process: {}",
                s.hw_verification.qos_tier
            );
            assert_eq!(s.served_nctx, None, "the context of a server we did not start is unknown");
        }
        // The external server is untouched and still running.
        let _admission = sup.admit().await;
        assert!(sup.release_for_handoff().await.unwrap_err().contains("external GenieX server"));
        assert!(fake.child.try_wait().unwrap().is_none(), "the adopted server must still be running");
    }

    #[tokio::test]
    async fn a_cancelled_request_waiting_on_admission_does_not_adopt_or_start_a_server() {
        let mut fake = spawn_fake_geniex(r#"{"data":[{"id":"org/model"}]}"#, false);
        let supervisor = GenieXSupervisor::new();
        let generation = supervisor.cancel_generation().await;
        supervisor.stop().await.unwrap();
        let error = supervisor.start_with_generation(adopt_req(&fake, "org/model"), generation).await.unwrap_err();
        assert!(error.contains("cancelled"));
        assert_eq!(supervisor.get_status().await.state, ServerLifecycleState::Stopped);
        assert!(fake.child.try_wait().unwrap().is_none());
    }

    #[tokio::test]
    async fn a_paused_build_refuses_automatic_start_and_allows_explicit_retry() {
        let mut fake = spawn_fake_geniex(r#"{"data":[{"id":"org/model"}]}"#, false);
        let supervisor = GenieXSupervisor::new();
        let mut request = adopt_req(&fake, "org/model");
        let caps = crate::capabilities::probe(&fake.exe);
        let (runtime, _) = warmup_runtime(&fake.exe, None, &caps);
        let key = format!("{runtime} npu {}", warmup_build("org/model"));
        {
            let mut state = supervisor.inner.write().await;
            let raw = "GenieX failed to load org/model\nHTTP 500: SDKError(Model loading failed) (-100201)";
            state.warmup_failures.record(&key, raw.to_owned());
            state.warmup_failures.record(&key, raw.to_owned());
        }
        let blocked = supervisor.start(request.clone()).await.unwrap_err();
        assert!(blocked.contains(WARMUP_PAUSED), "{blocked}");
        assert!(blocked.contains("org/model"), "{blocked}");
        assert!(fake.child.try_wait().unwrap().is_none());
        request.retry_model_load = true;
        let ready = supervisor.start(request).await.expect("the explicit attempt reaches the server");
        assert_eq!(ready.state, ServerLifecycleState::Ready);
    }

    /// A geniex.exe holding the port for a DIFFERENT model is not adoptable: the
    /// named conflict is reported, nothing is spawned, nothing is killed.
    #[tokio::test]
    async fn an_incompatible_server_is_reported_as_a_conflict_and_left_running() {
        let mut fake = spawn_fake_geniex(r#"{"data":[{"id":"other/model"}]}"#, false);
        let sup = GenieXSupervisor::new();
        let req = adopt_req(&fake, "org/model");
        let err = sup.start(req).await.expect_err("a different model must not be adopted");
        assert!(err.contains("already in use"), "the named conflict: {err}");
        assert!(err.contains("did not stop"), "the message must say the owner was left alone: {err}");
        let st = sup.get_status().await;
        assert_eq!(st.state, ServerLifecycleState::Failed);
        assert_eq!(st.last_error.map(|e| e.id), Some("port-conflict".to_string()));
        assert!(sup.inner.read().await.child.is_none(), "no second server may be spawned");
        assert!(fake.child.try_wait().unwrap().is_none(), "the foreign server must still be running");
    }

    /// Connecting to a GenieX server is inference too: one whose executable reports a
    /// version below the minimum is never adopted, and it is left running.
    #[tokio::test]
    async fn a_server_run_by_an_older_geniex_is_not_adopted_and_left_running() {
        let mut fake = spawn_fake_geniex(r#"{"data":[{"id":"org/model"}]}"#, false);
        crate::capabilities::test_versions::declare(&fake.exe, "v0.10.0");
        let sup = GenieXSupervisor::new();
        let err = sup.start(adopt_req(&fake, "org/model")).await.expect_err("an older GenieX must not be used");
        assert!(err.contains("v0.10.0") && err.contains("v0.11.0 or newer"), "the refusal names both versions: {err}");
        assert!(sup.inner.read().await.child.is_none(), "no server may be spawned");
        assert!(fake.child.try_wait().unwrap().is_none(), "the foreign server must still be running");
    }

    /// A server that LISTS the model but refuses a real completion (listed, not
    /// loaded — exactly what /v1/models alone cannot distinguish) must NOT be
    /// adopted and must NOT be claimed ready: the conflict says what was measured.
    #[tokio::test]
    async fn a_server_that_lists_the_model_but_will_not_serve_it_is_not_adopted() {
        let mut fake = spawn_fake_geniex(r#"{"data":[{"id":"org/model"}]}"#, true);
        let sup = GenieXSupervisor::new();
        let req = adopt_req(&fake, "org/model");
        let err = sup.start(req).await.expect_err("an unready server must not be adopted");
        assert!(
            err.contains("did not answer a warm-up completion") && err.contains("HTTP 400"),
            "the refusal must name the warm-up evidence: {err}"
        );
        assert!(err.contains("adopted nothing"), "MKMN must not claim it took the server over: {err}");
        let st = sup.get_status().await;
        assert_eq!(st.state, ServerLifecycleState::Failed);
        assert!(sup.inner.read().await.child.is_none(), "no second server may be spawned");
        assert!(fake.child.try_wait().unwrap().is_none(), "the foreign server must still be running");
    }

    /// An adopted server dying must invalidate the stale "ready" quickly (the
    /// watcher), and the freed port must let the next start proceed past the
    /// conflict — a real recovery, not a stuck failed status.
    #[tokio::test]
    async fn the_death_of_an_adopted_server_invalidates_the_ready_status_and_the_port_recoveries() {
        let mut fake = spawn_fake_geniex(r#"{"data":[{"id":"org/model"}]}"#, false);
        let sup = GenieXSupervisor::with_watch_interval(Duration::from_millis(50));
        let req = adopt_req(&fake, "org/model");
        let st = sup.start(req.clone()).await.expect("adoption must succeed");
        assert_eq!(st.state, ServerLifecycleState::Ready);

        // The owner (our own test child) dies: the watcher must notice and clear the
        // stale ready state.
        let pid = fake.child.id();
        fake.kill_now();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let s = sup.get_status().await;
            if s.state == ServerLifecycleState::Failed {
                let err = s.last_error.expect("the death must carry its reason");
                assert!(err.raw.contains("no longer running"), "{:?}", err.raw);
                assert!(err.raw.contains(&pid.to_string()), "the reason names the dead PID: {:?}", err.raw);
                break;
            }
            assert!(Instant::now() < deadline, "the stale ready status was never invalidated");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        {
            let s = sup.inner.read().await;
            assert_eq!(s.pid, None, "a dead PID must not keep being reported");
            assert!(!s.adopted);
        }

        // Recovery: the port is free again, so a new start no longer meets the
        // conflict — it proceeds toward a real (fresh) server.
        let freed = (0..100).any(|_| {
            if tcp_listener_owner(fake.port).is_none() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
            false
        });
        assert!(freed, "the port must be free after the owner died");
        let err2 = sup.start(req).await.expect_err("a fresh start of the fake cannot serve");
        assert!(
            !err2.contains("already in use"),
            "the conflict must be gone after the owner died: {err2}"
        );
    }

    /// The liveness check behind the adopted-server watcher: a process that exited
    /// is dead even while handles to it remain open (the classic zombie-PID trap),
    /// and a live process passes.
    #[tokio::test]
    async fn the_adopted_liveness_check_distinguishes_dead_from_alive() {
        use std::os::windows::process::CommandExt;
        // The liveness check also verifies the image name (PID-reuse guard), so the
        // live subject must be an exe named geniex.exe: the same PowerShell copy the
        // adoption tests use, running a bounded sleep.
        let dir = std::env::temp_dir().join(format!("mkmn-liveness-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let exe = dir.join("geniex.exe");
        if !exe.exists() {
            let windir = std::env::var("WINDIR").expect("WINDIR");
            let ps = Path::new(&windir)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            copy_powershell(&ps, &exe).expect("copy powershell as geniex.exe");
        }
        let mut sleeper = std::process::Command::new(&exe)
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn a liveness subject");
        let pid = sleeper.id();
        assert!(
            adopted_process_alive(pid),
            "a live geniex-named process must be reported alive"
        );
        let _ = sleeper.kill();
        let _ = sleeper.wait();
        assert!(
            !adopted_process_alive(pid),
            "an exited process must be reported dead even with open handles"
        );
        assert!(!adopted_process_alive(u32::MAX - 1), "a PID that cannot be opened is dead");
        remove_test_dir(&dir);
    }

    /// A supervisor state with `last_request` recorded and a given lifecycle state,
    /// for exercising the pure reuse decision without a live process.
    fn state_in(lifecycle: &str) -> SupervisorState {
        let mut s = SupervisorState::new();
        s.state = lifecycle.parse().expect("a real lifecycle state");
        s.last_request = Some(serve_req(Some("org/model")));
        s
    }

    #[test]
    fn start_reuse_reuses_a_ready_server() {
        let req = serve_req(Some("org/model"));
        assert!(matches!(GenieXSupervisor::start_reuse(&state_in("ready"), &req), ReuseDecision::Ready));
    }

    #[test]
    fn start_reuse_compares_effective_keepalive_and_log_options() {
        let mut state = state_in("ready");
        let last = state.last_request.as_mut().unwrap();
        last.strategy = Some("demand".into());
        last.log_level = Some("none".into());
        let mut chat = last.clone();
        chat.keepalive_sec = Some(300);
        chat.log_level = None;
        assert!(matches!(GenieXSupervisor::start_reuse(&state, &chat), ReuseDecision::Ready));
        chat.keepalive_sec = Some(900);
        assert!(matches!(GenieXSupervisor::start_reuse(&state, &chat), ReuseDecision::Proceed));
    }

    #[test]
    fn start_reuse_awaits_an_in_flight_startup() {
        let req = serve_req(Some("org/model"));
        assert!(matches!(GenieXSupervisor::start_reuse(&state_in("starting"), &req), ReuseDecision::Await));
        assert!(matches!(GenieXSupervisor::start_reuse(&state_in("loading"), &req), ReuseDecision::Await));
    }

    #[test]
    fn start_reuse_restarts_after_idle_unload() {
        // `unloaded` means the keepalive idle timeout fired: the model is GONE even
        // though the request matches. The next request for the same model must do a
        // full start (auto-reload), not "reuse" a server that serves nothing.
        let req = serve_req(Some("org/model"));
        assert!(matches!(GenieXSupervisor::start_reuse(&state_in("unloaded"), &req), ReuseDecision::Proceed));
    }

    #[test]
    fn start_reuse_proceeds_for_other_states_and_different_requests() {
        let req = serve_req(Some("org/model"));
        for lifecycle in ["stopped", "failed", "busy", "restarting"] {
            assert!(
                matches!(GenieXSupervisor::start_reuse(&state_in(lifecycle), &req), ReuseDecision::Proceed),
                "state `{lifecycle}` must proceed to a full start"
            );
        }
        // A different configuration never reuses the resident server.
        let mut other = serve_req(Some("org/model"));
        other.compute = Some("cpu".to_string());
        assert!(matches!(GenieXSupervisor::start_reuse(&state_in("ready"), &other), ReuseDecision::Proceed));
        // No recorded request → nothing to reuse.
        let mut empty = SupervisorState::new();
        empty.state = ServerLifecycleState::Ready;
        assert!(matches!(GenieXSupervisor::start_reuse(&empty, &req), ReuseDecision::Proceed));
    }

    /// A capability manifest that documents every MKMN flag (an executable that
    /// supports everything): what the production path probes a good CLI into.
    fn caps_all() -> crate::capabilities::GeniexCapabilities {
        crate::capabilities::GeniexCapabilities {
            exe_path: "test".into(),
            exe_len: 0,
            exe_mtime_secs: 0,
            geniex_version: Some("v0.10.0".into()),
            qairt_runtime: None,
            llama_cpp_hash: None,
            serve_flags: crate::capabilities::MKMN_SERVE_FLAGS.iter().map(|f| f.to_string()).collect(),
            kv_type_supported: true,
            kv_in_ram_supported: true,
            probed_at_secs: 0,
            probe_ms: 0,
            probe_error: None,
        }
    }

    #[test]
    fn serve_command_carries_the_effective_request() {
        let mut req = serve_req(Some("org/model"));
        req.kv_in_ram = Some(true);
        let (args, served_nctx, served_kv, served_kv_in_ram, rejected) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, Some("q4_0"), true, false, Some(4096), Some(&caps_all()));
        assert!(rejected.is_empty());
        let f = flags_of(&args);
        assert_eq!(args[0], "serve");
        assert!(f.contains(&"--model") && f.contains(&"org/model"));
        assert!(f.contains(&"--nctx") && f.contains(&"4096"));
        assert!(f.contains(&"--kv-type") && f.contains(&"q4_0"));
        assert!(f.contains(&"--kv-in-ram"));
        assert_eq!(served_nctx, Some(4096));
        assert_eq!(served_kv.as_deref(), Some("q4_0"));
        assert!(served_kv_in_ram);
    }

    #[test]
    fn serve_command_omits_flags_this_geniex_does_not_support() {
        // v0.10.0 documents neither KV flag: neither may be sent (an unknown flag makes
        // geniex refuse to start at all), and the served report says so.
        let mut req = serve_req(Some("org/model"));
        req.kv_type = Some("q8_0".to_string());
        req.kv_in_ram = Some(true);
        let (args, served_nctx, served_kv, served_kv_in_ram, _) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, None, false, false, Some(4096), Some(&caps_all()));
        let f = flags_of(&args);
        assert!(!f.contains(&"--kv-type"));
        assert!(!f.contains(&"--kv-in-ram"));
        assert_eq!(served_kv, None);
        assert!(!served_kv_in_ram);
        assert_eq!(served_nctx, Some(4096));
    }

    #[test]
    fn serve_command_sends_no_dynamic_context_for_qairt() {
        // QAIRT compiles the context into the QNN graph: --nctx/--kv-* would only risk
        // an unknown-flag rejection, so none of them may appear.
        let mut req = serve_req(Some("qualcomm/model"));
        req.nctx = Some(8192);
        req.kv_type = Some("q4_0".to_string());
        req.kv_in_ram = Some(true);
        let (args, served_nctx, served_kv, served_kv_in_ram, _) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, Some("q4_0"), true, true, Some(4096), Some(&caps_all()));
        let f = flags_of(&args);
        assert!(!f.contains(&"--nctx"));
        assert!(!f.contains(&"--kv-type"));
        assert!(!f.contains(&"--kv-in-ram"));
        assert_eq!(served_nctx, None);
        assert_eq!(served_kv, None);
        assert!(!served_kv_in_ram);
    }

    #[test]
    fn serve_command_maps_the_strategy_to_keepalive_when_no_value_is_saved() {
        let mut req = serve_req(None);
        req.strategy = Some("always".to_string());
        let (args, _, _, _, _) = build_serve_args(&req, "127.0.0.1:18181", "burst", 86_400, None, false, false, None, Some(&caps_all()));
        let i = flags_of(&args).iter().position(|a| *a == "--keepalive").unwrap();
        assert_eq!(args[i + 1], "86400");
    }

    #[test]
    fn serve_command_forwards_optional_features_verbatim() {
        let mut req = serve_req(Some("org/model"));
        req.spec_type = Some("ngram-simple".to_string());
        req.draft_model = Some("draft".to_string());
        req.draft_tokens = Some(4);
        req.draft_min = Some(2);
        req.draft_p_min = Some(0.6);
        req.vit_compute = Some("htp".to_string());
        req.ngl = Some(16);
        req.log_level = Some("debug".to_string());
        req.extra_args = Some(vec!["--flash-attn".to_string()]);
        let (args, _, _, _, rejected) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, Some("q4_0"), true, false, Some(4096), Some(&caps_all()));
        let f = flags_of(&args);
        assert!(f.contains(&"--spec-type") && f.contains(&"ngram-simple"));
        assert!(f.contains(&"--draft-model") && f.contains(&"draft"));
        assert!(f.contains(&"--draft-tokens") && f.contains(&"4"));
        assert!(f.contains(&"--draft-min") && f.contains(&"2"));
        assert!(f.contains(&"--draft-p-min") && f.contains(&"0.6"));
        assert!(f.contains(&"--vit-compute") && f.contains(&"htp"));
        assert!(f.contains(&"--ngl") && f.contains(&"16"));
        assert!(f.contains(&"--log") && f.contains(&"debug"));
        assert!(f.contains(&"--flash-attn"));
        assert!(rejected.is_empty());
    }

    #[test]
    fn serve_command_sends_defaults_for_the_new_optional_flags_never() {
        // -1 layers, "none" log level and 0 draft floors are the runtime's own
        // defaults: none of them may be sent as an explicit flag.
        let mut req = serve_req(Some("org/model"));
        req.ngl = Some(-1);
        req.log_level = Some("none".to_string());
        req.draft_min = Some(0);
        req.draft_p_min = Some(0.0);
        let (args, _, _, _, rejected) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, Some("q4_0"), true, false, Some(4096), Some(&caps_all()));
        let f = flags_of(&args);
        assert!(!f.contains(&"--ngl"));
        assert!(!f.contains(&"--log"));
        assert!(!f.contains(&"--draft-min"));
        assert!(!f.contains(&"--draft-p-min"));
        assert!(rejected.is_empty());
    }

    #[test]
    fn serve_command_keeps_llama_and_qairt_only_flags_on_their_own_engine() {
        // The draft/offload flags are llama.cpp-only and --qairt-lib is QAIRT-only:
        // a flag that does not belong to the model's engine is never sent at all.
        let mut qairt_req = serve_req(Some("qualcomm/model"));
        qairt_req.spec_type = Some("ngram-simple".to_string());
        qairt_req.ngl = Some(8);
        qairt_req.qairt_lib = Some("C:/QAIRT/2.50".to_string());
        qairt_req.log_level = Some("info".to_string());
        let (args, _, _, _, _) = build_serve_args(&qairt_req, "127.0.0.1:18181", "burst", 300, None, false, true, None, Some(&caps_all()));
        let f = flags_of(&args);
        assert!(!f.contains(&"--spec-type"));
        assert!(!f.contains(&"--ngl"));
        assert!(f.contains(&"--qairt-lib") && f.contains(&"C:/QAIRT/2.50"));
        assert!(f.contains(&"--log") && f.contains(&"info"));

        let mut llama_req = serve_req(Some("org/model"));
        llama_req.qairt_lib = Some("C:/QAIRT/2.50".to_string());
        llama_req.log_level = Some("info".to_string());
        let (args, _, _, _, _) = build_serve_args(&llama_req, "127.0.0.1:18181", "burst", 300, Some("q4_0"), true, false, Some(4096), Some(&caps_all()));
        let f = flags_of(&args);
        assert!(!f.contains(&"--qairt-lib"), "a llama.cpp model never receives a QAIRT runtime override");
        assert!(f.contains(&"--log"));
    }

    #[test]
    fn serve_command_omits_and_reports_optional_flags_this_geniex_does_not_document() {
        // v0.10.0 documents --vit-compute but the probe returns a manifest without
        // the speculation flags: requested-but-undocumented options are omitted
        // AND reported (never dropped silently, never sent to a CLI that would
        // refuse to start over them).
        let mut req = serve_req(Some("org/model"));
        req.spec_type = Some("ngram-simple".to_string());
        req.draft_model = Some("draft".to_string());
        req.vit_compute = Some("htp".to_string());
        let mut caps = caps_all();
        caps.serve_flags = vec!["--model".into(), "--nctx".into(), "--compute".into(), "--power-mode".into(), "--keepalive".into(), "--metrics".into(), "--vit-compute".into()];
        caps.kv_type_supported = false;
        caps.kv_in_ram_supported = false;
        let (args, _, _, _, rejected) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, None, false, false, Some(4096), Some(&caps));
        let f = flags_of(&args);
        assert!(!f.contains(&"--spec-type"));
        assert!(!f.contains(&"--draft-model"));
        assert!(f.contains(&"--vit-compute") && f.contains(&"htp"));
        assert_eq!(rejected.len(), 2, "both omitted flags are reported: {rejected:?}");
        assert!(rejected[0].contains("--spec-type") || rejected[1].contains("--spec-type"));
        assert!(rejected[0].contains("--draft-model") || rejected[1].contains("--draft-model"));
    }

    #[test]
    fn serve_command_skips_the_update_probe_only_when_asked_and_documented() {
        // `geniex serve --help` (v0.10.0, read on this PC) lists --skip-update among its
        // global flags: asked for, it is sent as a bare flag; not asked for, nothing.
        let mut req = serve_req(Some("org/model"));
        req.skip_update = Some(true);
        let (args, _, _, _, rejected) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, None, false, false, Some(4096), Some(&caps_all()));
        assert!(flags_of(&args).contains(&"--skip-update"));
        assert!(rejected.is_empty());
        // the flag takes no value: it is never followed by one of ours
        let at = args.iter().position(|a| a == "--skip-update").unwrap();
        assert!(args.get(at + 1).map(|a| a.starts_with("--")).unwrap_or(true));

        req.skip_update = Some(false);
        let (args, _, _, _, _) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, None, false, false, Some(4096), Some(&caps_all()));
        assert!(!flags_of(&args).contains(&"--skip-update"));

        // a GenieX whose help does not list it: omitted and reported
        req.skip_update = Some(true);
        let mut caps = caps_all();
        caps.serve_flags.retain(|f| f != "--skip-update");
        let (args, _, _, _, rejected) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, None, false, false, Some(4096), Some(&caps));
        assert!(!flags_of(&args).contains(&"--skip-update"));
        assert!(rejected.iter().any(|r| r.contains("--skip-update")));
    }

    #[test]
    fn serve_command_reports_unprobed_executables_instead_of_assuming_flags() {
        // No capability manifest at all (probe failed): an optional flag may not
        // be ASSUMED — it is omitted and the report says why.
        let mut req = serve_req(Some("org/model"));
        req.vit_compute = Some("htp".to_string());
        let (args, _, _, _, rejected) = build_serve_args(&req, "127.0.0.1:18181", "burst", 300, None, false, false, Some(4096), None);
        assert!(!flags_of(&args).contains(&"--vit-compute"));
        assert!(rejected.iter().any(|r| r.contains("could not be probed")));
    }
}
