//! The Node sidecar: a plain Node.js process carrying the TypeScript main-process logic
//! (catalog, Hugging Face, Docker Hub, LibreOffice conversion, wikimedia) that has no
//! reason to be rewritten in Rust. Spawned once, supervised here, spoken to over
//! line-delimited JSON on stdin/stdout (src/sidecar/protocol.ts).
//!
//! Both directions of the conversation are handled:
//!  - requests the webview sends through `sidecar_call` are forwarded to the sidecar;
//!  - requests the sidecar sends back (host capabilities with native UI, e.g. a folder
//!    picker) are answered here;
//!  - events the sidecar emits are re-emitted to the webview as `sidecar-event`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::supervisor::{GenieXSupervisor, StartServerRequest};

// The outer deadline for a sidecar call must be at least as long as the longest wait
// any inner step can legitimately take (the confirmRun approval dialog and the model
// server startup both wait up to 600 s): a shorter outer timeout made an approved
// dialog or a slow-but-successful startup surface as a timeout error.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

type PendingMap = Arc<Mutex<HashMap<String, (u64, oneshot::Sender<Result<Value, String>>)>>>;

/// Removes and fails every pending call that was made against generation `at_or_before`
/// (`u64::MAX` = all of them). A dead sidecar's stdout reader must fail only the calls
/// of ITS OWN generation: calls made after a respawn belong to the new process and must
/// keep waiting for its answers.
async fn fail_pending_of_generation(pending: &PendingMap, at_or_before: u64) {
    let mut map = pending.lock().await;
    let dead: Vec<String> = map
        .iter()
        .filter(|(_, (g, _))| *g <= at_or_before)
        .map(|(id, _)| id.clone())
        .collect();
    for id in dead {
        if let Some((_, tx)) = map.remove(&id) {
            let _ = tx.send(Err(
                "The sidecar exited before answering this call.".to_string(),
            ));
        }
    }
}

struct SidecarProcess {
    child: Child,
    stdin: mpsc::Sender<String>,
    /// Bumped per spawn: a stdout reader that sees EOF must only clear the process slot
    /// and fail pending calls when it still belongs to THIS generation.
    generation: u64,
}

pub struct SidecarHost {
    /// Guarded by an async mutex held across the WHOLE spawn transition (check, spawn,
    /// publish), so two concurrent first calls can never each spawn a sidecar.
    process: Arc<Mutex<Option<SidecarProcess>>>,
    pending: PendingMap,
    counter: AtomicU64,
    generation: AtomicU64,
    app: AppHandle,
}

