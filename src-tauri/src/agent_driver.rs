//! The `agent-desktop` driver host: supervision of the pinned native Computer
//! Use driver (the same discipline as the Node sidecar's host) and the ONE
//! window grant the whole feature works under.
//!
//! The host owns three things no one else touches:
//!   - **The driver process**: spawned lazily, `CREATE_NO_WINDOW`, job-object
//!     member, generation-scoped pending calls, bounded kill on shutdown. A
//!     call that misses its deadline fails; a wedged driver is killed and the
//!     next call spawns a fresh generation. An idle driver (no grant, no call
//!     for `IDLE_RELEASE`) exits on its own, and a live one runs on the
//!     efficiency path (BELOW_NORMAL + EcoQoS): it waits on other programs'
//!     UI, so it never needs a performance core.
//!   - **The pin**: the driver announces its name/version/protocol on start
//!     (`agent_wire::check_pin`); a build that is not the pinned one never
//!     serves a call.
//!   - **The grant**: exactly one granted window per run. Every observe/act
//!     the sidecar asks for is checked against the grant AND the window's
//!     liveness before it reaches the driver — the sidecar cannot widen its
//!     own target, and a closed window refuses calls instead of acting on a
//!     stale handle.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::agent_wire::{
    check_pin, ActRequest, AgentAction, DriverReady, DriverWindow, ObserveRequest,
    DRIVER_PROTOCOL, DRIVER_VERSION,
};

/// How long one driver call may take (UIA on a busy UI thread can be slow; a
/// wedged call is a dead driver, and the generation discipline recovers it).
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the handshake (`ready` announcement) may take.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a driver with no grant and no call stays resident. The picker's list and
/// refresh land well inside it; after that the process is released and the next call
/// starts a fresh one (a short spawn, against a resident process for the whole session).
const IDLE_RELEASE: Duration = Duration::from_secs(60);
/// How often the idle check runs while a driver is alive.
const IDLE_CHECK: Duration = Duration::from_secs(15);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether a driver last used at `last_used_ms` has been idle long enough to release.
fn idle_expired(last_used_ms: u64, now_ms: u64, idle: Duration) -> bool {
    now_ms.saturating_sub(last_used_ms) >= idle.as_millis() as u64
}

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

/// The one granted window: validated at begin, re-checked on every call.
#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub hwnd: i64,
    pub pid: u32,
    pub title: String,
    pub process: String,
}

impl Grant {
    pub fn to_json(&self) -> Value {
        json!({ "hwnd": self.hwnd, "pid": self.pid, "title": self.title, "process": self.process })
    }
}

struct DriverProcess {
    child: Child,
    stdin: mpsc::Sender<String>,
    /// Bumped per spawn; pending calls and slot-clearing are generation-scoped,
    /// so a respawn never tears down the new process (the sidecar's pattern).
    generation: u64,
}

pub struct AgentDriverHost {
    process: Arc<Mutex<Option<DriverProcess>>>,
    pending: PendingMap,
    counter: AtomicU64,
    generation: AtomicU64,
    grant: Arc<Mutex<Option<Grant>>>,
    /// When the driver was last asked for anything (ms since the epoch): the idle release reads it.
    last_used: Arc<AtomicU64>,
    app: AppHandle,
}

