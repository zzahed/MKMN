use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use crate::accelerators::{
    classify_gpu_counters, luid_key, npu_adapter_luids, npu_memory_bytes, AdapterInventory,
    ClassifiedSample, CounterInstance,
};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
};
use windows_sys::Win32::System::SystemInformation::{
    GlobalMemoryStatusEx, MEMORYSTATUSEX,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemTimes(
        lp_idle_time: *mut windows_sys::Win32::Foundation::FILETIME,
        lp_kernel_time: *mut windows_sys::Win32::Foundation::FILETIME,
        lp_user_time: *mut windows_sys::Win32::Foundation::FILETIME,
    ) -> i32;
}

// --- EcoQoS (Efficiency Mode) Win32 Definitions ---
#[repr(C)]
#[allow(non_snake_case)]
struct PROCESS_POWER_THROTTLING_STATE {
    Version: u32,
    ControlMask: u32,
    StateMask: u32,
}
const PROCESS_POWER_THROTTLING_ID: i32 = 4;
const PROCESS_POWER_THROTTLING_CURRENT_VERSION: u32 = 1;
const PROCESS_POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;

unsafe extern "system" {
    fn GetProcessInformation(
        h_process: HANDLE,
        process_information_class: i32,
        process_information: *mut std::ffi::c_void,
        process_information_size: u32,
    ) -> i32;
}

// --- PDH (Performance Data Helper) Definitions ---
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct PDH_FMT_COUNTERVALUE {
    pub c_status: u32,
    pub double_value: f64,
}

#[repr(C)]
pub struct PDH_FMT_COUNTERVALUE_ITEM_W {
    pub sz_name: *mut u16,
    pub fmt_value: PDH_FMT_COUNTERVALUE,
}

#[link(name = "pdh")]
unsafe extern "system" {
    pub fn PdhOpenQueryW(
        sz_data_source: *const u16,
        dw_user_data: usize,
        ph_query: *mut isize,
    ) -> u32;
    pub fn PdhAddEnglishCounterW(
        h_query: isize,
        sz_full_counter_path: *const u16,
        dw_user_data: usize,
        ph_counter: *mut isize,
    ) -> u32;
    pub fn PdhCollectQueryData(h_query: isize) -> u32;
    pub fn PdhGetFormattedCounterArrayW(
        h_counter: isize,
        dw_format: u32,
        lpdw_buffer_size: *mut u32,
        lpdw_item_count: *mut u32,
        item_buffer: *mut u8,
    ) -> u32;
    pub fn PdhCloseQuery(h_query: isize) -> u32;
}

// --- Global Atomic Flags for Smart Throttling and Live Inference Tracking ---
pub static IS_INFERRING: AtomicBool = AtomicBool::new(false);
pub static IS_WINDOW_MINIMIZED_OR_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Whether the window currently has keyboard focus. Visible-but-unfocused windows get a
/// slower sampling cadence and the same reduced work as background windows below.
pub static IS_WINDOW_FOCUSED: AtomicBool = AtomicBool::new(true);
/// Whether a benchmark is running. A benchmark is work the app is doing on the NPU, and
/// its own readings (and the meter cache) are read while it runs, so the hidden window
/// must not send the monitor to sleep over it.
pub static IS_BENCHMARKING: AtomicBool = AtomicBool::new(false);

pub fn set_inferring(val: bool) {
    IS_INFERRING.store(val, Ordering::Relaxed);
}

pub fn set_benchmarking(val: bool) {
    IS_BENCHMARKING.store(val, Ordering::Relaxed);
    // the lease is stamped when the flag goes on and cleared when it goes off (a dead
    // sidecar's exit path, or the sidecar's own end of run, both come through here);
    // 0 means "never set", so a stamp on the clock's first millisecond reads as 1
    BENCHMARKING_SINCE_MS.store(if val { monotonic_ms().max(1) } else { 0 }, Ordering::Relaxed);
}

/// When the benchmark flag was last set or renewed (monotonic ms; 0 = no lease held).
static BENCHMARKING_SINCE_MS: AtomicU64 = AtomicU64::new(0);
/// A lease older than this with no renewal has lapsed: the sidecar that set it renewed it
/// every minute while it lived, so two hours of silence mean it died mid-run — and the
/// flag must not keep the monitor awake for ever after it.
pub const BENCHMARKING_LEASE_MS: u64 = 2 * 60 * 60 * 1_000;

/// Whether the benchmark lease still holds. Pure so the rule is pinned by tests.
fn benchmarking_lease_holds(since_ms: u64, now_ms: u64) -> bool {
    since_ms != 0 && now_ms.saturating_sub(since_ms) <= BENCHMARKING_LEASE_MS
}

pub fn set_window_minimized_or_hidden(val: bool) {
    IS_WINDOW_MINIMIZED_OR_HIDDEN.store(val, Ordering::Relaxed);
    // The window is shown again: the sampling loop wakes at once and takes its first
    // sample, so the meters start fresh instead of as old as the rest was long.
    if !val {
        SHOW_WAKE.notify_one();
    }
}

pub fn set_window_focused(val: bool) {
    IS_WINDOW_FOCUSED.store(val, Ordering::Relaxed);
}

// --- The classified NPU reading of the latest sample, for readers outside the monitor
// loop (get_meters_cmd): the app's resource bar shows the SAME native number the
// titlebar pill does, instead of a permanent null while the titlebar has a reading.
/// Percent times 100, or u64::MAX when there is no reading.
static LAST_NPU_UTIL_PCT: AtomicU64 = AtomicU64::new(u64::MAX);
/// Whether the latest sample had VALID NPU counters (an idle 0.0% counts).
static LAST_NPU_AVAILABLE: AtomicBool = AtomicBool::new(false);
/// When the latest sample was published, in milliseconds since this clock's first use
/// (0 = never): the age beyond which the cached reading is no longer "current".
static LAST_NPU_UTIL_AT_MS: AtomicU64 = AtomicU64::new(0);

/// A monotonic millisecond clock for the reading age, measured from its first use.
fn monotonic_ms() -> u64 {
    static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The longest the monitor's NPU sample may be reused before it stops being "current".
/// While the loop rests (the window hidden) its last sample can be hours old, and an old
/// number must never be shown as the load now. Pure so the rule is pinned by tests.
fn npu_reading_is_current(age_ms: u64) -> bool {
    age_ms <= NPU_READING_MAX_AGE_MS
}
/// A reading older than this is re-read (a light PDH sample, no process walk) rather than
/// passed off as current. It sits above the unfocused cadence (5 000) plus the light
/// sample's own time (the two collections and the wait between them), so a visible window
/// always reuses the monitor's sample and a rested one never shows an old number.
const NPU_READING_MAX_AGE_MS: u64 = 6_500;

/// Published by the monitor's sample(): the system's classified NPU utilization.
fn publish_npu_utilization(observed: bool, percent: f64) {
    LAST_NPU_AVAILABLE.store(observed, Ordering::Relaxed);
    let v = if observed && percent.is_finite() {
        (percent.clamp(0.0, 100.0) * 100.0).round() as u64
    } else {
        u64::MAX
    };
    LAST_NPU_UTIL_PCT.store(v, Ordering::Relaxed);
    LAST_NPU_UTIL_AT_MS.store(monotonic_ms(), Ordering::Relaxed);
}

/// The monitor's last classified NPU utilization (0-100) while it is still recent, or None
/// when its counters were unavailable or the sample is stale. None is "unavailable", never
/// a measured-looking 0, and never an old number shown as the load now (the host
/// capability uses `current_npu_utilization` for a fresh fallback).
pub fn last_npu_utilization() -> Option<f64> {
    if !LAST_NPU_AVAILABLE.load(Ordering::Relaxed) {
        return None;
    }
    let at = LAST_NPU_UTIL_AT_MS.load(Ordering::Relaxed);
    if at == 0 || !npu_reading_is_current(monotonic_ms().saturating_sub(at)) {
        return None;
    }
    let v = LAST_NPU_UTIL_PCT.load(Ordering::Relaxed);
    if v == u64::MAX { None } else { Some(v as f64 / 100.0) }
}

/// The long-lived light sampler behind `current_npu_utilization`: one query kept for the
/// session, so the previous collection is the first sample of the rate. A fresh query per
/// read collects its two samples microseconds apart, and a rate counter over a near-zero
/// interval is not a measurement — it reads 0 (idle) while the NPU is busy.
struct LightSampler {
    sampler: PdhGpuSampler,
    /// When the sampler last collected for THIS reader (monotonic ms; 0 = never).
    last_collect_at_ms: u64,
}

static LIGHT_SAMPLER: std::sync::OnceLock<std::sync::Mutex<Option<LightSampler>>> = std::sync::OnceLock::new();

fn light_sampler() -> &'static std::sync::Mutex<Option<LightSampler>> {
    LIGHT_SAMPLER.get_or_init(|| std::sync::Mutex::new(None))
}

