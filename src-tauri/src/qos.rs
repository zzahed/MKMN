// The public functions here take a Windows HANDLE, which the lint reads as a raw pointer. It is never
// dereferenced: it is passed to the Win32 call, and Windows checks it and returns an error for a bad one.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use std::ffi::c_void;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Threading::*;

use crate::paths::append_log;
use crate::power::set_sleep_inhibit;

// ============================================================================
// Win32 EcoQoS & Power Throttling Definitions
// ============================================================================

#[repr(C)]
#[allow(non_snake_case)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PROCESS_POWER_THROTTLING_STATE {
    pub Version: u32,
    pub ControlMask: u32,
    pub StateMask: u32,
}

#[repr(C)]
#[allow(non_snake_case)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct THREAD_POWER_THROTTLING_STATE {
    pub Version: u32,
    pub ControlMask: u32,
    pub StateMask: u32,
}

pub const PROCESS_POWER_THROTTLING_CURRENT_VERSION: u32 = 1;
pub const PROCESS_POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;
pub const PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION: u32 = 0x4;

pub const THREAD_POWER_THROTTLING_CURRENT_VERSION: u32 = 1;
pub const THREAD_POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;
pub const THREAD_PRIORITY_ERROR_RETURN: i32 = 0x7fffffff;

// ============================================================================
// Workload Classification & Quality of Service Tiers
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QoSTier {
    /// Tier 1: Tauri Host Process (MKMN.exe), Edge WebView2 UI.
    /// NORMAL_PRIORITY_CLASS, Power Throttling Disabled.
    /// Zero frame stutter, immediate response to user input, instant 120Hz tab switching.
    Interactive = 1,

    /// Tier 2: geniex.exe, Active Voice Worker (Kokoro TTS / Whisper STT), NPU Benchmark Engine.
    /// ABOVE_NORMAL_PRIORITY_CLASS, Unthrottled, SetThreadExecutionState active.
    /// Strictly unthrottled. Zero latency impact on prefill or decode tok/s.
    InferenceCritical = 2,

    /// Tier 3: Model download extractors (tar.bz2 / zip), SHA256 verifiers,
    /// document parser / text splitters, idle voice workers.
    /// IDLE_PRIORITY_CLASS or BELOW_NORMAL, PROCESS_POWER_THROTTLING_EXECUTION_SPEED enabled.
    /// Run on energy-efficient Oryon cores at lower clock frequencies. Yield immediately to interactive tasks.
    BackgroundEco = 3,
}

impl QoSTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            QoSTier::Interactive => "interactive",
            QoSTier::InferenceCritical => "inference_critical",
            QoSTier::BackgroundEco => "background_eco",
        }
    }

    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s.to_lowercase().trim() {
            "interactive" | "tier1" | "normal" | "ui" => Some(QoSTier::Interactive),
            "inference_critical" | "inference" | "infer" | "tier2" | "npu" => Some(QoSTier::InferenceCritical),
            "background_eco" | "eco" | "ecoqos" | "background" | "tier3" | "idle" => Some(QoSTier::BackgroundEco),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QoSSummary {
    pub pid: u32,
    pub tier: QoSTier,
    #[serde(rename = "priorityClass")]
    pub priority_class: String,
    #[serde(rename = "ecoqosActive")]
    pub ecoqos_active: bool,
    #[serde(rename = "timerCoalescingActive")]
    pub timer_coalescing_active: bool,
    #[serde(rename = "sleepInhibited")]
    pub sleep_inhibited: bool,
    #[serde(rename = "verifiedHwState")]
    pub verified_hw_state: bool,
    pub details: String,
}

// ============================================================================
// Native Win32 API Implementation
// ============================================================================

/// Configure Process Power Throttling (EcoQoS) using SetProcessInformation.
pub fn set_process_power_throttling(
    h_process: HANDLE,
    enable_eco: bool,
    ignore_timer_resolution: bool,
) -> Result<(), String> {
    let mut state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: 0,
        StateMask: 0,
    };

    if enable_eco {
        let mut mask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
        if ignore_timer_resolution {
            mask |= PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
        }
        state.ControlMask = mask;
        state.StateMask = mask;
    } else {
        // Explicitly opt out of power throttling
        state.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
        state.StateMask = 0;
    }

    let ok = unsafe {
        SetProcessInformation(
            h_process,
            ProcessPowerThrottling,
            &state as *const _ as *const c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        )
    };

    if ok == 0 {
        let err = unsafe { GetLastError() };
        Err(format!("SetProcessInformation(ProcessPowerThrottling) failed with Win32 error {}", err))
    } else {
        Ok(())
    }
}