impl AgentDriverHost {
    pub fn new(app: AppHandle) -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            grant: Arc::new(Mutex::new(None)),
            last_used: Arc::new(AtomicU64::new(0)),
            app,
        }
    }

    /// Where the pinned driver build is. Precedence follows the app's other
    /// native pieces: an explicit override, the installed Runtime folder, the
    /// build output the same cargo invocation produced.
    fn driver_path(&self) -> Option<PathBuf> {
        if let Ok(p) = std::env::var("MKMN_AGENT_DESKTOP")
            && !p.is_empty() && PathBuf::from(&p).is_file() {
                return Some(PathBuf::from(p));
            }
        if let Ok(dir) = self.app.path().resource_dir() {
            let bundled = dir.join("Runtime").join("agent-desktop.exe");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
        // development: the driver built by the same cargo invocation as the host
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for profile in ["debug", "release"] {
            let dev = manifest.join("target").join(profile).join("agent-desktop.exe");
            if dev.is_file() {
                return Some(dev);
            }
        }
        // A dev run of MKMN.exe itself: the driver sits beside it in the target dir.
        if let Ok(exe) = std::env::current_exe()
            && let Some(dir) = exe.parent() {
                let beside = dir.join("agent-desktop.exe");
                if beside.is_file() {
                    return Some(beside);
                }
            }
        None
    }

    /// Spawns the driver if none is running, and waits for the pinned `ready`
    /// announcement. The whole transition runs under the process lock.
    async fn ensure_spawned(&self) -> Result<(), String> {
        let mut guard = self.process.lock().await;
        // Touched under the process lock: the idle release checks it under the same lock,
        // so a driver someone is about to use is never released under them.
        self.last_used.store(now_ms(), Ordering::Relaxed);
        if let Some(p) = guard.as_mut() {
            match p.child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(_)) | Err(_) => {
                    log::warn!("[agent-desktop] previous driver exited; respawning");
                    crate::paths::lifecycle_log(
                        "agent-driver",
                        &format!(
                            "previous driver process had exited on its own; respawning (its generation was {})",
                            p.generation
                        ),
                    );
                    self.fail_pending().await;
                }
            }
            *guard = None;
        }
        let path = self
            .driver_path()
            .ok_or_else(|| "The pinned agent-desktop driver was not found in this installation.".to_string())?;
        let mut command = Command::new(&path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, like every hidden spawn
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start the agent-desktop driver ({}): {}", path.display(), e))?;
        // Job object membership: the driver dies with the app, never orphans.
        if let Some(job) = crate::job_object::app_job()
            && let Some(pid) = child.id()
                && !job.assign_process(pid) {
                    log::warn!("[agent-desktop] could not join the job object");
                }

        let stdin = child.stdin.take().ok_or("agent-desktop stdin unavailable")?;
        let (tx, mut rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        let stdout = child.stdout.take().ok_or("agent-desktop stdout unavailable")?;
        let pending = self.pending.clone();
        let app = self.app.clone();
        let process_slot = self.process.clone();
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;

        // The handshake: the first line must be the pinned `ready` announcement.
        let (ready_tx, ready_rx) = oneshot::channel::<Result<DriverReady, String>>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut announced = false;
            let mut ready_tx = Some(ready_tx);
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                match msg.get("t").and_then(Value::as_str) {
                    Some("event") if !announced && msg.get("name").and_then(Value::as_str) == Some("ready") => {
                        announced = true;
                        let parsed: Result<DriverReady, String> =
                            serde_json::from_value(msg.get("payload").cloned().unwrap_or(Value::Null))
                                .map_err(|e| e.to_string());
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(parsed);
                        }
                    }
                    Some("res") => {
                        let id = msg.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        if id.is_empty() {
                            continue;
                        }
                        let waiter = pending.lock().await.remove(&id);
                        if let Some(tx) = waiter {
                            let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
                            let payload = if ok {
                                Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                            } else {
                                Err(msg
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .unwrap_or("the driver reported a failure without a reason")
                                    .to_string())
                            };
                            let _ = tx.send(payload);
                        }
                    }
                    _ => {}
                }
            }
            // stdout closed: the driver is gone. Its pending calls fail now; the
            // slot clears only if this generation is still the published one.
            {
                crate::paths::lifecycle_log(
                    "agent-driver",
                    &format!(
                        "driver exited unexpectedly (stdout closed) in generation {}; its pending calls fail here",
                        generation
                    ),
                );
                let mut map = pending.lock().await;
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err("The agent-desktop driver exited before answering.".into()));
                }
            }
            let mut slot = process_slot.lock().await;
            if slot.as_ref().map(|p| p.generation) == Some(generation) {
                *slot = None;
            }
            let _ = app; // (kept for symmetry with the sidecar reader; events re-emitted by callers)
        });

        let stderr = child.stderr.take().ok_or("agent-desktop stderr unavailable")?;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[agent-desktop:stderr] {}", line);
            }
        });

        let ready = tokio::time::timeout(HANDSHAKE_TIMEOUT, ready_rx).await;
        match ready {
            Ok(Ok(Ok(announcement))) => {
                if let Err(e) = check_pin(&announcement) {
                    // Not the pinned build: never serve calls from it. The child
                    // dies with the slot drop (kill_on_drop).
                    log::warn!("[agent-desktop] pin refused: {e}");
                    crate::paths::lifecycle_log(
                        "agent-driver",
                        &format!("spawned driver refused: the pin check failed ({e}); killing it"),
                    );
                    *guard = None;
                    return Err(e);
                }
            }
            Ok(Ok(Err(e))) => {
                crate::paths::lifecycle_log("agent-driver", "spawned driver announced a broken handshake; killing it");
                *guard = None;
                return Err(format!("the agent-desktop driver announced a broken handshake: {e}"));
            }
            Ok(Err(_)) | Err(_) => {
                crate::paths::lifecycle_log("agent-driver", "spawned driver did not announce itself in time; killing it");
                *guard = None;
                return Err("the agent-desktop driver did not announce itself in time".to_string());
            }
        }

        log::info!("[agent-desktop] started: {} (pinned {} protocol {})", path.display(), DRIVER_VERSION, DRIVER_PROTOCOL);
        crate::paths::lifecycle_log(
            "agent-driver",
            &format!(
                "driver spawned: generation={} pid={:?} pinned v{}/protocol {} path={}",
                generation,
                child.id(),
                DRIVER_VERSION,
                DRIVER_PROTOCOL,
                path.display()
            ),
        );
        // The efficiency path: the driver spends its life waiting on other programs' UI
        // Automation, so BELOW_NORMAL + EcoQoS costs a run nothing and keeps it off the
        // performance cores. Eco-only: the app-wide sleep inhibit geniex holds is untouched.
        if let Some(pid) = child.id()
            && let Err(e) = crate::qos::apply_pid_eco_only(pid) {
                log::warn!("[agent-desktop] could not apply EcoQoS: {e}");
            }
        *guard = Some(DriverProcess { child, stdin: tx, generation });
        drop(guard);
        self.spawn_idle_release(generation);
        Ok(())
    }

    /// Releases this generation's driver once it has had no grant and no call for
    /// `IDLE_RELEASE`. Ends on its own when the generation is replaced or gone.
    fn spawn_idle_release(&self, generation: u64) {
        let slot = self.process.clone();
        let grant = self.grant.clone();
        let last_used = self.last_used.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_CHECK).await;
                // The grant is read BEFORE the process lock (begin_grant takes them in the
                // other order); a grant that lands in between finds the driver gone and its
                // first call respawns one.
                if grant.lock().await.is_some() {
                    continue;
                }
                let mut guard = slot.lock().await;
                if guard.as_ref().map(|p| p.generation) != Some(generation) {
                    return;
                }
                if !idle_expired(last_used.load(Ordering::Relaxed), now_ms(), IDLE_RELEASE) {
                    continue;
                }
                let taken = guard.take();
                drop(guard);
                if let Some(mut p) = taken {
                    crate::paths::lifecycle_log(
                        "agent-driver",
                        &format!("idle for {} s with no grant: releasing the driver (generation {})", IDLE_RELEASE.as_secs(), p.generation),
                    );
                    let _ = tokio::time::timeout(Duration::from_secs(2), p.child.kill()).await;
                }
                return;
            }
        });
    }

    async fn fail_pending(&self) {
        let mut map = self.pending.lock().await;
        for (_, tx) in map.drain() {
            let _ = tx.send(Err("The agent-desktop driver exited before answering.".into()));
        }
    }

    /// One call to the driver; respawns it first when the previous one died.
    async fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        self.ensure_spawned().await?;
        let id = format!(
            "a-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            self.counter.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        let request = json!({ "t": "req", "id": id, "method": method, "args": args });
        let sent = {
            let guard = self.process.lock().await;
            match guard.as_ref() {
                Some(p) => {
                    self.pending.lock().await.insert(id.clone(), tx);
                    p.stdin.try_send(request.to_string()).is_ok().then_some(p.generation)
                }
                None => None,
            }
        };
        let Some(generation) = sent else {
            self.pending.lock().await.remove(&id);
            return Err("The agent-desktop driver is not running.".into());
        };
        let outcome = tokio::time::timeout(CALL_TIMEOUT, rx).await;
        self.last_used.store(now_ms(), Ordering::Relaxed);
        match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The agent-desktop driver dropped the call.".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                // The driver answers one call at a time: one stuck in a wedged COM call
                // would make every later call miss its deadline too. Kill THIS generation
                // (never a newer one) so the next call spawns a fresh driver.
                let wedged = {
                    let mut guard = self.process.lock().await;
                    if guard.as_ref().map(|p| p.generation) == Some(generation) { guard.take() } else { None }
                };
                crate::paths::lifecycle_log(
                    "agent-driver",
                    &format!(
                        "call \"{method}\" missed its {} s deadline; killing generation {generation} so the next call starts a fresh driver",
                        CALL_TIMEOUT.as_secs()
                    ),
                );
                if let Some(mut p) = wedged {
                    let _ = tokio::time::timeout(Duration::from_secs(2), p.child.kill()).await;
                }
                Err(format!("The agent-desktop driver did not answer \"{}\" in time.", method))
            }
        }
    }

    // ------------------------------------------------------------ the grant

    /// Validates and records the ONE window grant for a run. Refused when a run
    /// is active, when the handle is not a live visible top-level window of
    /// another process, or when the driver is not available.
    pub async fn begin_grant(&self, hwnd: i64) -> Result<Grant, String> {
        // The slot stays locked for the whole begin: two begins arriving together must
        // not both pass the check and the second overwrite the first run's grant.
        let mut slot = self.grant.lock().await;
        if slot.is_some() {
            crate::paths::lifecycle_log("agent-grant", "begin refused: a run is already active");
            return Err("A Computer Use run is already active. Stop it first.".to_string());
        }
        let grant = match validate_candidate(hwnd) {
            Ok(g) => g,
            Err(e) => {
                crate::paths::lifecycle_log("agent-grant", &format!("begin refused: {e}"));
                return Err(e);
            }
        };
        // The driver must be spawnable before a grant is recorded: a run that
        // cannot observe would only produce a failed run.
        if let Err(e) = self.ensure_spawned().await {
            crate::paths::lifecycle_log("agent-grant", &format!("begin refused: the driver could not start ({e})"));
            return Err(e);
        }
        *slot = Some(grant.clone());
        crate::paths::lifecycle_log("agent-grant", &grant_log_line(&grant));
        Ok(grant)
    }

    pub async fn end_grant(&self) {
        let had = self.grant.lock().await.take();
        if let Some(g) = had {
            crate::paths::lifecycle_log("agent-grant", &format!("released: hwnd={} pid={}", g.hwnd, g.pid));
        }
    }

    /// The live grant, if the window is still what it was granted for. A grant
    /// whose window closed or changed process is dead: refused, never
    /// forwarded to the driver.
    async fn live_grant(&self, hwnd: i64) -> Result<Grant, String> {
        let grant = self
            .grant
            .lock()
            .await
            .clone()
            .ok_or_else(|| "No Computer Use window is granted. Pick a window first.".to_string())?;
        if grant.hwnd != hwnd {
            return Err("That window is not the granted one.".to_string());
        }
        if let Ok(now) = validate_candidate(hwnd)
            && now.pid == grant.pid {
                return Ok(grant);
            }
        crate::paths::lifecycle_log(
            "agent-grant",
            &format!("window no longer matches the grant (closed or changed process): hwnd={} granted pid={}", grant.hwnd, grant.pid),
        );
        Err("WINDOWGONE".to_string())
    }

    // -------------------------------------------------- calls the sidecar makes

    pub async fn list_windows(&self) -> Result<Vec<DriverWindow>, String> {
        let v = self.call("listWindows", json!({})).await?;
        serde_json::from_value(v).map_err(|e| format!("the driver sent a broken window list: {e}"))
    }

    pub async fn observe(&self, hwnd: i64, max_nodes: Option<u32>) -> Result<Value, String> {
        let _grant = self.live_grant(hwnd).await?;
        let req = ObserveRequest { hwnd, max_nodes };
        let args = serde_json::to_value(req).map_err(|e| e.to_string())?;
        self.call("observe", args).await
    }

    pub async fn act(&self, hwnd: i64, action: AgentAction) -> Result<Value, String> {
        let _grant = self.live_grant(hwnd).await?;
        let req = ActRequest { hwnd, action };
        let args = serde_json::to_value(req).map_err(|e| e.to_string())?;
        self.call("act", args).await
    }

    /// Whether a driver process is currently alive (the shutdown path skips a
    /// never-started driver instead of spawning one to kill it).
    pub async fn is_running(&self) -> bool {
        let mut guard = self.process.lock().await;
        match guard.as_mut() {
            None => false,
            Some(p) => matches!(p.child.try_wait(), Ok(None)),
        }
    }

    /// Stops the driver (the coordinated shutdown path): bounded kill, never
    /// hangs the exit; the job object covers whatever survives.
    pub async fn shutdown(&self) {
        self.end_grant().await;
        let child = self.process.lock().await.take();
        if let Some(mut p) = child {
            crate::paths::lifecycle_log(
                "agent-driver",
                &format!("shutdown: killing the driver (generation {})", p.generation),
            );
            if tokio::time::timeout(Duration::from_secs(2), p.child.kill())
                .await
                .is_err()
            {
                log::warn!("[agent-desktop] the driver did not die within 2 s of kill; its job membership finishes it at process exit");
                crate::paths::lifecycle_log(
                    "agent-driver",
                    "the driver did not die within 2 s of kill; its job membership finishes it at process exit",
                );
            }
        }
    }
}