/// The oldest a previous collection may be and still serve as the first sample of the
/// rate: older than this (or no previous), two fresh collections are taken.
const LIGHT_SAMPLER_MAX_GAP_MS: u64 = 60_000;
/// The wait between the two collections of the slow path (the query is synchronous; the
/// callers run it off the main thread).
const LIGHT_SAMPLER_WAIT_MS: u64 = 250;
/// The two samples of a rate must be at least this far apart for the counter to mean
/// anything: less is not a measurement. Pure so the rule is pinned by tests.
fn npu_light_interval_ok(from_ms: u64, to_ms: u64) -> bool {
    to_ms.saturating_sub(from_ms) >= 100
}
/// Whether a fresh pair of samples is needed: no previous collection, or one too old to
/// be the first sample of the rate. Pure so the rule is pinned by tests.
fn npu_light_needs_pair(last_collect_at_ms: u64, now_ms: u64) -> bool {
    last_collect_at_ms == 0 || now_ms.saturating_sub(last_collect_at_ms) > LIGHT_SAMPLER_MAX_GAP_MS
}

/// The freshest NPU utilization the app can honestly show: the monitor's classified sample
/// while it is recent, else a light PDH read taken here (the same classification, no process
/// walk). None stays unknown -- no valid counters, or nothing could be read -- never an old
/// value and never idle.
pub fn current_npu_utilization() -> Option<f64> {
    if let Some(v) = last_npu_utilization() {
        return Some(v);
    }
    let Ok(mut slot) = light_sampler().lock() else { return None };
    if slot.is_none() {
        // the constructor collects once (the counter's own rate base); that collection is
        // not one of the pairs measured here, so the timestamp starts at 0 (none)
        *slot = PdhGpuSampler::new().map(|sampler| LightSampler { sampler, last_collect_at_ms: 0 });
    }
    let entry = slot.as_mut()?;
    let now = monotonic_ms();
    let mut first_at = entry.last_collect_at_ms;
    if npu_light_needs_pair(first_at, now) {
        entry.sampler.collect();
        first_at = monotonic_ms();
        std::thread::sleep(std::time::Duration::from_millis(LIGHT_SAMPLER_WAIT_MS));
    }
    let instances = entry.sampler.collect();
    let at = monotonic_ms();
    entry.last_collect_at_ms = at;
    if !npu_light_interval_ok(first_at, at) {
        return None; // the two samples are too close for a rate: unknown, never idle
    }
    let classified = classify_gpu_counters(&instances, AdapterInventory::shared());
    if !classified.npu.observed {
        return None;
    }
    let util = classified.npu.busiest_engine();
    publish_npu_utilization(true, util);
    Some(util)
}

/// The samplers behind `current_npu_memory_bytes`, kept for the session: the engine
/// names (which adapter is the NPU) and the adapter memory usage, shared and dedicated.
struct MemorySamplers {
    engine: PdhGpuSampler,
    shared: PdhGpuSampler,
    dedicated: PdhGpuSampler,
}

static MEMORY_SAMPLERS: std::sync::OnceLock<std::sync::Mutex<Option<MemorySamplers>>> = std::sync::OnceLock::new();

/// The memory in use on the NPU, in bytes, read through PDH ("GPU Adapter Memory",
/// shared plus dedicated usage of the NPU's adapters). The usage counters are gauges, so
/// one collection is a reading. The sidecar's benchmark used to spawn PowerShell for
/// every memory point. None is unknown (no counters, no NPU adapter), never 0.
pub fn current_npu_memory_bytes() -> Option<f64> {
    let Ok(mut slot) = MEMORY_SAMPLERS.get_or_init(|| std::sync::Mutex::new(None)).lock() else { return None };
    if slot.is_none() {
        *slot = (|| {
            Some(MemorySamplers {
                engine: PdhGpuSampler::new()?,
                shared: PdhGpuSampler::with_counter("\\GPU Adapter Memory(*)\\Shared Usage")?,
                dedicated: PdhGpuSampler::with_counter("\\GPU Adapter Memory(*)\\Dedicated Usage")?,
            })
        })();
    }
    let s = slot.as_mut()?;
    let npu = npu_adapter_luids(&s.engine.collect(), AdapterInventory::shared());
    let mut rows = s.shared.collect();
    rows.extend(s.dedicated.collect());
    npu_memory_bytes(&rows, &npu)
}

/// Sampling cadence policy: 1.8 s while the window is focused and visible (the live-metrics
/// specification), 5 s when visible but unfocused (the user is reading, not watching the
/// meters), 10 s when hidden/minimized to tray. Pure so the policy is pinned by tests.
fn monitor_interval_ms(hidden: bool, focused: bool) -> u64 {
    if hidden {
        10_000
    } else if focused {
        1_800
    } else {
        5_000
    }
}

/// Whether the sampling loop may rest instead of ticking: the window is hidden (or
/// minimized to the notification area) and neither an answer is streaming nor a benchmark
/// is running. A meter nobody can see is not worth a reading, but a hidden benchmark is
/// still work the app is doing — its readings are read while it runs (the sidecar's NPU
/// probes), so the monitor keeps sampling. Pure so the policy is pinned by tests.
fn rests(hidden: bool, inferring: bool, benchmarking: bool) -> bool {
    hidden && !inferring && !benchmarking
}

/// Whether a tick waits its cadence before sampling. The tick that leaves a rest does
/// not wait: the window was just shown, so its meters fill in at once instead of staying
/// blank for a whole cadence. Every other tick waits the interval. Pure so the rule is
/// pinned by tests.
fn sleeps_before_sample(rested: bool) -> bool {
    !rested
}

/// How often the resting loop peeks at the flags. The wake (see
/// `set_window_minimized_or_hidden`) is what brings it back at once; the peek is a
/// belt-and-braces for a path that changes visibility without going through it.
const REST_RECHECK_MS: u64 = 1_000;

/// Wakes the sampling loop the moment the window is shown again.
static SHOW_WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