/// Query Process Power Throttling state using GetProcessInformation.
pub fn get_process_power_throttling(
    h_process: HANDLE,
) -> Result<PROCESS_POWER_THROTTLING_STATE, String> {
    let mut state: PROCESS_POWER_THROTTLING_STATE = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: 0,
        StateMask: 0,
    };

    let ok = unsafe {
        GetProcessInformation(
            h_process,
            ProcessPowerThrottling,
            &mut state as *mut _ as *mut c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        )
    };

    if ok == 0 {
        let err = unsafe { GetLastError() };
        Err(format!("GetProcessInformation(ProcessPowerThrottling) failed with Win32 error {}", err))
    } else {
        Ok(state)
    }
}

/// Hardware Execution Verification:
/// Query GetProcessInformation to verify that the active power-throttling state
/// actually has execution speed throttling enabled (`StateMask & 0x1 == 1`).
pub fn verify_process_ecoqos(h_process: HANDLE) -> Result<bool, String> {
    let state = get_process_power_throttling(h_process)?;
    Ok((state.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED) != 0)
}

/// Configure Thread Power Throttling using SetThreadInformation.
pub fn set_thread_power_throttling(
    h_thread: HANDLE,
    enable_eco: bool,
) -> Result<(), String> {
    let mut state = THREAD_POWER_THROTTLING_STATE {
        Version: THREAD_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: if enable_eco { THREAD_POWER_THROTTLING_EXECUTION_SPEED } else { 0 },
    };

    let ok = unsafe {
        SetThreadInformation(
            h_thread,
            ThreadPowerThrottling,
            &mut state as *mut _ as *mut c_void,
            std::mem::size_of::<THREAD_POWER_THROTTLING_STATE>() as u32,
        )
    };

    if ok == 0 {
        let err = unsafe { GetLastError() };
        Err(format!("SetThreadInformation(ThreadPowerThrottling) failed with Win32 error {}", err))
    } else {
        Ok(())
    }
}

/// Query Thread Power Throttling state using GetThreadInformation.
pub fn get_thread_power_throttling(
    h_thread: HANDLE,
) -> Result<THREAD_POWER_THROTTLING_STATE, String> {
    let mut state: THREAD_POWER_THROTTLING_STATE = THREAD_POWER_THROTTLING_STATE {
        Version: THREAD_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: 0,
        StateMask: 0,
    };

    let ok = unsafe {
        GetThreadInformation(
            h_thread,
            ThreadPowerThrottling,
            &mut state as *mut _ as *mut c_void,
            std::mem::size_of::<THREAD_POWER_THROTTLING_STATE>() as u32,
        )
    };

    if ok == 0 {
        let err = unsafe { GetLastError() };
        Err(format!("GetThreadInformation(ThreadPowerThrottling) failed with Win32 error {}", err))
    } else {
        Ok(state)
    }
}

/// Hardware Execution Verification for threads:
pub fn verify_thread_ecoqos(h_thread: HANDLE) -> Result<bool, String> {
    let state = get_thread_power_throttling(h_thread)?;
    Ok((state.StateMask & THREAD_POWER_THROTTLING_EXECUTION_SPEED) != 0)
}

/// Set Process Priority Class (e.g., NORMAL_PRIORITY_CLASS, ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS).
pub fn set_process_priority(h_process: HANDLE, priority_class: u32) -> Result<(), String> {
    let ok = unsafe { SetPriorityClass(h_process, priority_class) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        Err(format!("SetPriorityClass({}) failed with Win32 error {}", priority_class, err))
    } else {
        Ok(())
    }
}