impl SidecarHost {
    pub fn new(app: AppHandle) -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            counter: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            app,
        }
    }

    /// Fails every pending call at once (a dead sidecar was found during respawn):
    /// they must not wait out their full timeout against a process that never answers.
    async fn fail_all_pending(&self) {
        fail_pending_of_generation(&self.pending, u64::MAX).await;
    }

    /// The Node executable the sidecar runs with (public: the shutdown fallback
    /// kills orphaned voice workers by exactly this image path).
    pub fn node_path(&self) -> PathBuf {
        if let Ok(p) = std::env::var("MKMN_NODE_PATH")
            && !p.is_empty() {
                return PathBuf::from(p);
            }
        if let Ok(exe) = self.app.path().resource_dir() {
            let exe = plain_path(&exe);
            for candidate in [exe.join("Runtime").join("node.exe"), exe.join("node.exe")] {
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        PathBuf::from("node.exe")
    }

    fn script_path(&self) -> Option<PathBuf> {
        if let Ok(p) = std::env::var("MKMN_SIDECAR_SCRIPT")
            && !p.is_empty() && PathBuf::from(&p).is_file() {
                return Some(PathBuf::from(p));
            }
        if let Ok(exe) = self.app.path().resource_dir() {
            let bundled = plain_path(&exe).join("Runtime").join("sidecar").join("main.js");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
        // development: the compiled sidecar of the TypeScript build, next to src-tauri
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist")
            .join("sidecar")
            .join("main.js");
        if dev.is_file() {
            return Some(dev);
        }
        None
    }

    /// Spawns the sidecar if none is running. Never spawns two: the whole transition
    /// (liveness check, spawn, publication) happens under one lock, and liveness is
    /// decided by a reaping `try_wait`, not by a process id that can outlive the process.
    async fn ensure_spawned(&self) -> Result<(), String> {
        let mut guard = self.process.lock().await;
        if let Some(p) = guard.as_mut() {
            match p.child.try_wait() {
                // Still running.
                Ok(None) => return Ok(()),
                // Exited (reaped here): drop the stale handle and respawn below.
                Ok(Some(_)) => {
                    log::warn!("[sidecar] previous sidecar process has exited; respawning");
                    self.fail_all_pending().await;
                }
                Err(e) => {
                    log::warn!("[sidecar] could not check the sidecar process ({}); respawning", e);
                    self.fail_all_pending().await;
                }
            }
            *guard = None;
        }
        let script = self.script_path().ok_or_else(|| {
            "The sidecar script was not found. Run `npm run build:sidecar` first.".to_string()
        })?;
        let node = self.node_path();
        let mut command = Command::new(&node);
        command
            .arg(&script)
            .env("MKMN_APP_VERSION", self.app.package_info().version.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start the sidecar ({}): {}", node.display(), e))?;

        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
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

        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
        let pending = self.pending.clone();
        let app = self.app.clone();
        let side_stdin = tx.clone();
        let process_slot = self.process.clone();
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    // stdout is protocol-only: a stray line breaks that rule, so it leaves a trace (cut short)
                    let shown: String = line.chars().take(200).collect();
                    crate::paths::append_log("mkmn", &format!("[sidecar] a stdout line that is not protocol was skipped: {}", shown));
                    continue;
                };
                match msg.get("t").and_then(Value::as_str) {
                    Some("res") => {
                        let id = msg.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        if id.is_empty() {
                            continue;
                        }
                        let waiter = pending.lock().await.remove(&id);
                        if let Some((_, tx)) = waiter {
                            let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
                            let payload = if ok {
                                Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                            } else {
                                Err(msg
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .unwrap_or("The sidecar reported a failure without a reason.")
                                    .to_string())
                            };
                            let _ = tx.send(payload);
                        }
                    }
                    Some("req") => {
                        // the sidecar asking the host for a capability (a folder picker, a chat
                        // server). Handled on its own task: a long operation (a server load, a
                        // native approval dialog) must not stall every later response and event
                        // waiting behind it on this stream.
                        let id = msg.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                        let method =
                            msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                        let args = msg.get("args").cloned().unwrap_or(json!([]));
                        let app = app.clone();
                        let side_stdin = side_stdin.clone();
                        tokio::spawn(async move {
                            let result = host_capability(&app, &method, &args).await;
                            let reply = match result {
                                Ok(v) => json!({ "t": "res", "id": id, "ok": true, "result": v }),
                                Err(e) => json!({ "t": "res", "id": id, "ok": false, "error": e }),
                            };
                            let _ = side_stdin.send(reply.to_string()).await;
                        });
                    }
                    Some("event") => {
                        let name = msg.get("name").and_then(Value::as_str).unwrap_or("");
                        if !name.is_empty() {
                            let payload = msg.get("payload").cloned().unwrap_or(Value::Null);
                            let _ = app
                                .emit("sidecar-event", json!({ "name": name, "payload": payload }));
                        }
                    }
                    _ => {}
                }
            }
            // stdout closed: the sidecar is gone. Its pending calls must fail NOW, not on
            // their timeout; the dead process slot is cleared only if this generation is
            // still the published one, so a respawned sidecar is never torn down here.
            fail_pending_of_generation(&pending, generation).await;
            {
                let mut guard = process_slot.lock().await;
                if guard.as_ref().map(|p| p.generation) == Some(generation) {
                    *guard = None;
                }
            }
            // The chats this sidecar had ACKNOWLEDGED (the `chat` call answers at once and
            // the turn streams later as events) will never receive their terminal event
            // from the dead process: a replacement sidecar has no registry entry for them.
            // The window holds that pending set (and the sleep-inhibits), so it is told
            // here — one lifecycle event settles every stranded chat: error events, the
            // inhibits released, the busy state cleared. Emitted after the slot is
            // cleared, so a respawn triggered by a later call is never confused with this
            // dead generation.
            // The benchmark flag this sidecar may have set is released too: it will never
            // send the matching "off", and a flag held by nobody keeps the monitor awake.
            crate::monitor::set_benchmarking(false);
            let _ = app.emit(
                "sidecar-event",
                json!({ "name": "sidecarExited", "payload": { "generation": generation } }),
            );
        });

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[sidecar:stderr] {}", line);
            }
        });

        log::info!("[sidecar] started: {} {}", node.display(), script.display());
        // Publish while still holding the spawn lock: no other caller can spawn or
        // observe a half-built process here.
        *guard = Some(SidecarProcess { child, stdin: tx, generation });
        Ok(())
    }

    /// One call to the sidecar; respawns it first when the previous one died.
    pub async fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        if !args.is_array() {
            return Err("sidecar arguments must be an array".into());
        }
        self.ensure_spawned().await?;
        let id = format!(
            "c-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            self.counter.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        let request = json!({ "t": "req", "id": id, "method": method, "args": args });
        // The call belongs to the process it is SENT to: the generation is read, the call
        // registered and the request sent while holding the process lock — the lock the
        // spawn holds while it publishes a new generation — so a restart can never tag
        // this call with one process's generation and send it to another. (Lock order:
        // process, then pending — the same order the spawn path uses.)
        let sent = {
            let guard = self.process.lock().await;
            let generation = self.generation.load(Ordering::Relaxed);
            match guard.as_ref() {
                Some(p) => {
                    self.pending.lock().await.insert(id.clone(), (generation, tx));
                    let ok = p.stdin.try_send(request.to_string()).is_ok();
                    if !ok {
                        self.pending.lock().await.remove(&id);
                    }
                    ok
                }
                None => false,
            }
        };
        if !sent {
            return Err("The sidecar is not running.".into());
        }
        let deadline = if matches!(method, "startGeniexModel" | "preloadGeniexModel" | "restartGeniexModel" | "benchmarkGeniexModel") {
            // The native benchmark alone can run for 900 seconds. Admission also verifies release.
            Duration::from_secs(1500)
        } else {
            CALL_TIMEOUT
        };
        match tokio::time::timeout(deadline, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The sidecar dropped the call.".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("The sidecar did not answer \"{}\" in time.", method))
            }
        }
    }

    /// Whether a sidecar process is currently alive. The shutdown path consults this
    /// before its graceful `appShutdown` call: a call would SPAWN a sidecar just to
    /// kill it, so a never-started (or already dead) sidecar must skip straight to
    /// the kill, which is a no-op on an empty slot.
    pub async fn is_running(&self) -> bool {
        let mut guard = self.process.lock().await;
        match guard.as_mut() {
            None => false,
            Some(p) => matches!(p.child.try_wait(), Ok(None)),
        }
    }

    /// Stops the sidecar (shutdown path): bounded kill, never hangs the exit. The
    /// killed process's stdin closes, so the sidecar's own stdio loop exits it
    /// cleanly; pending calls are failed by its stdout reader on EOF.
    pub async fn shutdown(&self) {
        let child = self.process.lock().await.take();
        if let Some(mut p) = child
            && tokio::time::timeout(Duration::from_secs(2), p.child.kill()).await.is_err() {
                log::warn!("[sidecar] the sidecar did not die within 2 s of kill; its job membership finishes it at process exit");
            }
    }
}