// --- Data Types matching Titlebar HUD and Flyout Table ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessMetric {
    pub pid: u32,
    #[serde(rename = "parentPid")]
    pub parent_pid: u32,
    pub name: String,
    pub role: String, // "host" | "webview" | "geniex" | "voice" | "child"
    pub depth: usize, // 0 for top-level, 1 for subchild
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f64,
    #[serde(rename = "ramBytes")]
    pub ram_bytes: u64,
    #[serde(rename = "ramMB")]
    pub ram_mb: f64,
    #[serde(rename = "ramPercent")]
    pub ram_percent: f64,
    #[serde(rename = "npuPercent")]
    pub npu_percent: f64,
    #[serde(rename = "gpuPercent")]
    pub gpu_percent: f64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FootprintMetric {
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f64,
    #[serde(rename = "ramBytes")]
    pub ram_bytes: u64,
    #[serde(rename = "ramMB")]
    pub ram_mb: f64,
    #[serde(rename = "ramPercent")]
    pub ram_percent: f64,
    #[serde(rename = "npuPercent")]
    pub npu_percent: f64,
    #[serde(rename = "gpuPercent")]
    pub gpu_percent: f64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemCapacityMetric {
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: f64,
    #[serde(rename = "ramTotalBytes")]
    pub ram_total_bytes: u64,
    #[serde(rename = "ramUsedBytes")]
    pub ram_used_bytes: u64,
    #[serde(rename = "ramTotalGB")]
    pub ram_total_gb: f64,
    #[serde(rename = "ramUsedGB")]
    pub ram_used_gb: f64,
    #[serde(rename = "ramPercent")]
    pub ram_percent: f64,
    #[serde(rename = "npuPercent")]
    pub npu_percent: f64,
    #[serde(rename = "gpuPercent")]
    pub gpu_percent: f64,
    /// The system actually has valid NPU counters this sample (an idle 0.0
    /// counts). When false, "0" is not a measurement: the NPU is unavailable.
    #[serde(rename = "npuAvailable")]
    pub npu_available: bool,
    /// Same, for the GPU.
    #[serde(rename = "gpuAvailable")]
    pub gpu_available: bool,
    #[serde(rename = "powerStatus")]
    pub power_status: String,
    /// An ACTIVITY estimate from the app's own CPU share — never a power draw
    /// measurement (M07: the CPU heuristic is not a wattage).
    #[serde(rename = "powerRating")]
    pub power_rating: String,
}

/// One physical engine's reading for the detail view: the adapter it belongs to
/// is part of the identity, and each engine is reported on its own (M01/M02).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineReading {
    /// "gpu" | "npu" | "unknown"
    #[serde(rename = "adapterClass")]
    pub adapter_class: String,
    /// Driver description from the device inventory, when known.
    pub adapter: String,
    pub luid: String,
    pub phys: u32,
    pub eng: u32,
    #[serde(rename = "engineType")]
    pub engine_type: String,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitlebarPills {
    pub power: String,
    #[serde(rename = "powerTooltip")]
    pub power_tooltip: String,
    pub cpu: String,
    #[serde(rename = "cpuVal")]
    pub cpu_val: f64,
    pub gpu: String,
    #[serde(rename = "gpuVal")]
    pub gpu_val: f64,
    pub npu: String,
    #[serde(rename = "npuVal")]
    pub npu_val: f64,
    #[serde(rename = "npuActive")]
    pub npu_active: bool,
    pub ram: String,
    #[serde(rename = "ramVal")]
    pub ram_val: f64,
    #[serde(rename = "ramMB")]
    pub ram_mb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMetricsPayload {
    pub timestamp: u64,
    pub processes: Vec<ProcessMetric>,
    #[serde(rename = "mkmnTotal")]
    pub mkmn_total: FootprintMetric,
    #[serde(rename = "systemTotal")]
    pub system_total: SystemCapacityMetric,
    pub pills: TitlebarPills,
    /// What the RAM numbers ARE: private commit charge, summed per process —
    /// shared pages are counted once, resident working sets are not shown (M06).
    #[serde(rename = "memoryNote")]
    pub memory_note: String,
    /// Tree processes a handle could not be opened for this sample (protected
    /// or exited): they are missing from the table, not at zero (M09).
    #[serde(rename = "unopenedProcesses")]
    pub unopened_processes: u32,
    /// Every physical engine's individual reading (M01: the sum behind any
    /// headline number is never presented as one percentage).
    pub engines: Vec<EngineReading>,
}

impl Default for SystemMetricsPayload {
    fn default() -> Self {
        Self {
            timestamp: 0,
            processes: Vec::new(),
            mkmn_total: FootprintMetric {
                cpu_percent: 0.0,
                ram_bytes: 0,
                ram_mb: 0.0,
                ram_percent: 0.0,
                npu_percent: 0.0,
                gpu_percent: 0.0,
                status: "Standby".to_string(),
            },
            system_total: SystemCapacityMetric {
                cpu_percent: 0.0,
                ram_total_bytes: 34359738368,
                ram_used_bytes: 0,
                ram_total_gb: 32.0,
                ram_used_gb: 0.0,
                ram_percent: 0.0,
                npu_percent: 0.0,
                gpu_percent: 0.0,
                npu_available: false,
                gpu_available: false,
                power_status: "Plugged In".to_string(),
                power_rating: "Activity Low".to_string(),
            },
            pills: TitlebarPills {
                power: "Activity Low".to_string(),
                power_tooltip: "AC Power · Plugged In".to_string(),
                cpu: "CPU 0.0%".to_string(),
                cpu_val: 0.0,
                gpu: "GPU 0.0%".to_string(),
                gpu_val: 0.0,
                npu: "NPU N/A".to_string(),
                npu_val: 0.0,
                npu_active: false,
                ram: "RAM 0.0%".to_string(),
                ram_val: 0.0,
                ram_mb: 0.0,
            },
            memory_note: "Private memory (commit charge); shared pages counted once".to_string(),
            unopened_processes: 0,
            engines: Vec::new(),
        }
    }
}

// --- PDH GPU Sampler Implementation ---

pub struct PdhGpuSampler {
    query: isize,
    counter: isize,
    initialized: bool,
}

impl PdhGpuSampler {
    pub fn new() -> Option<Self> {
        Self::with_counter("\\GPU Engine(*)\\Utilization Percentage")
    }

    /// A sampler of any wildcard counter, by its English path (the NPU memory reading
    /// uses the "GPU Adapter Memory" usage counters).
    pub fn with_counter(path: &str) -> Option<Self> {
        let mut query: isize = 0;
        let status = unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) };
        if status != 0 || query == 0 {
            return None;
        }

        let counter_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut counter: isize = 0;
        let add_status = unsafe {
            PdhAddEnglishCounterW(query, counter_path.as_ptr(), 0, &mut counter)
        };

        if add_status != 0 || counter == 0 {
            unsafe { PdhCloseQuery(query) };
            return None;
        }

        unsafe { PdhCollectQueryData(query) };

        Some(Self {
            query,
            counter,
            initialized: true,
        })
    }

    /// One complete snapshot of the GPU Engine counter set: every instance's
    /// name, cooked value, and PDH status. The classification (which engine is
    /// the GPU's, which the NPU's) happens OUTSIDE, against the adapter
    /// inventory — the sampler is only a counter reader (M02/M04).
    pub fn collect(&mut self) -> Vec<CounterInstance> {
        if !self.initialized || self.query == 0 || self.counter == 0 {
            return Vec::new();
        }

        let status = unsafe { PdhCollectQueryData(self.query) };
        if status != 0 {
            return Vec::new();
        }

        const PDH_FMT_DOUBLE: u32 = 0x00000200;
        const PDH_MORE_DATA: u32 = 0x800007D2;

        let mut buffer_size: u32 = 0;
        let mut item_count: u32 = 0;

        let res = unsafe {
            PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut buffer_size,
                &mut item_count,
                std::ptr::null_mut(),
            )
        };

        if (res != 0 && res != PDH_MORE_DATA) || buffer_size == 0 {
            return Vec::new();
        }

        let mut buffer = vec![0u8; buffer_size as usize];
        let res2 = unsafe {
            PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut buffer_size,
                &mut item_count,
                buffer.as_mut_ptr(),
            )
        };

        if res2 != 0 || item_count == 0 {
            return Vec::new();
        }

        let items = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W,
                item_count as usize,
            )
        };

        let mut instances: Vec<CounterInstance> = Vec::new();
        for item in items {
            if item.sz_name.is_null() {
                continue;
            }

            let mut len = 0;
            while unsafe { *item.sz_name.add(len) } != 0 {
                len += 1;
            }
            let wide_slice = unsafe { std::slice::from_raw_parts(item.sz_name, len) };
            instances.push((
                String::from_utf16_lossy(wide_slice),
                item.fmt_value.double_value,
                item.fmt_value.c_status,
            ));
        }
        instances
    }

    /// NPU verification helper (benchmark and warm-up loops): the busiest NPU
    /// engine one PID contributes to, or None when Windows exposes no valid NPU
    /// counter for it — "the benchmark did not light the NPU" must stay
    /// distinguishable from "the NPU idled at 0" (M05).
    pub fn npu_for_pid(&mut self, pid: u32) -> Option<f64> {
        let instances = self.collect();
        let classified = classify_gpu_counters(&instances, AdapterInventory::shared());
        if !classified.npu.observed {
            return None;
        }
        Some(classified.npu.busiest_for_pid(pid))
    }
}