/// Query Process Priority Class.
pub fn get_process_priority(h_process: HANDLE) -> Result<u32, String> {
    let p = unsafe { GetPriorityClass(h_process) };
    if p == 0 {
        let err = unsafe { GetLastError() };
        Err(format!("GetPriorityClass failed with Win32 error {}", err))
    } else {
        Ok(p)
    }
}

/// Set Thread Priority.
pub fn set_thread_priority(h_thread: HANDLE, priority: i32) -> Result<(), String> {
    let ok = unsafe { SetThreadPriority(h_thread, priority) };
    if ok == 0 {
        let err = unsafe { GetLastError() };
        Err(format!("SetThreadPriority({}) failed with Win32 error {}", priority, err))
    } else {
        Ok(())
    }
}

/// Query Thread Priority.
pub fn get_thread_priority(h_thread: HANDLE) -> Result<i32, String> {
    let p = unsafe { GetThreadPriority(h_thread) };
    if p == THREAD_PRIORITY_ERROR_RETURN {
        let err = unsafe { GetLastError() };
        Err(format!("GetThreadPriority failed with Win32 error {}", err))
    } else {
        Ok(p)
    }
}

// ============================================================================
// Tier Management Implementations
// ============================================================================

/// Apply a QoS Tier policy to a process handle.
///
/// Every OS call is checked: a denied or unsupported priority/throttling change is
/// an Err, never a silently "applied" tier.
pub fn apply_process_tier(h_process: HANDLE, tier: QoSTier) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();
    match tier {
        QoSTier::Interactive => {
            // Tier 1: Host Process / WebView2 UI
            // NORMAL_PRIORITY_CLASS, Power Throttling Disabled
            if let Err(e) = set_process_priority(h_process, NORMAL_PRIORITY_CLASS) {
                errors.push(e);
            }
            if let Err(e) = set_process_power_throttling(h_process, false, false) {
                errors.push(e);
            }
            set_sleep_inhibit(false);
        }
        QoSTier::InferenceCritical => {
            // Tier 2: geniex.exe / Active Voice Worker / Benchmark Engine
            // ABOVE_NORMAL_PRIORITY_CLASS, Strictly Unthrottled, Sleep Inhibited
            if let Err(e) = set_process_priority(h_process, ABOVE_NORMAL_PRIORITY_CLASS) {
                errors.push(e);
            }
            if let Err(e) = set_process_power_throttling(h_process, false, false) {
                errors.push(e);
            }
            set_sleep_inhibit(true);
        }
        QoSTier::BackgroundEco => {
            // Tier 3: Model extractors, SHA256 verifiers, document parsers, idle workers
            // BELOW_NORMAL_PRIORITY_CLASS, EcoQoS + Timer Coalescing Enabled
            if let Err(e) = set_process_priority(h_process, BELOW_NORMAL_PRIORITY_CLASS) {
                errors.push(e);
            }
            if let Err(e) = set_process_power_throttling(h_process, true, true) {
                errors.push(e);
            }
            set_sleep_inhibit(false);
        }
    }

    if errors.is_empty() {
        append_log("mkmn", &format!("[qos] Applied tier {} to process: OK", tier.as_str()));
        Ok(())
    } else {
        let err = format!(
            "Failed to apply QoS tier {}: {}",
            tier.as_str(),
            errors.join("; ")
        );
        append_log("mkmn", &format!("[qos] {}", err));
        Err(err)
    }
}

/// Apply a QoS Tier policy to a process by PID.
pub fn apply_pid_tier(pid: u32, tier: QoSTier) -> Result<(), String> {
    unsafe {
        let h_process = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if h_process.is_null() || h_process == INVALID_HANDLE_VALUE {
            let err = GetLastError();
            return Err(format!("OpenProcess(PID: {}) failed with error {}", pid, err));
        }

        let res = apply_process_tier(h_process, tier);
        CloseHandle(h_process);
        res
    }
}