/// The keepalive (`--keepalive`, GenieX's only model-eviction mechanism) a chat server
/// start should run with, from the saved settings. Precedence: the explicit saved
/// `keepaliveSec` wins; otherwise the idle model-release setting applies — `0` means
/// "never release", sent as a 24 h keepalive, any other value is seconds of idle; with
/// neither saved, `None` lets the loading strategy map to its default inside the
/// supervisor. The reads are the STORED-and-valid ones (`checked_stored`): "not saved"
/// must stay "not saved" here, so no schema default is injected and the strategy
/// mapping keeps deciding. Pure so the precedence is pinned by tests.
fn keepalive_from_settings(settings: &Value) -> Option<u64> {
    match crate::settings::checked_stored(settings, "keepaliveSec").and_then(|v| v.as_f64()) {
        Some(v) => Some(v as u64),
        None => match crate::settings::checked_stored(settings, "idleReleaseSec").and_then(|v| v.as_f64()) {
            Some(0.0) => Some(86_400),
            Some(v) => Some(v as u64),
            None => None,
        },
    }
}

/// What the "open in browser" button may open: only a file that exists, is a file, has an
/// .html or .htm extension (case-insensitive) and sits inside `root` (the temp site folder
/// the sidecar writes built pages into). Everything else is refused: a path with another
/// extension would be run by the system as a program with the user's rights, a web address
/// has no caller here, and a path outside the folder is not a page the app wrote. Pure so
/// the rules are pinned by tests.
fn validate_site_open(target: &str, root: &std::path::Path) -> Result<PathBuf, String> {
    const REFUSED: &str = "Only an HTML page of the site can be opened in the browser.";
    if target.contains("://") {
        return Err(REFUSED.to_string());
    }
    let path = std::path::Path::new(target);
    if !path.is_absolute() {
        return Err(REFUSED.to_string());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if ext.as_deref() != Some("html") && ext.as_deref() != Some("htm") {
        return Err(REFUSED.to_string());
    }
    let meta = std::fs::metadata(path).map_err(|_| "That page is not on the disk yet.".to_string())?;
    if !meta.is_file() {
        return Err(REFUSED.to_string());
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("It could not be opened: {}", e))?;
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let root = root.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
    let inside = canonical
        .to_str()
        .map(|c| {
            let c = c.to_ascii_lowercase();
            let r = root.to_ascii_lowercase();
            c.starts_with(&format!("{}\\", r)) || c.starts_with(&format!("{}/", r))
        })
        .unwrap_or(false);
    if !inside {
        return Err(REFUSED.to_string());
    }
    // canonicalize answers with a verbatim path on Windows ("\\?\\C:\\..."), which the
    // system's opener does not take: hand it back the plain form.
    Ok(plain_path(&canonical))
}

/// A Windows verbatim path ("\\?\C:\..." or "\\?\UNC\server\share\...") in its plain form;
/// any other path as it is. The resource folder comes back verbatim on Windows, and a sidecar
/// started from it passed verbatim folders to Node's permission model, which does not match
/// them: every isolated check of generated code stopped with exit 1.
pub(crate) fn plain_path(path: &std::path::Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", rest))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// The patch the sidecar sends for a settings save: `callHost(..., "saveSettings", [patch])`
/// — the patch object WRAPPED in the capability's arguments array. The host used to merge
/// the array itself: `as_object()` on an array is None, so every sidecar-side save (a
/// saved load profile, a placement badge, voice settings) was a silent no-op and the
/// sidecar adopted the UNMERGED settings as if it had saved. Unwrap the one argument;
/// anything else is refused with the shape named, never silently ignored.
pub(crate) fn settings_patch_of_args(args: &Value) -> Result<Value, String> {
    match args {
        Value::Array(items) => match items.first() {
            Some(p) if p.is_object() => Ok(p.clone()),
            _ => Err("saveSettings: expected the arguments [patchObject]; the patch to save was missing or not an object".to_string()),
        },
        _ => Err("saveSettings: expected the arguments [patchObject]; got something that is not an argument array".to_string()),
    }
}

/// The host capabilities the sidecar may ask for. Each maps to a native UI or OS action
/// the Rust host performs itself; anything unknown is refused.
async fn host_capability(app: &AppHandle, method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "pickFolder" => {
            let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
            app.dialog()
                .file()
                .set_title("Choose a folder for the project")
                .pick_folder(move |path| {
                    let _ = tx.send(path.and_then(|p| p.into_path().ok()));
                });
            let picked = tokio::task::spawn_blocking(move || {
                rx.recv_timeout(Duration::from_secs(600)).ok()
            })
            .await
            .map_err(|e| e.to_string())?
            .flatten();
            Ok(picked
                .map(|p| Value::String(p.to_string_lossy().to_string()))
                .unwrap_or(Value::Null))
        }
        // The sidecar persisting a settings patch (a saved load profile, a placement
        // badge, voice settings). The Rust host is the ONE authoritative settings
        // writer: its locked read-merge-write is serialized against the webview's own
        // save path, so the sidecar must not run its own concurrent read/merge/write
        // over the same file. A failed host call is reported, not silently swallowed.
        "saveSettings" => {
            let patch = settings_patch_of_args(args)?;
            crate::settings::save_settings(patch)
        }
        // The benchmark suite (in the sidecar) recording a measured run: the same profile
        // writer as the single-model benchmark, keyed by the exact build it tested.
        "recordBenchRun" => crate::bench::record_suite_run(args),
        // The chat orchestrator (now in the sidecar) asking for the model server. The Rust
        // host stays the one owner of geniex.exe: it builds the request from the same
        // settings the webview's own start path uses and answers with the endpoint.
        "startGeniexModel" | "preloadGeniexModel" | "restartGeniexModel" => {
            if crate::shutdown::is_shutting_down() { return Err("MKMN is shutting down.".into()); }
            let supervisor = app.state::<GenieXSupervisor>();
            let status = if method == "restartGeniexModel" {
                let generation = args.get(0).and_then(Value::as_u64).ok_or("Missing restart generation")?;
                supervisor.restart(generation).await?
            } else {
                let (request, generation) = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
                supervisor.start_with_generation(request, generation).await?
            };
            serde_json::to_value(status).map_err(|e| e.to_string())
        }
        "benchmarkGeniexModel" => {
            let (model, compute, power, nctx, generation) = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
            let supervisor = app.state::<GenieXSupervisor>();
            let result = crate::commands::run_admitted_benchmark(&supervisor, model, compute, power, nctx, generation).await?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "releaseGeniexForHandoff" => {
            let supervisor = app.state::<GenieXSupervisor>();
            let _admission = supervisor.admit().await;
            supervisor.release_for_handoff().await?;
            Ok(json!(true))
        }
        "startChatServer" => {            let arr = args.as_array().cloned().unwrap_or_default();
            let model = arr
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("startChatServer: no model reference was given")?
                .to_string();
            let compute = arr
                .get(1)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let settings = crate::settings::load_settings();
            // Every engine-facing read passes its schema check: an absent or invalid
            // stored value reads as the schema default here, exactly as in the
            // renderer (no inline default beside the read).
            let cg = |key: &str| crate::settings::checked_get(&settings, key);
            let (spec_type, draft_tokens, draft_model, draft_min, draft_p_min) = {
                let spec = cg("speculativeDecoding");
                if spec.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
                    let leaf_str = |k: &str| crate::settings::checked_string(&settings, k);
                    let leaf_num = |k: &str| crate::settings::checked_number(&settings, k);
                    (
                        Some(leaf_str("speculativeDecoding.specType")),
                        Some(leaf_num("speculativeDecoding.draftTokens") as u32),
                        // A draft model is optional even for the draft-* strategies.
                        Some(leaf_str("speculativeDecoding.draftModel")).filter(|s| !s.trim().is_empty()),
                        // 0 means "the runtime's own default": never sent.
                        Some(leaf_num("speculativeDecoding.draftMin") as u32).filter(|n| *n > 0),
                        Some(leaf_num("speculativeDecoding.draftPMin") as f32).filter(|p| *p > 0.0),
                    )
                } else {
                    (None, None, None, None, None)
                }
            };
            let nctx_override = arr
                .get(2)
                .and_then(|v| v.get("nctx"))
                .and_then(Value::as_u64)
                .filter(|n| *n > 0)
                .map(|n| n as u32);
            let nctx = match nctx_override {
                Some(n) => Some(n),
                None => match cg("nctxMode").as_str() {
                    Some("auto") | None => None,
                    Some(m) => m.parse::<u32>().ok(),
                },
            };
            let req = StartServerRequest {
                retry_model_load: arr.get(2).and_then(|v| v.get("retryModelLoad")).and_then(Value::as_bool).unwrap_or(false),
                // The saved custom GenieX path (and the GENIEX_PATH override, applied inside
                // find_geniex) must serve chat too: the same executable that setup resolved.
                exe: cg("geniexPath").as_str().map(String::from),
                port: Some(18181),
                model: Some(model),
                compute,
                timeout_sec: Some(crate::settings::checked_number(&settings, "startupTimeoutSec") as u64),
                // An explicit keepalive value wins; otherwise the idle-release setting
                // applies (0 = never release, sent as a 24h keepalive); otherwise the
                // loading strategy maps to its keepalive inside the supervisor
                // ("always" = 86400, "demand" = 300) — the same precedence every start
                // path uses.
                keepalive_sec: keepalive_from_settings(&settings),
                strategy: Some(crate::settings::checked_string(&settings, "loadingStrategy")),
                power_mode: Some(
                    // The schema default ("auto") is what the control shows and what
                    // the request sends; the effective mode is resolved inside the
                    // supervisor (burst on AC).
                    crate::settings::checked_string(&settings, "powerProfile"),
                ),
                nctx,
                kv_type: Some(crate::settings::checked_string(&settings, "kvType")),
                kv_in_ram: Some(crate::settings::checked_flag(&settings, "kvInRam")),
                spec_type,
                draft_model,
                draft_tokens,
                draft_min,
                draft_p_min,
                metrics: Some(true),
                vit_compute: {
                    // The vision encoder's compute unit, when the person named one
                    // ("cpu", "HTP1"…). Empty = the runtime's own default: no flag.
                    let v = crate::settings::checked_string(&settings, "vitCompute");
                    Some(v).filter(|s| !s.trim().is_empty())
                },
                qairt_lib: {
                    // A different QAIRT runtime, only meaningful for NPU (QAIRT) models —
                    // but the request carries it regardless: build_serve_args sends it only
                    // for QAIRT models, so a llama.cpp model never sees the flag.
                    let lib = cg("qairtLib").as_str().unwrap_or("").trim().to_string();
                    Some(lib).filter(|s| !s.is_empty())
                },
                ngl: {
                    // Layer offload for llama.cpp models; -1 (all) is the runtime default.
                    let n = crate::settings::checked_number(&settings, "geniexNgl");
                    Some(n as i32)
                },
                log_level: {
                    let lvl = crate::settings::checked_string(&settings, "geniexLog");
                    Some(lvl).filter(|s| s != "none")
                },
                // Off by default: the runtime's own update probe is skipped at start.
                skip_update: Some(!crate::settings::checked_flag(&settings, "geniexUpdateCheck")),
                extra_args: None,
            };
            let supervisor = app.state::<GenieXSupervisor>();
            let status = match supervisor.start(req).await {
                Ok(status) => status,
                Err(error) => return Ok(json!({ "lastError": crate::supervisor::classify_load_error(&error) })),
            };
            Ok(json!({
                "endpoint": status.endpoint,
                "state": status.state,
                "model": status.model,
                "lastError": status.last_error,
                // The context window and KV settings the server ACTUALLY runs with, so
                // chat prompts, benchmarks and UI labels quote the real values instead
                // of a catalog recommendation.
                "servedNctx": status.served_nctx,
                "servedKvType": status.served_kv_type,
                "servedKvInRam": status.served_kv_in_ram,
                "contextKind": status.context_kind
            }))
        }
        // The sidecar's chat orchestrator marking a generation in-flight, so the UI
        // shows "busy" instead of a ready server that only looks idle.
        "setServerBusy" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let busy = arr.first().and_then(Value::as_bool).unwrap_or(false);
            let supervisor = app.state::<GenieXSupervisor>();
            supervisor.set_busy(busy).await;
            Ok(json!(true))
        }
        // Fresh NPU telemetry for the chat error. Only outside processes with
        // demonstrated NPU activity are eligible for a contention warning.
        "npuRecoveryInfo" => {
            let supervisor = app.state::<GenieXSupervisor>();
            Ok(crate::npu_recovery::recovery_info(&supervisor).await)
        }
        // The bounded recovery itself: stop OUR stuck server and OUR stray geniex
        // processes (job-scoped), never a foreign one, never mid-generation, at
        // most once per cooldown. The NPU's driver is not touched (no elevation).
        "npuRecoverStuck" => {
            let supervisor = app.state::<GenieXSupervisor>();
            Ok(crate::npu_recovery::recover_stuck(&supervisor).await)
        }
        // The sidecar's benchmark marking a run in flight: a benchmark is work the app is
        // doing on the NPU, so the monitor must keep sampling even while the window is
        // hidden (the benchmark's own readings are read while it runs).
        "setBenchmarking" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let on = arr.first().and_then(Value::as_bool).unwrap_or(false);
            crate::monitor::set_benchmarking(on);
            Ok(json!(true))
        }
        // The versioned capability manifest of the installed GenieX executable: the
        // sidecar consults it before sending any optional serve flag.
        "geniexCapabilities" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let exe = arr.first().and_then(Value::as_str).map(|s| s.to_string());
            let resolved = GenieXSupervisor::find_geniex(exe.as_deref())
                .ok_or_else(|| "geniex.exe not found on system. Please verify GenieX CLI installation.".to_string())?;
            let caps = tokio::task::spawn_blocking(move || crate::capabilities::probe(&resolved))
                .await
                .map_err(|e| format!("capability probe task failed: {}", e))?;
            serde_json::to_value(caps).map_err(|e| e.to_string())
        }
        // The artifact manifest (what is actually in the cache, per its own metadata)
        // and the per-device evidence store. The sidecar writes evidence through
        // recordModelEvidence; the renderer reads both through the Tauri commands.
        "modelManifest" => {
            let manifest = tokio::task::spawn_blocking(crate::model_manifest::scan_model_manifest)
                .await
                .map_err(|e| format!("manifest scan task failed: {}", e))?;
            serde_json::to_value(manifest).map_err(|e| e.to_string())
        }
        "getModelEvidence" => serde_json::to_value(crate::model_manifest::load_evidence()).map_err(|e| e.to_string()),
        "recordModelEvidence" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let mut records: Vec<crate::model_manifest::EvidenceRecord> = arr
                .first()
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .ok_or("recordModelEvidence: no records were given")?;
            // Same enrichment as the Tauri command: every write is owned here and
            // leaves with the artifact identity it measured.
            crate::model_manifest::enrich_with_artifact_identity(&mut records);
            let all = crate::model_manifest::upsert_evidence(&records)?;
            serde_json::to_value(all).map_err(|e| e.to_string())
        }
        // The benchmark and the NPU load test asking for a clean NPU before the next model:
        // geniex.exe belongs to this host, so only it can put its own server down.
        "stopChatServer" => {
            let supervisor = app.state::<GenieXSupervisor>();
            supervisor.stop().await?;
            Ok(json!(true))
        }
        // The exported benchmark report or the run folder, shown in the file manager (the
        // sidecar wrote the files; it has no shell). A directory is opened itself; a file
        // is selected in its parent.
        "revealPath" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let target = arr
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("revealPath: no path was given")?;
            reveal_target_problem(target)?;
            #[cfg(windows)]
            {
                let is_dir = std::path::Path::new(target).is_dir();
                let mut cmd = std::process::Command::new("explorer.exe");
                if is_dir {
                    cmd.arg(target);
                } else {
                    cmd.arg("/select,").arg(target);
                }
                cmd.spawn()
                    .map_err(|e| format!("The file manager could not be opened: {}", e))?;
            }
            Ok(json!(true))
        }
        // A file the person asked to open (the "Open edited copy" of Edit a
        // copy) with its default app. Only an existing Word document is
        // accepted: the run itself names the copy, and a .docx cannot run as
        // a program the way a script would. Nothing is selected; the file
        // itself is opened.
        "openEditedCopy" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let target = arr
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("openEditedCopy: no path was given")?;
            if !target.to_lowercase().ends_with(".docx") && !target.to_lowercase().ends_with(".docm") {
                return Err("openEditedCopy: not a Word document".into());
            }
            if !std::path::Path::new(target).is_file() {
                return Err("openEditedCopy: the file is not on the disk".into());
            }
            #[cfg(windows)]
            {
                std::process::Command::new("explorer.exe")
                    .arg(target)
                    .spawn()
                    .map_err(|e| format!("The edited copy could not be opened: {}", e))?;
            }
            Ok(json!(true))
        }
        // The code sandbox asking the user to approve what it is about to run (the same
        // warning the desktop build shows before startRun / startCommand).
        "confirmRun" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let title = arr.first().and_then(Value::as_str).unwrap_or("MKMN");
            let message = arr.get(1).and_then(Value::as_str).unwrap_or("");
            let detail = arr.get(2).and_then(Value::as_str).unwrap_or("");
            let ok_label = arr.get(3).and_then(Value::as_str).unwrap_or("Run");
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            let (tx, rx) = std::sync::mpsc::channel::<bool>();
            // this plugin version has no separate detail line: the code rides under the question
            let full = if detail.is_empty() {
                message.to_string()
            } else {
                format!("{}\n\n{}", message, detail)
            };
            app.dialog()
                .message(full)
                .title(title)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(ok_label.to_string(), "Cancel".to_string()))
                .show(move |approved| {
                    let _ = tx.send(approved);
                });
            let approved = tokio::task::spawn_blocking(move || {
                rx.recv_timeout(Duration::from_secs(600)).unwrap_or(false)
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(json!(approved))
        }
        // A built site or a report, opened with the system's default program. Only an existing
        // .html/.htm page inside the temp site folder is accepted: anything else (an .hta, a
        // .cmd, a script) the system would run as a program with the user's rights.
        "openPath" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let target = arr
                .first()
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("openPath: no path was given")?;
            let root = std::env::temp_dir().join("open-npu-site");
            let path = validate_site_open(target, &root)?;
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_path(path.to_string_lossy().to_string(), None::<&str>)
                .map(|_| json!(true))
                .map_err(|e| format!("It could not be opened: {}", e))
        }
        // A finished task or benchmark run, announced from the sidecar.
        "notify" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let title = arr.first().and_then(Value::as_str).unwrap_or("MKMN");
            let body = arr.get(1).and_then(Value::as_str).unwrap_or("");
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map(|_| json!(true))
                .map_err(|e| e.to_string())
        }
        // ---- Computer Use: the ONLY route the sidecar has to the native driver.
        // The AgentDriverHost validates the grant on every call before anything
        // reaches the driver; the sidecar cannot widen its own target.
        "agentListWindows" => {
            let host = app.state::<crate::agent_driver::AgentDriverHost>();
            let windows = host.list_windows().await?;
            serde_json::to_value(windows).map_err(|e| e.to_string())
        }
        "agentObserve" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let hwnd = arr.first().and_then(Value::as_i64).ok_or("agentObserve: no window handle was given")?;
            let max_nodes = arr.get(1).and_then(Value::as_u64).map(|n| n as u32);
            let host = app.state::<crate::agent_driver::AgentDriverHost>();
            host.observe(hwnd, max_nodes).await
        }
        "agentAct" => {
            let arr = args.as_array().cloned().unwrap_or_default();
            let hwnd = arr.first().and_then(Value::as_i64).ok_or("agentAct: no window handle was given")?;
            let action: crate::agent_wire::AgentAction = serde_json::from_value(arr.get(1).cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("agentAct: the action is not one of the driver's kinds: {e}"))?;
            let host = app.state::<crate::agent_driver::AgentDriverHost>();
            host.act(hwnd, action).await
        }
        // The sidecar's run ended (settled or the person stopped it): the grant dies with it.
        "agentEndRun" => {
            let host = app.state::<crate::agent_driver::AgentDriverHost>();
            host.end_grant().await;
            Ok(json!(true))
        }
        // The NPU utilization the monitor loop already sampled through PDH while it is
        // recent; when that sample is stale (a rested monitor can be hours old) a light
        // PDH read is taken here instead, so an old number is never presented as the load
        // now. The sidecar used to spawn PowerShell for this, seconds of CPU per call. A
        // None is "unknown" (the classification withheld the reading), never idle. There
        // is no supported NPU memory reading: memBytes stays null.
        "npuReading" => {
            // the light read may wait a quarter of a second between its two samples:
            // off this async handler's thread
            let util = tokio::task::spawn_blocking(crate::monitor::current_npu_utilization)
                .await
                .map_err(|e| format!("the NPU reading task failed: {}", e))?;
            Ok(json!({ "util": util, "memBytes": Value::Null }))
        }
        // The battery read natively (battery.rs, the class driver's IOCTLs over the
        // enumerated battery devices): the same fields the sidecar's battery reading
        // carries, with nulls where Windows marks the value unknown. Err when the
        // native read FAILED (the enumeration finds nothing while the system still
        // reports a battery) — never a "no battery" the system contradicts. No
        // PowerShell spawn.
        "powerReading" => crate::battery::read_battery_json(),
        other => Err(format!("The host does not offer \"{}\" to the sidecar.", other)),
    }
}