impl Drop for PdhGpuSampler {
    fn drop(&mut self) {
        if self.query != 0 {
            unsafe { PdhCloseQuery(self.query) };
            self.query = 0;
        }
    }
}

// --- Process Tree Enumeration ---

#[derive(Debug, Clone)]
pub struct RawProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub exe_name: String,
}

pub fn snapshot_processes() -> Vec<RawProcessEntry> {
    let mut list = Vec::new();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
        return list;
    }

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let exe_name = {
                let mut len = 0;
                while len < entry.szExeFile.len() && entry.szExeFile[len] != 0 {
                    len += 1;
                }
                String::from_utf16_lossy(&entry.szExeFile[..len])
            };

            list.push(RawProcessEntry {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
                exe_name,
            });

            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }

    unsafe { CloseHandle(snapshot) };
    list
}

pub fn find_descendant_pids(root_pids: &[u32]) -> (HashSet<u32>, Vec<RawProcessEntry>) {
    let all_procs = snapshot_processes();
    let mut tree_pids: HashSet<u32> = root_pids.iter().cloned().collect();
    let mut parent_map: HashMap<u32, Vec<RawProcessEntry>> = HashMap::with_capacity(all_procs.len());
    let mut root_entries = Vec::new();

    for p in all_procs {
        if tree_pids.contains(&p.pid) {
            root_entries.push(p.clone());
        }
        if p.parent_pid != 0 {
            parent_map.entry(p.parent_pid).or_default().push(p);
        }
    }

    let mut queue = std::collections::VecDeque::from(root_pids.to_vec());
    let mut matched = root_entries;

    while let Some(parent) = queue.pop_front() {
        if let Some(children) = parent_map.remove(&parent) {
            for child in children {
                if tree_pids.insert(child.pid) {
                    queue.push_back(child.pid);
                    matched.push(child);
                }
            }
        }
    }

    (tree_pids, matched)
}

fn is_process_ecoqos(handle: HANDLE) -> bool {
    let mut state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: 0,
        StateMask: 0,
    };
    let ok = unsafe {
        GetProcessInformation(
            handle,
            PROCESS_POWER_THROTTLING_ID,
            &mut state as *mut _ as *mut _,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        )
    };
    if ok != 0 {
        (state.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED) != 0
    } else {
        false
    }
}

fn filetime_to_u64(ft: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

// --- Resource Monitor Engine ---

/// A process's accumulated CPU time keyed by its creation time: two samples of
/// the SAME process. A PID reuse (old process exited, new one took the number)
/// shows up as a different creation time and never produces a bogus delta (M09).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProcTimeKey {
    total: u64,
    creation: u64,
}

/// Per-process CPU percentage over the inter-sample window, or 0.0 for the
/// first sight of a process. Pure so the PID-reuse rule is pinned by tests.
fn proc_cpu_percent(prev: Option<&ProcTimeKey>, creation: u64, cur_total: u64, delta_sys_total: u64) -> f64 {
    match prev {
        // A different creation time means the PID now names a DIFFERENT
        // process: there is no previous sample of THIS one — report 0, not a
        // delta across the reuse.
        Some(p) if p.creation == creation && delta_sys_total > 0 => {
            let delta_proc = cur_total.saturating_sub(p.total);
            ((delta_proc as f64 / delta_sys_total as f64) * 100.0).clamp(0.0, 100.0)
        }
        _ => 0.0,
    }
}

/// The activity label under the power pill. It is an ESTIMATE of how busy the
/// app keeps the machine, derived from the app's own CPU share and the
/// inference flag — never a power draw: no wattage is measured anywhere (M07).
fn activity_rating(app_cpu: f64, is_inferring: bool, battery_saver: bool) -> &'static str {
    if battery_saver || (app_cpu < 10.0 && !is_inferring) {
        "Activity Low"
    } else if app_cpu > 40.0 || (is_inferring && app_cpu > 20.0) {
        "Activity High"
    } else {
        "Activity Moderate"
    }
}

pub struct ResourceMonitor {
    host_pid: u32,
    prev_sys_idle: u64,
    prev_sys_kernel: u64,
    prev_sys_user: u64,
    prev_proc_times: HashMap<u32, ProcTimeKey>,
    pdh_sampler: Option<PdhGpuSampler>,
    /// Cached Windows device inventory (DXCore). Classifies adapters as
    /// GPU / NPU / unknown from device metadata, never from one sample's
    /// engine mix (M04).
    inventory: AdapterInventory,
    _last_sample: Instant,
}

impl ResourceMonitor {
    pub fn new() -> Self {
        let host_pid = unsafe { GetCurrentProcessId() };
        let mut idle_ft = unsafe { std::mem::zeroed() };
        let mut kernel_ft = unsafe { std::mem::zeroed() };
        let mut user_ft = unsafe { std::mem::zeroed() };
        unsafe { GetSystemTimes(&mut idle_ft, &mut kernel_ft, &mut user_ft) };

        Self {
            host_pid,
            prev_sys_idle: filetime_to_u64(idle_ft),
            prev_sys_kernel: filetime_to_u64(kernel_ft),
            prev_sys_user: filetime_to_u64(user_ft),
            prev_proc_times: HashMap::new(),
            pdh_sampler: PdhGpuSampler::new(),
            inventory: AdapterInventory::probe(),
            _last_sample: Instant::now(),
        }
    }