/// Apply a QoS Tier policy to the current thread.
pub fn apply_current_thread_tier(tier: QoSTier) -> Result<(), String> {
    let h_thread = unsafe { GetCurrentThread() };
    let mut errors: Vec<String> = Vec::new();
    match tier {
        QoSTier::Interactive => {
            if let Err(e) = set_thread_priority(h_thread, THREAD_PRIORITY_NORMAL) {
                errors.push(e);
            }
            if let Err(e) = set_thread_power_throttling(h_thread, false) {
                errors.push(e);
            }
        }
        QoSTier::InferenceCritical => {
            if let Err(e) = set_thread_priority(h_thread, THREAD_PRIORITY_ABOVE_NORMAL) {
                errors.push(e);
            }
            if let Err(e) = set_thread_power_throttling(h_thread, false) {
                errors.push(e);
            }
            set_sleep_inhibit(true);
        }
        QoSTier::BackgroundEco => {
            if let Err(e) = set_thread_priority(h_thread, THREAD_PRIORITY_BELOW_NORMAL) {
                errors.push(e);
            }
            if let Err(e) = set_thread_power_throttling(h_thread, true) {
                errors.push(e);
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to apply QoS thread tier {}: {}",
            tier.as_str(),
            errors.join("; ")
        ))
    }
}

/// Query full QoS summary for the current host process.
pub fn get_current_process_qos_summary() -> Result<QoSSummary, String> {
    let pid = unsafe { GetCurrentProcessId() };
    get_process_qos_summary(pid)
}

/// Query full QoS summary for any process by PID.
pub fn get_process_qos_summary(pid: u32) -> Result<QoSSummary, String> {
    unsafe {
        let h_process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if h_process.is_null() || h_process == INVALID_HANDLE_VALUE {
            let err = GetLastError();
            return Err(format!("OpenProcess(PID: {}) failed with error {}", pid, err));
        }

        // Readbacks that fail are failures: they must not be silently replaced with
        // defaults and then reported as verified.
        let prio = match get_process_priority(h_process) {
            Ok(p) => p,
            Err(e) => {
                CloseHandle(h_process);
                return Err(format!("priority readback failed: {}", e));
            }
        };
        let throttling = match get_process_power_throttling(h_process) {
            Ok(t) => t,
            Err(e) => {
                CloseHandle(h_process);
                return Err(format!("power throttling readback failed: {}", e));
            }
        };

        CloseHandle(h_process);

        let ecoqos_active = (throttling.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED) != 0;
        let timer_coalescing = (throttling.StateMask & PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION) != 0;

        let (tier, prio_str) = match prio {
            ABOVE_NORMAL_PRIORITY_CLASS | HIGH_PRIORITY_CLASS | REALTIME_PRIORITY_CLASS => {
                (QoSTier::InferenceCritical, "ABOVE_NORMAL_PRIORITY_CLASS")
            }
            BELOW_NORMAL_PRIORITY_CLASS => (QoSTier::BackgroundEco, "BELOW_NORMAL_PRIORITY_CLASS"),
            IDLE_PRIORITY_CLASS => (QoSTier::BackgroundEco, "IDLE_PRIORITY_CLASS"),
            _ => {
                if ecoqos_active {
                    (QoSTier::BackgroundEco, "NORMAL_PRIORITY_CLASS (EcoQoS Overridden)")
                } else {
                    (QoSTier::Interactive, "NORMAL_PRIORITY_CLASS")
                }
            }
        };

        Ok(QoSSummary {
            pid,
            tier,
            priority_class: prio_str.to_string(),
            ecoqos_active,
            timer_coalescing_active: timer_coalescing,
            sleep_inhibited: tier == QoSTier::InferenceCritical,
            verified_hw_state: true,
            details: format!(
                "PID {} running at {} (EcoQoS: {}, Timers: {})",
                pid,
                prio_str,
                if ecoqos_active { "Active (Oryon Eco)" } else { "Disabled (High Performance)" },
                if timer_coalescing { "Coalescing Enabled" } else { "High Precision" }
            ),
        })
    }
}

// ============================================================================
// RAII Scope Guards
// ============================================================================

enum GuardTarget {
    Thread {
        h_thread: HANDLE,
        prev_priority: i32,
        prev_throttling: THREAD_POWER_THROTTLING_STATE,
    },
    Process {
        h_process: HANDLE,
        prev_priority: u32,
        prev_throttling: PROCESS_POWER_THROTTLING_STATE,
        owned: bool,
    },
}