/// Why a path may not be shown in the file manager, if it may not: only an absolute path
/// that exists, never a shell location (`shell:`, `::{CLSID}`) or an extra explorer switch.
fn reveal_target_problem(target: &str) -> Result<(), String> {
    let p = std::path::Path::new(target);
    if target.contains(',') || target.starts_with("::") || target.to_ascii_lowercase().starts_with("shell:") {
        return Err("revealPath: not a plain file path".to_string());
    }
    if !p.is_absolute() || !p.exists() {
        return Err("revealPath: the path is not an existing absolute path".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_path_drops_the_verbatim_prefix_and_keeps_other_paths() {
        use std::path::Path;
        assert_eq!(plain_path(Path::new(r"\\?\C:\Program Files\MKMN")), PathBuf::from(r"C:\Program Files\MKMN"));
        assert_eq!(plain_path(Path::new(r"\\?\UNC\server\share\MKMN")), PathBuf::from(r"\\server\share\MKMN"));
        assert_eq!(plain_path(Path::new(r"C:\Program Files\MKMN")), PathBuf::from(r"C:\Program Files\MKMN"));
        assert_eq!(plain_path(Path::new(r"\\server\share")), PathBuf::from(r"\\server\share"));
    }

    #[test]
    fn reveal_path_takes_only_an_existing_absolute_path() {
        let here = std::env::current_dir().unwrap();
        assert!(reveal_target_problem(here.to_str().unwrap()).is_ok());
        assert!(reveal_target_problem("shell:startup").is_err());
        assert!(reveal_target_problem("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}").is_err());
        assert!(reveal_target_problem("relative\\folder").is_err());
        assert!(reveal_target_problem(r"C:\no\such\folder\mkmn-reveal").is_err());
        assert!(reveal_target_problem(&format!("{},/root,C:\\", here.display())).is_err());
    }

    /// The sidecar's settings save arrives as the patch wrapped in the arguments array;
    /// the unwrap must hand the merge exactly that object (and refuse anything else
    /// loudly — the old code merged the array itself, a silent no-op).
    #[test]
    fn a_wrapped_patch_unwraps_to_its_object() {
        let patch = json!({ "placements": { "m": "npu" } });
        assert_eq!(settings_patch_of_args(&json!([patch])).unwrap(), patch);
    }

    #[test]
    fn anything_but_an_array_wrapped_object_is_refused_with_the_shape_named() {
        // an empty argument array, a non-object patch, a bare object, not an array at all
        for bad in [json!([]), json!([3]), json!(["x"]), json!({ "placements": {} }), json!("save")] {
            let err = settings_patch_of_args(&bad).unwrap_err();
            assert!(err.contains("[patchObject]"), "error must name the expected shape: {}", err);
        }
    }

    #[test]
    fn keepalive_explicit_value_wins() {
        let s = json!({ "keepaliveSec": 600, "idleReleaseSec": 60 });
        assert_eq!(keepalive_from_settings(&s), Some(600));
    }

    #[test]
    fn keepalive_falls_back_to_idle_release() {
        assert_eq!(keepalive_from_settings(&json!({ "idleReleaseSec": 900 })), Some(900));
        // 0 = never release: a 24 h keepalive is as close as the runtime gets.
        assert_eq!(keepalive_from_settings(&json!({ "idleReleaseSec": 0 })), Some(86_400));
    }

    #[test]
    fn keepalive_defers_to_the_strategy_mapping_when_nothing_is_saved() {
        // None lets the supervisor map the loading strategy to its default keepalive.
        assert_eq!(keepalive_from_settings(&json!({})), None);
        assert_eq!(keepalive_from_settings(&json!({ "idleReleaseSec": null })), None);
    }

    #[test]
    fn keepalive_reads_only_a_stored_value_that_passes_its_check() {
        // A stored value of the wrong type or out of range reads as not-saved:
        // the idle-release fallback applies, and with neither, None.
        assert_eq!(keepalive_from_settings(&json!({ "keepaliveSec": "soon", "idleReleaseSec": 7 })), Some(7));
        assert_eq!(keepalive_from_settings(&json!({ "keepaliveSec": "soon" })), None);
        assert_eq!(keepalive_from_settings(&json!({ "keepaliveSec": 99_999 })), None);
    }

    /// A unique temp folder for one test's files.
    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("open-npu-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn open_path_accepts_only_an_existing_page_of_the_site_folder() {
        let root = test_root("validator");
        let site = root.join("site-1");
        std::fs::create_dir_all(&site).unwrap();
        std::fs::write(site.join("index.html"), "<p>x</p>").unwrap();
        std::fs::write(site.join("UPPER.HTML"), "<p>x</p>").unwrap();
        std::fs::write(site.join("page.htm"), "<p>x</p>").unwrap();
        std::fs::write(site.join("app.hta"), "<p>x</p>").unwrap();
        std::fs::write(site.join("run.cmd"), "@echo off").unwrap();
        std::fs::write(site.join("x.js"), "1;").unwrap();
        let outside = std::env::temp_dir().join(format!("open-npu-outside-{}.html", std::process::id()));
        std::fs::write(&outside, "<p>x</p>").unwrap();
        let sub = root.join("folder.html");
        std::fs::create_dir_all(&sub).unwrap();

        for ok in ["index.html", "UPPER.HTML", "page.htm"] {
            let opened = validate_site_open(&site.join(ok).to_string_lossy(), &root);
            assert!(opened.is_ok(), "{} should be accepted: {:?}", ok, opened.err());
            assert!(opened.unwrap().to_string_lossy().ends_with(ok));
        }
        for bad in ["app.hta", "run.cmd", "x.js", "gone.html"] {
            assert!(validate_site_open(&site.join(bad).to_string_lossy(), &root).is_err(), "{} should be refused", bad);
        }
        assert!(validate_site_open(&outside.to_string_lossy(), &root).is_err(), "a path outside the root should be refused");
        assert!(validate_site_open(&sub.to_string_lossy(), &root).is_err(), "a folder inside the root should be refused");
        assert!(validate_site_open("https://example.com/x.html", &root).is_err(), "a web address should be refused");
        assert!(validate_site_open("site-1/index.html", &root).is_err(), "a relative path should be refused");

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }
}