    pub fn sample(
        &mut self,
        supervisor_pid: Option<u32>,
        is_inferring: bool,
        verified_npu: bool,
    ) -> SystemMetricsPayload {
        // Process enumeration EVERY sample: processes (GenieX, webviews, voice)
        // come and go between samples, and a stale tree both shows dead rows and
        // misattributes their engines (M09). The enumeration is the cheap part.
        let mut root_pids = vec![self.host_pid];
        if let Some(sp) = supervisor_pid {
            root_pids.push(sp);
        }
        let (tree_pids, raw_entries) = find_descendant_pids(&root_pids);

        // 1. Calculate System CPU Times
        let mut idle_ft = unsafe { std::mem::zeroed() };
        let mut kernel_ft = unsafe { std::mem::zeroed() };
        let mut user_ft = unsafe { std::mem::zeroed() };
        unsafe { GetSystemTimes(&mut idle_ft, &mut kernel_ft, &mut user_ft) };

        let cur_sys_idle = filetime_to_u64(idle_ft);
        let cur_sys_kernel = filetime_to_u64(kernel_ft);
        let cur_sys_user = filetime_to_u64(user_ft);

        let delta_sys_idle = cur_sys_idle.saturating_sub(self.prev_sys_idle);
        let delta_sys_kernel = cur_sys_kernel.saturating_sub(self.prev_sys_kernel);
        let delta_sys_user = cur_sys_user.saturating_sub(self.prev_sys_user);
        let delta_sys_total = delta_sys_kernel + delta_sys_user;

        self.prev_sys_idle = cur_sys_idle;
        self.prev_sys_kernel = cur_sys_kernel;
        self.prev_sys_user = cur_sys_user;

        let sys_cpu_percent = if delta_sys_total > 0 {
            (1.0 - (delta_sys_idle as f64 / delta_sys_total as f64)) * 100.0
        } else {
            0.0
        }.clamp(0.0, 100.0);

        // 2. Query System Memory
        let mut mem_stat: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        mem_stat.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        unsafe { GlobalMemoryStatusEx(&mut mem_stat) };

        let total_phys_bytes = mem_stat.ullTotalPhys;
        let avail_phys_bytes = mem_stat.ullAvailPhys;
        let used_phys_bytes = total_phys_bytes.saturating_sub(avail_phys_bytes);

        let gb_divisor = 1024.0 * 1024.0 * 1024.0;
        let total_gb = (total_phys_bytes as f64 / gb_divisor * 10.0).round() / 10.0;
        let used_gb = (used_phys_bytes as f64 / gb_divisor * 10.0).round() / 10.0;
        let sys_ram_percent = if total_phys_bytes > 0 {
            (used_phys_bytes as f64 / total_phys_bytes as f64) * 100.0
        } else {
            0.0
        };

        // 3. Sample the GPU Engine counter set and classify it against the
        // device inventory. Every number below comes from the classified
        // physical engines: the busiest engine at each scope, never a sum of
        // independent engines (M01), each attributed to its own adapter (M02).
        let instances: Vec<CounterInstance> = if let Some(ref mut pdh) = self.pdh_sampler {
            pdh.collect()
        } else {
            Vec::new()
        };

        // Re-probe the inventory only when counters name an adapter it has
        // never seen (driver change, or the first probe failed).
        let seen_luids: HashSet<String> = instances.iter().filter_map(|(n, _, _)| luid_key(n)).collect();
        if self.inventory.needs_refresh_for(seen_luids) {
            self.inventory = AdapterInventory::probe();
        }

        let classified: ClassifiedSample = classify_gpu_counters(&instances, &self.inventory);
        let npu_observed = classified.npu.observed;
        let gpu_observed = classified.gpu.observed;

        let sys_gpu = classified.gpu.busiest_engine();
        let sys_npu = classified.npu.busiest_engine();
        // The classified NPU utilization is published for the other readers of the
        // monitor (the resource bar's get_meters_cmd): availability and the number
        // travel together, so an unavailable counter stays null there too.
        publish_npu_utilization(npu_observed, sys_npu);

        // 4. Query Per-Process Metrics
        let mut processes = Vec::new();
        let mut new_proc_times: HashMap<u32, ProcTimeKey> = HashMap::new();
        let mut unopened_processes: u32 = 0;

        for entry in &raw_entries {
            let pid = entry.pid;
            let h_proc = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                    0,
                    pid,
                )
            };

            if h_proc.is_null() || h_proc == INVALID_HANDLE_VALUE {
                unopened_processes += 1;
                continue;
            }

            // CPU (creation time guards against PID reuse — see ProcTimeKey)
            let mut creation_ft = unsafe { std::mem::zeroed() };
            let mut exit_ft = unsafe { std::mem::zeroed() };
            let mut proc_kernel_ft = unsafe { std::mem::zeroed() };
            let mut proc_user_ft = unsafe { std::mem::zeroed() };

            let mut proc_cpu = 0.0;
            if unsafe {
                windows_sys::Win32::System::Threading::GetProcessTimes(
                    h_proc,
                    &mut creation_ft,
                    &mut exit_ft,
                    &mut proc_kernel_ft,
                    &mut proc_user_ft,
                )
            } != 0
            {
                let cur_proc_time = filetime_to_u64(proc_kernel_ft) + filetime_to_u64(proc_user_ft);
                let creation = filetime_to_u64(creation_ft);
                proc_cpu = proc_cpu_percent(
                    self.prev_proc_times.get(&pid),
                    creation,
                    cur_proc_time,
                    delta_sys_total,
                );
                new_proc_times.insert(pid, ProcTimeKey { total: cur_proc_time, creation });
            }

            // Memory (M06): the per-process number is the PRIVATE memory
            // (PrivateUsage) and nothing else. The old working-set fallback
            // silently switched between two different quantities — a small
            // private commit plus a large shared working set is NOT "less used
            // memory" than a big private commit — and the MKMN total summed
            // whatever mixture each process happened to produce. A process
            // whose private commit cannot be read reports 0 rather than being
            // given another quantity's number.
            let mut pmc: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
            pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            let mut ram_used = 0u64;
            if unsafe {
                K32GetProcessMemoryInfo(
                    h_proc,
                    &mut pmc as *mut _ as *mut _,
                    pmc.cb,
                )
            } != 0
            {
                ram_used = pmc.PrivateUsage as u64;
            }