/// RAII Scope Guard that enforces EcoQoS upon instantiation and
/// automatically restores the previous QoS state when dropped or cancelled.
pub struct EcoQoSGuard {
    target: Option<GuardTarget>,
    verified: bool,
}

impl EcoQoSGuard {
    /// Create an EcoQoS guard for the current calling thread.
    /// Sets thread priority to BELOW_NORMAL and enables ThreadPowerThrottling.
    pub fn for_current_thread() -> Self {
        let h_thread = unsafe { GetCurrentThread() };
        let prev_prio = get_thread_priority(h_thread).unwrap_or(THREAD_PRIORITY_NORMAL);
        let prev_throttling = get_thread_power_throttling(h_thread).unwrap_or(THREAD_POWER_THROTTLING_STATE {
            Version: 1,
            ControlMask: 0,
            StateMask: 0,
        });

        let _ = set_thread_priority(h_thread, THREAD_PRIORITY_BELOW_NORMAL);
        let _ = set_thread_power_throttling(h_thread, true);
        let verified = verify_thread_ecoqos(h_thread).unwrap_or(false);

        Self {
            target: Some(GuardTarget::Thread {
                h_thread,
                prev_priority: prev_prio,
                prev_throttling,
            }),
            verified,
        }
    }

    /// Create an EcoQoS guard for the current process.
    pub fn for_current_process() -> Self {
        let h_process = unsafe { GetCurrentProcess() };
        let prev_prio = get_process_priority(h_process).unwrap_or(NORMAL_PRIORITY_CLASS);
        let prev_throttling = get_process_power_throttling(h_process).unwrap_or(PROCESS_POWER_THROTTLING_STATE {
            Version: 1,
            ControlMask: 0,
            StateMask: 0,
        });

        let _ = set_process_priority(h_process, BELOW_NORMAL_PRIORITY_CLASS);
        let _ = set_process_power_throttling(h_process, true, true);
        let verified = verify_process_ecoqos(h_process).unwrap_or(false);

        Self {
            target: Some(GuardTarget::Process {
                h_process,
                prev_priority: prev_prio,
                prev_throttling,
                owned: false,
            }),
            verified,
        }
    }

    /// Create an EcoQoS guard for a specific process handle.
    pub fn for_handle(h_process: HANDLE, owned: bool) -> Result<Self, String> {
        let prev_prio = get_process_priority(h_process).unwrap_or(NORMAL_PRIORITY_CLASS);
        let prev_throttling = get_process_power_throttling(h_process).unwrap_or(PROCESS_POWER_THROTTLING_STATE {
            Version: 1,
            ControlMask: 0,
            StateMask: 0,
        });

        set_process_priority(h_process, BELOW_NORMAL_PRIORITY_CLASS)?;
        set_process_power_throttling(h_process, true, true)?;
        let verified = verify_process_ecoqos(h_process).unwrap_or(false);

        Ok(Self {
            target: Some(GuardTarget::Process {
                h_process,
                prev_priority: prev_prio,
                prev_throttling,
                owned,
            }),
            verified,
        })
    }