/// The checks a window must pass to be granted: a live, visible top-level
/// window of ANOTHER process, with a title. Pure Win32, no driver involved.
fn validate_candidate(hwnd: i64) -> Result<Grant, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetWindowThreadProcessId, GA_ROOT, IsWindow, IsWindowVisible};
    let h = HWND(hwnd as _);
    if !unsafe { IsWindow(Some(h)) }.as_bool() {
        return Err("That window is gone.".to_string());
    }
    if !unsafe { IsWindowVisible(h) }.as_bool() {
        return Err("That window is not visible.".to_string());
    }
    let root = unsafe { GetAncestor(h, GA_ROOT) };
    if root != h {
        return Err("Only a top-level window can be granted.".to_string());
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    if pid == std::process::id() {
        return Err("MKMN's own window cannot be the target of a Computer Use run.".to_string());
    }
    if pid == 0 {
        return Err("That window has no owning process.".to_string());
    }
    // The title the list showed is what the grant records; a fresh read keeps
    // the grant honest even if the list was older.
    let title = read_title(h);
    if title.trim().is_empty() {
        return Err("That window has no title to show the person.".to_string());
    }
    Ok(Grant { hwnd, pid, title, process: String::new() })
}

fn read_title(h: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    let len = unsafe { GetWindowTextLengthW(h) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) + 1];
    let read = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..(read as usize).min(len as usize)])
}