            let ram_mb = (ram_used as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0;
            let ram_percent = if total_phys_bytes > 0 {
                (ram_used as f64 / total_phys_bytes as f64) * 100.0
            } else {
                0.0
            };

            // M09: every role gets its own measured GPU/NPU engine share — the
            // busiest engine THE PROCESS contributes to (Task Manager's
            // per-process convention). Not just GenieX: a webview decoding
            // video or the voice worker on the Adreno GPU is load too.
            let proc_gpu = classified.gpu.busiest_for_pid(pid);
            let proc_npu = classified.npu.busiest_for_pid(pid);

            // Determine Component Role & Status
            let exe_lower = entry.exe_name.to_lowercase();
            let is_host = pid == self.host_pid;
            let is_geniex = Some(pid) == supervisor_pid || exe_lower == "geniex.exe";
            let is_voice = exe_lower.contains("sherpa") || exe_lower.contains("voice");
            let is_webview = exe_lower.contains("msedgewebview2") || exe_lower.contains("webview2");

            let ecoqos = is_process_ecoqos(h_proc);

            let (role, name, depth, status) = if is_host {
                (
                    "host".to_string(),
                    "MKMN Host (Tauri v2 + WebView2)".to_string(),
                    0,
                    if ecoqos { "🍃 EcoQoS".to_string() } else { "Normal".to_string() },
                )
            } else if is_geniex {
                // Status from measured counters only: a measured value needs no
                // inference flag, and with no valid counters the row says so
                // rather than implying a measurement (M05).
                let status_str = if npu_observed && proc_npu > 0.5 {
                    "⚡ Hexagon HTP (Active)".to_string()
                } else if is_inferring && npu_observed {
                    "⚡ Hexagon HTP".to_string()
                } else if is_inferring {
                    "Active (NPU counters unavailable)".to_string()
                } else if verified_npu {
                    "⚡ Hexagon HTP".to_string()
                } else {
                    "Normal".to_string()
                };
                (
                    "geniex".to_string(),
                    "GenieX Inference (geniex.exe)".to_string(),
                    0,
                    status_str,
                )
            } else if is_voice {
                (
                    "voice".to_string(),
                    "Voice Worker (sherpa-onnx)".to_string(),
                    0,
                    if proc_cpu > 0.5 { "Active".to_string() } else { "Standby".to_string() },
                )
            } else if is_webview {
                (
                    "webview".to_string(),
                    "Edge WebView2 Renderer".to_string(),
                    1,
                    if ecoqos { "🍃 EcoQoS".to_string() } else { "Normal".to_string() },
                )
            } else {
                (
                    "child".to_string(),
                    entry.exe_name.clone(),
                    1,
                    if ecoqos { "🍃 EcoQoS".to_string() } else { "Normal".to_string() },
                )
            };

            unsafe { CloseHandle(h_proc) };

            processes.push(ProcessMetric {
                pid,
                parent_pid: entry.parent_pid,
                name,
                role,
                depth,
                cpu_percent: (proc_cpu * 10.0).round() / 10.0,
                ram_bytes: ram_used,
                ram_mb,
                ram_percent: (ram_percent * 10.0).round() / 10.0,
                npu_percent: (proc_npu * 10.0).round() / 10.0,
                gpu_percent: (proc_gpu * 10.0).round() / 10.0,
                status,
            });
        }

        self.prev_proc_times = new_proc_times;

        // Ensure GenieX and Voice Worker are always represented in the table
        if !processes.iter().any(|p| p.role == "geniex") {
            let status = if verified_npu { "⚡ Hexagon HTP".to_string() } else { "Standby".to_string() };
            processes.push(ProcessMetric {
                pid: 0,
                parent_pid: self.host_pid,
                name: "GenieX Inference (geniex.exe)".to_string(),
                role: "geniex".to_string(),
                depth: 0,
                cpu_percent: 0.0,
                ram_bytes: 0,
                ram_mb: 0.0,
                ram_percent: 0.0,
                npu_percent: 0.0,
                gpu_percent: 0.0,
                status,
            });
        }

        if !processes.iter().any(|p| p.role == "voice") {
            processes.push(ProcessMetric {
                pid: 0,
                parent_pid: self.host_pid,
                name: "Voice Worker (sherpa-onnx)".to_string(),
                role: "voice".to_string(),
                depth: 0,
                cpu_percent: 0.0,
                ram_bytes: 0,
                ram_mb: 0.0,
                ram_percent: 0.0,
                npu_percent: 0.0,
                gpu_percent: 0.0,
                status: "Standby".to_string(),
            });
        }

        // Sort processes hierarchically: Host first, then its webviews/children, then GenieX, then Voice
        processes.sort_by(|a, b| {
            let role_order = |r: &str, d: usize| -> (u8, usize) {
                match r {
                    "host" => (0, 0),
                    "webview" => (1, d),
                    "child" => (2, d),
                    "geniex" => (3, 0),
                    "voice" => (4, 0),
                    _ => (5, d),
                }
            };
            role_order(&a.role, a.depth).cmp(&role_order(&b.role, b.depth))
        });

        // 5. Total MKMN Footprint Calculation. CPU and private memory sum over
        // the tree's processes. The GPU/NPU totals do NOT: independent engines
        // are never summed (M01) — the application's share is its busiest
        // engine, each engine's load being the sum of the contributions of the
        // app's processes using it together (M02).
        let mut total_mkmn_cpu = 0.0;
        let mut total_mkmn_ram_bytes = 0u64;

        for p in &processes {
            total_mkmn_cpu += p.cpu_percent;
            total_mkmn_ram_bytes += p.ram_bytes;
        }

        let mkmn_npu = classified.npu.busiest_within(&tree_pids);
        let mkmn_gpu = classified.gpu.busiest_within(&tree_pids);

        let total_mkmn_ram_mb = (total_mkmn_ram_bytes as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0;
        let total_mkmn_ram_percent = if total_phys_bytes > 0 {
            ((total_mkmn_ram_bytes as f64 / total_phys_bytes as f64) * 100.0 * 10.0).round() / 10.0
        } else {
            0.0
        };

        let active_state = is_inferring || total_mkmn_cpu > 2.0;
        let footprint_status = if active_state { "Active".to_string() } else { "Standby".to_string() };

        let mkmn_total = FootprintMetric {
            cpu_percent: (total_mkmn_cpu * 10.0).round() / 10.0,
            ram_bytes: total_mkmn_ram_bytes,
            ram_mb: total_mkmn_ram_mb,
            ram_percent: total_mkmn_ram_percent,
            npu_percent: (mkmn_npu * 10.0).round() / 10.0,
            gpu_percent: (mkmn_gpu * 10.0).round() / 10.0,
            status: footprint_status,
        };

        // 6. Power Status & Activity Rating
        let mut power_status_raw: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        let power_ok = unsafe { GetSystemPowerStatus(&mut power_status_raw) };
        let (is_on_ac, battery_pct, battery_saver) = if power_ok != 0 {
            let ac = power_status_raw.ACLineStatus == 1;
            let batt = if power_status_raw.BatteryLifePercent <= 100 {
                Some(power_status_raw.BatteryLifePercent)
            } else {
                None
            };
            let saver = (power_status_raw.SystemStatusFlag & 1) != 0;
            (ac, batt, saver)
        } else {
            (true, None, false)
        };

        // M07: an activity estimate from the app's own CPU share, honestly
        // named — no wattage heuristic dressed up as a power measurement.
        let power_rating = activity_rating(total_mkmn_cpu, is_inferring, battery_saver).to_string();

        let power_tooltip = if is_on_ac {
            "AC Power · Plugged In".to_string()
        } else if let Some(pct) = battery_pct {
            format!("Battery: {}% · {}", pct, if battery_saver { "Battery Saver" } else { "Discharging" })
        } else {
            "Battery Power".to_string()
        };

        let power_status_desc = if is_on_ac {
            "Plugged In".to_string()
        } else if let Some(pct) = battery_pct {
            format!("Battery ({}%)", pct)
        } else {
            "On Battery".to_string()
        };

        // M03: the system's GPU/NPU numbers are the SYSTEM's busiest engines —
        // they say what the MACHINE is doing and are never copies of the app's
        // own footprint.
        let system_total = SystemCapacityMetric {
            cpu_percent: (sys_cpu_percent * 10.0).round() / 10.0,
            ram_total_bytes: total_phys_bytes,
            ram_used_bytes: used_phys_bytes,
            ram_total_gb: total_gb,
            ram_used_gb: used_gb,
            ram_percent: (sys_ram_percent * 10.0).round() / 10.0,
            npu_percent: (sys_npu * 10.0).round() / 10.0,
            gpu_percent: (sys_gpu * 10.0).round() / 10.0,
            npu_available: npu_observed,
            gpu_available: gpu_observed,
            power_status: power_status_desc,
            power_rating: power_rating.clone(),
        };

        // 7. Titlebar HUD Pills
        // A measured NPU load is shown as it is, however small. With no valid
        // NPU counters the pill admits it has no number ("NPU N/A") rather than
        // showing a measured-looking 0 (M05); during verified inference it
        // shows "?" — active, unknown magnitude.
        let npu_active = (npu_observed && mkmn_total.npu_percent > 0.5)
            || (!npu_observed && is_inferring && verified_npu);
        let npu_display = if npu_observed {
            format!("NPU {:.0}%", mkmn_total.npu_percent)
        } else if npu_active {
            "NPU ?".to_string()
        } else {
            "NPU N/A".to_string()
        };
        // The same honesty for the GPU (M05): an absent or invalid counter is not a
        // measured 0.0% — the pill admits it has no number, as the NPU pill does, and
        // a valid idle zero keeps showing 0.0%.
        let gpu_display = if gpu_observed {
            format!("GPU {:.1}%", mkmn_total.gpu_percent)
        } else {
            "GPU N/A".to_string()
        };

        let pills = TitlebarPills {
            power: power_rating,
            power_tooltip,
            cpu: format!("CPU {:.1}%", mkmn_total.cpu_percent),
            cpu_val: mkmn_total.cpu_percent,
            gpu: gpu_display,
            gpu_val: mkmn_total.gpu_percent,
            npu: npu_display,
            npu_val: mkmn_total.npu_percent,
            npu_active,
            ram: format!("RAM {:.1}%", mkmn_total.ram_percent),
            ram_val: mkmn_total.ram_percent,
            ram_mb: mkmn_total.ram_mb,
        };

        // 8. Per-engine readings for the detail view (M01): every physical
        // engine, on its own line, with its adapter identity.
        let mut engines = Vec::new();
        for (class_name, set) in [
            ("gpu", &classified.gpu),
            ("npu", &classified.npu),
            ("unknown", &classified.unknown),
        ] {
            for (id, load) in set.engine_readings() {
                engines.push(EngineReading {
                    adapter_class: class_name.to_string(),
                    adapter: self.inventory.description_of(&id.luid).unwrap_or("").to_string(),
                    luid: id.luid,
                    phys: id.phys,
                    eng: id.eng,
                    engine_type: id.engtype,
                    percent: (load * 10.0).round() / 10.0,
                });
            }
        }

        SystemMetricsPayload {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            processes,
            mkmn_total,
            system_total,
            pills,
            memory_note: "Private memory (commit charge); shared pages counted once".to_string(),
            unopened_processes,
            engines,
        }
    }
}