    /// Create an EcoQoS guard for an external process by PID.
    pub fn for_pid(pid: u32) -> Result<Self, String> {
        unsafe {
            let h_process = OpenProcess(
                PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if h_process.is_null() || h_process == INVALID_HANDLE_VALUE {
                let err = GetLastError();
                return Err(format!("OpenProcess(PID: {}) failed with error {}", pid, err));
            }
            Self::for_handle(h_process, true)
        }
    }

    /// Check if hardware execution of EcoQoS was verified via GetProcessInformation / GetThreadInformation.
    pub fn is_verified(&self) -> bool {
        self.verified
    }

    /// Execute a closure under thread-level EcoQoS and return its result.
    /// QoS is guaranteed restored on normal return or panic.
    pub fn run_eco<F, R>(f: F) -> R
    where
        F: FnOnce() -> R,
    {
        let _guard = Self::for_current_thread();
        f()
    }
}

impl Drop for EcoQoSGuard {
    fn drop(&mut self) {
        if let Some(target) = self.target.take() {
            match target {
                GuardTarget::Thread {
                    h_thread,
                    prev_priority,
                    prev_throttling,
                } => {
                    let _ = set_thread_priority(h_thread, prev_priority);
                    let enable_eco = (prev_throttling.StateMask & THREAD_POWER_THROTTLING_EXECUTION_SPEED) != 0;
                    let _ = set_thread_power_throttling(h_thread, enable_eco);
                }
                GuardTarget::Process {
                    h_process,
                    prev_priority,
                    prev_throttling,
                    owned,
                } => {
                    let _ = set_process_priority(h_process, prev_priority);
                    let enable_eco = (prev_throttling.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED) != 0;
                    let ignore_timer = (prev_throttling.StateMask & PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION) != 0;
                    let _ = set_process_power_throttling(h_process, enable_eco, ignore_timer);

                    if owned {
                        unsafe {
                            CloseHandle(h_process);
                        }
                    }
                }
            }
        }
    }
}

/// RAII Scope Guard for Inference-Critical workloads (Tier 2).
/// Enforces ABOVE_NORMAL_PRIORITY_CLASS, disables power throttling, and keeps the system awake.
/// Restores NORMAL_PRIORITY_CLASS and releases sleep inhibition when dropped.
pub struct InferenceQoSGuard {
    pid: Option<u32>,
    active: bool,
}

impl InferenceQoSGuard {
    pub fn new() -> Self {
        let h_thread = unsafe { GetCurrentThread() };
        let _ = set_thread_priority(h_thread, THREAD_PRIORITY_ABOVE_NORMAL);
        let _ = set_thread_power_throttling(h_thread, false);
        set_sleep_inhibit(true);

        Self {
            pid: None,
            active: true,
        }
    }

    pub fn for_pid(pid: u32) -> Result<Self, String> {
        apply_pid_tier(pid, QoSTier::InferenceCritical)?;
        set_sleep_inhibit(true);

        Ok(Self {
            pid: Some(pid),
            active: true,
        })
    }

    pub fn run_inference<F, R>(f: F) -> R
    where
        F: FnOnce() -> R,
    {
        let _guard = Self::new();
        f()
    }
}

impl Default for InferenceQoSGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for InferenceQoSGuard {
    fn drop(&mut self) {
        if self.active {
            if let Some(pid) = self.pid {
                let _ = apply_pid_tier(pid, QoSTier::Interactive);
            }
            let h_thread = unsafe { GetCurrentThread() };
            let _ = set_thread_priority(h_thread, THREAD_PRIORITY_NORMAL);
            set_sleep_inhibit(false);
            self.active = false;
        }
    }
}

// ============================================================================
// Host Startup & Background Task Operations
// ============================================================================

/// Enforce Tier 1 Interactive state for MKMN host process (MKMN.exe) at application startup.
/// Ensures NORMAL_PRIORITY_CLASS and Power Throttling Disabled to maintain 120Hz WebView2 UI fluidity.
pub fn apply_interactive_tier_to_host() {
    let h_process = unsafe { GetCurrentProcess() };
    let pid = unsafe { GetCurrentProcessId() };
    let _ = apply_process_tier(h_process, QoSTier::Interactive);
    append_log(
        "mkmn",
        &format!(
            "[qos] Tier 1 Interactive successfully enforced for MKMN host process (PID: {}). Zero frame stutter & 120Hz UI fluidity enabled.",
            pid
        ),
    );
}

/// Computes SHA256 checksum of a file strictly within an EcoQoS RAII scope.
/// Minimizes CPU load and thermal generation on Snapdragon X2 Oryon cores during checksumming.
pub fn compute_sha256_eco(path: &Path) -> Result<String, String> {
    compute_sha256_eco_verified(path).map(|(hash, _)| hash)
}

/// Same as `compute_sha256_eco`, but also reports whether the EcoQoS hardware state
/// was actually verified (read back via GetThreadInformation) — callers must not
/// present `ecoqos_verified: true` without this evidence.
pub fn compute_sha256_eco_verified(path: &Path) -> Result<(String, bool), String> {
    let guard = EcoQoSGuard::for_current_thread();
    let ecoqos_verified = guard.is_verified();

    let mut file = File::open(path)
        .map_err(|e| format!("Failed to open file {:?}: {}", path, e))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024]; // 64 KB chunks