/// The lifecycle line for a new grant: handles and pids only. The window's
/// title is its contents (a document name, a subject) and never reaches the log.
fn grant_log_line(grant: &Grant) -> String {
    format!("granted: hwnd={} pid={}", grant.hwnd, grant.pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_idle_driver_is_released_only_after_the_idle_window() {
        let idle = Duration::from_secs(60);
        assert!(!idle_expired(1_000, 1_000, idle));
        assert!(!idle_expired(1_000, 60_999, idle));
        assert!(idle_expired(1_000, 61_000, idle));
        // a clock that stepped backwards never releases a driver early
        assert!(!idle_expired(10_000, 5_000, idle));
    }

    #[test]
    fn grant_log_line_names_no_window_contents() {
        let g = Grant { hwnd: 42, pid: 7, title: "Salary review.docx - Word".into(), process: "WINWORD.EXE".into() };
        let line = grant_log_line(&g);
        assert_eq!(line, "granted: hwnd=42 pid=7");
    }

    /// A grant is refused, never silently widened: the pure candidate checks
    /// are the same ones the live grant re-check runs (pid equality).
    #[test]
    fn grant_json_carries_the_full_target() {
        let g = Grant { hwnd: 42, pid: 7, title: "Untitled - Notepad".into(), process: "notepad.exe".into() };
        let v = g.to_json();
        assert_eq!(v["hwnd"], 42);
        assert_eq!(v["pid"], 7);
        assert_eq!(v["title"], "Untitled - Notepad");
        assert_eq!(v["process"], "notepad.exe");
    }

    #[test]
    fn grants_are_compared_by_every_field() {
        let a = Grant { hwnd: 42, pid: 7, title: "t".into(), process: String::new() };
        let b = a.clone();
        assert_eq!(a, b);
        assert_ne!(a, Grant { hwnd: 43, ..b });
    }
}