impl Default for ResourceMonitor {
    fn default() -> Self {
        Self::new()
    }
}

// --- Background Sampling Loop ---

pub type SharedMetrics = Arc<RwLock<SystemMetricsPayload>>;

pub fn start_monitor_loop(
    app: AppHandle,
    supervisor_state: Arc<RwLock<crate::supervisor::SupervisorState>>,
    metrics_cache: SharedMetrics,
) {
    tauri::async_runtime::spawn(async move {
        let mut monitor = ResourceMonitor::new();
        // Whether the previous tick rested. The tick that leaves a rest samples at once,
        // so the meters are filled the moment the window is shown again.
        let mut rested = false;

        loop {
            let is_min = IS_WINDOW_MINIMIZED_OR_HIDDEN.load(Ordering::Relaxed);
            let is_inferring = IS_INFERRING.load(Ordering::Relaxed);
            // the flag is also a lease: a two-hour-old stamp with no renewal (the sidecar
            // renews it every minute while it lives) has lapsed — a dead sidecar must not
            // keep the monitor awake for ever
            let is_benchmarking = IS_BENCHMARKING.load(Ordering::Relaxed)
                && benchmarking_lease_holds(BENCHMARKING_SINCE_MS.load(Ordering::Relaxed), monotonic_ms());

            // While hidden with nothing running the loop rests: no sample, no emit, only a
            // short peek every REST_RECHECK_MS in case a visibility change skipped the wake.
            // A meter nobody can see is not worth a reading. Showing the window wakes the
            // loop at once (see set_window_minimized_or_hidden), and the first sample then
            // follows with no wait, so the meters fill in immediately instead of a cadence
            // later. While an answer streams or a benchmark runs the readings go on at the
            // hidden cadence: the cache stays fresh for the return, and the utilization the
            // adaptive compute and the benchmark read keeps being published.
            if rests(is_min, is_inferring, is_benchmarking) {
                tokio::select! {
                    _ = SHOW_WAKE.notified() => {},
                    _ = tokio::time::sleep(Duration::from_millis(REST_RECHECK_MS)) => {},
                }
                rested = true;
                continue;
            }

            // A wake from the rest samples at once; an ordinary tick waits its cadence.
            if sleeps_before_sample(rested) {
                let is_focused = IS_WINDOW_FOCUSED.load(Ordering::Relaxed);
                let interval_ms = monitor_interval_ms(is_min, is_focused);
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            }
            rested = false;

            // Fetch current supervisor state
            let (sup_pid, verified_npu) = {
                let s = supervisor_state.read().await;
                (s.pid, s.hw_verification.verified_npu)
            };

            let is_inferring = IS_INFERRING.load(Ordering::Relaxed);

            // Execute low-overhead native Win32/PDH sample (< 0.1% CPU)
            let payload = monitor.sample(sup_pid, is_inferring, verified_npu);

            // Update shared cache
            {
                let mut guard = metrics_cache.write().await;
                *guard = payload.clone();
            }

            // Emit live event to WebView2 frontend — but only when the window can
            // actually show it. While hidden/minimized the sample still refreshes the
            // shared cache (the next show starts with fresh numbers) at no IPC or
            // renderer cost: no listener can render an event it cannot see.
            if !is_min {
                let _ = app.emit("metrics_update", &payload);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resource_monitor_sample() {
        let mut monitor = ResourceMonitor::new();
        std::thread::sleep(Duration::from_millis(200));
        let payload = monitor.sample(None, false, true);

        println!("Sampled payload: CPU={}%, RAM={} MB ({:.1}%), Activity={}",
            payload.mkmn_total.cpu_percent,
            payload.mkmn_total.ram_mb,
            payload.mkmn_total.ram_percent,
            payload.pills.power
        );

        assert!(!payload.processes.is_empty());
        assert!(payload.system_total.ram_total_gb > 0.0);
        assert!(!payload.pills.cpu.is_empty());
        assert!(!payload.memory_note.is_empty());
        // M01: the engine detail table carries physical identity, and no scope
        // presents a sum of independent engines (everything <= 100).
        for e in &payload.engines {
            assert!(e.percent <= 100.0, "engine {} at {}", e.engine_type, e.percent);
            assert!(matches!(e.adapter_class.as_str(), "gpu" | "npu" | "unknown"));
        }
        assert!(payload.mkmn_total.gpu_percent <= 100.0);
        assert!(payload.system_total.gpu_percent <= 100.0);
        assert!(payload.system_total.npu_percent <= 100.0);
    }

    #[test]
    fn test_sampling_overhead_benchmark() {
        let mut monitor = ResourceMonitor::new();
        std::thread::sleep(Duration::from_millis(50));

        // Warm up and take initial snapshot
        let _ = monitor.sample(None, false, true);

        // Measure subsequent steady-state samples
        let start = Instant::now();
        let samples = 5;
        for _ in 0..samples {
            let _ = monitor.sample(None, false, true);
        }
        let total = start.elapsed();
        let avg_ms = total.as_secs_f64() * 1000.0 / samples as f64;
        let duty_percent = (avg_ms / 1800.0) * 100.0;

        println!("Steady-state sampling: {} samples in {:?}, avg: {:.3} ms/sample, CPU overhead: {:.4}%",
            samples, total, avg_ms, duty_percent
        );
    }

    #[test]
    fn test_monitor_interval_policy() {
        // Focused and visible: the live-metrics cadence.
        assert_eq!(monitor_interval_ms(false, true), 1_800);
        // Visible but unfocused: slower, the user is not watching the meters.
        assert_eq!(monitor_interval_ms(false, false), 5_000);
        // Hidden/minimized while an answer streams: slowest, and the emit is skipped
        // entirely in this state (the resting gate handles the idle-hidden case).
        assert_eq!(monitor_interval_ms(true, true), 10_000);
        assert_eq!(monitor_interval_ms(true, false), 10_000);
    }

    #[test]
    fn test_rest_policy() {
        // Hidden and idle: the loop rests — no sample, no emit, only the short peek.
        assert!(rests(true, false, false));
        // Hidden while an answer streams: the readings go on (the cache stays fresh
        // for the return, and the utilization the adaptive compute reads is published).
        assert!(!rests(true, true, false));
        // Hidden while a benchmark runs: the readings go on too — the benchmark is
        // writing on the NPU, and its probes read the published utilization.
        assert!(!rests(true, false, true));
        assert!(!rests(true, true, true));
        // Visible: never rest, the meters are live.
        assert!(!rests(false, false, false));
        assert!(!rests(false, true, false));
        assert!(!rests(false, false, true));
    }

    #[test]
    fn test_sleep_before_sample_policy() {
        // The tick that leaves a rest does not wait: the window was just shown, so its
        // meters fill in at once instead of staying blank for a whole cadence.
        assert!(!sleeps_before_sample(true));
        // Every other tick waits its cadence.
        assert!(sleeps_before_sample(false));
    }

    #[test]
    fn test_npu_reading_freshness_rule() {
        // A sample within the freshness bound is current: the visible window reuses it
        // instead of re-reading the counters. The bound sits above the unfocused cadence
        // (5 000) plus the light sample's time, so a visible window always reuses the
        // monitor's sample.
        const { assert!(NPU_READING_MAX_AGE_MS > 5_000 + LIGHT_SAMPLER_WAIT_MS * 2) };
        assert!(npu_reading_is_current(0));
        assert!(npu_reading_is_current(1_800));
        assert!(npu_reading_is_current(5_000));
        assert!(npu_reading_is_current(NPU_READING_MAX_AGE_MS));
        // Older than the bound it is stale: an old number is not shown as the load now.
        assert!(!npu_reading_is_current(NPU_READING_MAX_AGE_MS + 1));
        assert!(!npu_reading_is_current(60_000));
    }

    #[test]
    fn test_npu_light_interval_rule() {
        // A rate over a near-zero interval is not a measurement (it reads idle on a busy
        // NPU): two samples less than 100 ms apart give no figure.
        assert!(!npu_light_interval_ok(1_000, 1_000));
        assert!(!npu_light_interval_ok(1_000, 1_099));
        assert!(npu_light_interval_ok(1_000, 1_100));
        assert!(npu_light_interval_ok(1_000, 1_250));
        // A fresh pair is taken when there is no previous collection, or one older than
        // the sampler's gap bound.
        assert!(npu_light_needs_pair(0, 1_000));
        assert!(npu_light_needs_pair(500, 500 + LIGHT_SAMPLER_MAX_GAP_MS + 1));
        assert!(!npu_light_needs_pair(500, 500 + LIGHT_SAMPLER_MAX_GAP_MS));
    }

    #[test]
    fn test_benchmarking_lease_rule() {
        // never set: no lease
        assert!(!benchmarking_lease_holds(0, 5_000));
        // set two hours ago and never renewed: lapsed — a dead sidecar must not keep the
        // monitor awake for ever
        assert!(!benchmarking_lease_holds(1_000, 1_000 + BENCHMARKING_LEASE_MS + 1));
        // just inside the lease: it holds
        assert!(benchmarking_lease_holds(1_000, 1_000 + BENCHMARKING_LEASE_MS));
        // the lease is stamped when the flag goes on and cleared when it goes off (the
        // sidecar's own end of run, and the exit path of a dead sidecar, both call it)
        set_benchmarking(true);
        assert!(IS_BENCHMARKING.load(Ordering::Relaxed));
        assert!(benchmarking_lease_holds(BENCHMARKING_SINCE_MS.load(Ordering::Relaxed), monotonic_ms()));
        set_benchmarking(false);
        assert!(!IS_BENCHMARKING.load(Ordering::Relaxed));
        assert!(!benchmarking_lease_holds(BENCHMARKING_SINCE_MS.load(Ordering::Relaxed), monotonic_ms()));
    }

    #[tokio::test]
    async fn showing_the_window_wakes_the_resting_loop_at_once() {
        set_window_minimized_or_hidden(true);
        let wait = SHOW_WAKE.notified();
        tokio::pin!(wait);
        let start = Instant::now();
        set_window_minimized_or_hidden(false);
        tokio::select! {
            _ = &mut wait => {},
            _ = tokio::time::sleep(Duration::from_millis(100)) => panic!("showing the window did not wake the resting loop"),
        }
        println!("the resting loop woke {} after the window was shown", start.elapsed().as_secs_f64() * 1000.0);
    }

    /// M09: a PID whose creation time changed is a DIFFERENT process — the
    /// delta must not bridge the reuse.
    #[test]
    fn test_pid_reuse_does_not_bridge_deltas() {
        let old = ProcTimeKey { total: 1_000_000, creation: 111 };
        let delta_sys = 10_000_000u64;
        // same process: normal delta
        let same = proc_cpu_percent(Some(&old), 111, 1_500_000, delta_sys);
        assert!((same - 5.0).abs() < 1e-9);
        // reused PID: creation time differs — treated as a first sample
        let reused = proc_cpu_percent(Some(&old), 999, 50_000, delta_sys);
        assert_eq!(reused, 0.0);
        // first sight: no previous key
        assert_eq!(proc_cpu_percent(None, 111, 500_000, delta_sys), 0.0);
        // zero system delta avoids a division blow-up
        assert_eq!(proc_cpu_percent(Some(&old), 111, 1_500_000, 0), 0.0);
    }

    /// M07: the rating is an activity estimate, honestly named.
    #[test]
    fn test_activity_rating() {
        assert_eq!(activity_rating(2.0, false, false), "Activity Low");
        assert_eq!(activity_rating(2.0, false, true), "Activity Low", "battery saver always reads low");
        assert_eq!(activity_rating(25.0, false, false), "Activity Moderate");
        assert_eq!(activity_rating(41.0, false, false), "Activity High");
        assert_eq!(activity_rating(25.0, true, false), "Activity High");
    }

    /// M03 contract: system and app totals come from DIFFERENT scopes. Pinned
    /// on the default payload (both zero but independently so) and on the
    /// payload struct shape the renderer consumes.
    #[test]
    fn test_default_payload_honest_unavailability() {
        let d = SystemMetricsPayload::default();
        // M05: no counters -> "N/A", not a measured-looking 0%.
        assert_eq!(d.pills.npu, "NPU N/A");
        assert!(!d.pills.npu_active);
        assert!(!d.system_total.npu_available);
        assert!(!d.system_total.gpu_available);
    }
}