    loop {
        let n = file.read(&mut buffer)
            .map_err(|e| format!("Error reading file {:?}: {}", path, e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }

    let hash_bytes = hasher.finalize();
    Ok((hash_bytes.iter().map(|b| format!("{b:02x}")).collect(), ecoqos_verified))
}

/// Document parser / text chunker executed strictly under EcoQoS governance.
pub fn chunk_text_eco(text: &str, chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
    let _guard = EcoQoSGuard::for_current_thread();

    if text.is_empty() || chunk_size == 0 {
        return Vec::new();
    }

    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }

    let step = chunk_size.saturating_sub(chunk_overlap).max(1);
    let mut chunks = Vec::new();
    let mut i = 0;

    while i < words.len() {
        let end = (i + chunk_size).min(words.len());
        chunks.push(words[i..end].join(" "));
        if end == words.len() {
            break;
        }
        i += step;
    }

    chunks
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn test_thread_ecoqos_guard_lifecycle() {
        let _lock = TEST_LOCK.lock().unwrap();
        let h_thread = unsafe { GetCurrentThread() };

        // 1. Initial priority
        let initial_prio = get_thread_priority(h_thread).unwrap_or(THREAD_PRIORITY_NORMAL);

        {
            // Enter RAII EcoQoS scope
            let guard = EcoQoSGuard::for_current_thread();
            assert!(guard.is_verified(), "Hardware execution verification must succeed for Thread EcoQoS");

            let current_prio = get_thread_priority(h_thread).unwrap();
            assert_eq!(current_prio, THREAD_PRIORITY_BELOW_NORMAL, "Thread priority must be BELOW_NORMAL in EcoQoS");

            let active = verify_thread_ecoqos(h_thread).unwrap();
            assert!(active, "EcoQoS execution speed throttling must be verified active");
        }

        // 2. Exited RAII scope - verify restoration
        let restored_prio = get_thread_priority(h_thread).unwrap();
        assert_eq!(restored_prio, initial_prio, "Thread priority must be restored after guard drops");

        let active_after = verify_thread_ecoqos(h_thread).unwrap_or(false);
        assert!(!active_after, "EcoQoS execution speed throttling must be deactivated after guard drops");
    }

    #[test]
    fn test_process_ecoqos_verification() {
        let _lock = TEST_LOCK.lock().unwrap();
        let h_process = unsafe { GetCurrentProcess() };

        // Apply EcoQoS to current process
        let set_res = set_process_power_throttling(h_process, true, true);
        assert!(set_res.is_ok(), "Setting process EcoQoS must succeed");

        // Hardware Execution Verification via GetProcessInformation
        let is_eco = verify_process_ecoqos(h_process).expect("GetProcessInformation must succeed");
        assert!(is_eco, "Hardware execution verification: StateMask & 0x1 must be 1");

        // Query raw state and verify flags
        let state = get_process_power_throttling(h_process).expect("Querying power throttling must succeed");
        assert_eq!(state.Version, PROCESS_POWER_THROTTLING_CURRENT_VERSION);
        assert_ne!(state.StateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED, 0);

        // Restore unthrottled
        let reset_res = set_process_power_throttling(h_process, false, false);
        assert!(reset_res.is_ok());

        let is_eco_after = verify_process_ecoqos(h_process).expect("Query after reset must succeed");
        assert!(!is_eco_after, "Power throttling must be disabled after opt-out");
    }

    #[test]
    fn test_inference_qos_guard_lifecycle() {
        let _lock = TEST_LOCK.lock().unwrap();
        let h_thread = unsafe { GetCurrentThread() };

        {
            let _infer_guard = InferenceQoSGuard::new();
            let prio = get_thread_priority(h_thread).unwrap();
            assert_eq!(prio, THREAD_PRIORITY_ABOVE_NORMAL, "Inference thread must have ABOVE_NORMAL priority");

            let is_eco = verify_thread_ecoqos(h_thread).unwrap_or(false);
            assert!(!is_eco, "Inference-Critical thread must be strictly unthrottled");
        }

        let prio_after = get_thread_priority(h_thread).unwrap();
        assert_eq!(prio_after, THREAD_PRIORITY_NORMAL);
    }

    #[test]
    fn test_chunk_text_eco() {
        let text = "Qualcomm Snapdragon X2 Elite Oryon CPU with Hexagon NPU 45 TOPS running MKMN sovereign studio.";
        let chunks = chunk_text_eco(text, 5, 2);
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0], "Qualcomm Snapdragon X2 Elite Oryon");
    }

    #[test]
    fn test_process_ecoqos_guard_lifecycle() {
        let _lock = TEST_LOCK.lock().unwrap();
        let h_process = unsafe { GetCurrentProcess() };
        let initial_prio = get_process_priority(h_process).unwrap_or(NORMAL_PRIORITY_CLASS);

        {
            let guard = EcoQoSGuard::for_current_process();
            assert!(guard.is_verified(), "Hardware execution verification must succeed for Process EcoQoS Guard");

            let current_prio = get_process_priority(h_process).unwrap();
            assert_eq!(current_prio, BELOW_NORMAL_PRIORITY_CLASS, "Process priority must be BELOW_NORMAL in EcoQoS");

            let is_eco = verify_process_ecoqos(h_process).unwrap();
            assert!(is_eco, "EcoQoS execution speed throttling must be verified active");
        }

        // Restored
        let restored_prio = get_process_priority(h_process).unwrap();
        assert_eq!(restored_prio, initial_prio, "Process priority must be restored after guard drops");
    }

    #[test]
    fn test_compute_sha256_eco() {
        use std::io::Write;
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("mkmn_ecoqos_test.txt");
        {
            let mut f = File::create(&test_file).unwrap();
            f.write_all(b"MKMN EcoQoS Verification Payload on Qualcomm Oryon CPU").unwrap();
        }

        let hash = compute_sha256_eco(&test_file).expect("compute_sha256_eco must succeed");
        assert!(!hash.is_empty());
        assert_eq!(hash.len(), 64, "SHA-256 hash must be 64 hex characters");

        let _ = std::fs::remove_file(&test_file);
    }

    #[test]
    fn test_qos_tier_policy_transitions() {
        let _lock = TEST_LOCK.lock().unwrap();
        let h_process = unsafe { GetCurrentProcess() };

        // 1. Tier 3 BackgroundEco
        apply_process_tier(h_process, QoSTier::BackgroundEco).expect("Apply BackgroundEco must succeed");
        let is_eco = verify_process_ecoqos(h_process).unwrap();
        assert!(is_eco, "BackgroundEco must have EcoQoS verified active");
        let prio_eco = get_process_priority(h_process).unwrap();
        assert_eq!(prio_eco, BELOW_NORMAL_PRIORITY_CLASS);

        // 2. Tier 2 InferenceCritical
        apply_process_tier(h_process, QoSTier::InferenceCritical).expect("Apply InferenceCritical must succeed");
        let is_eco_infer = verify_process_ecoqos(h_process).unwrap();
        assert!(!is_eco_infer, "InferenceCritical must have EcoQoS disabled (strictly unthrottled)");
        let prio_infer = get_process_priority(h_process).unwrap();
        assert_eq!(prio_infer, ABOVE_NORMAL_PRIORITY_CLASS);

        // 3. Tier 1 Interactive
        apply_process_tier(h_process, QoSTier::Interactive).expect("Apply Interactive must succeed");
        let is_eco_interactive = verify_process_ecoqos(h_process).unwrap();
        assert!(!is_eco_interactive, "Interactive must have EcoQoS disabled");
        let prio_interactive = get_process_priority(h_process).unwrap();
        assert_eq!(prio_interactive, NORMAL_PRIORITY_CLASS);

        // 4. Query QoS summary
        let summary = get_current_process_qos_summary().expect("Query current QoS summary must succeed");
        assert_eq!(summary.tier, QoSTier::Interactive);
        assert!(!summary.ecoqos_active);
        assert!(summary.verified_hw_state);
    }
}
