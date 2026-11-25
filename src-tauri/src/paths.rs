use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use serde_json::Value;

/// Returns %LOCALAPPDATA%\MKMN
///
/// In test builds the whole data root is redirected into a per-process temp
/// directory: no cargo test may ever read or write the real user data (a test
/// that resolves the real settings file through a code path like
/// `find_geniex` → `load_settings` once repaired the user's file for real).
/// Tests that exercise file logic directly pass their own paths
/// (`test_settings_dir`) and keep working unchanged; tests that read the
/// environment (LOCALAPPDATA, USERPROFILE) directly are unaffected too.
/// The test folders this crate's tests create in TEMP, named `<prefix><pid>` or
/// `<prefix><pid>-<n>`: removed when the process that made them is gone.
#[cfg(test)]
const TEST_DIR_PREFIXES: [&str; 4] = ["mkmn-cargo-test-root-", "mkmn-adopt-test-", "mkmn-liveness-test-", "mkmn-npu-recovery-test-"];

/// The settings tests' files and folders, named `<prefix><tag>-<pid>-<nanos>` (the tag
/// may hold dashes, so the pid is the second part from the end).
#[cfg(test)]
const TAGGED_TEST_PREFIXES: [&str; 2] = ["mkmn-settings-test-", "mkmn-settings-repair-test-"];

/// The process id a test folder name carries, when it is one of ours.
#[cfg(test)]
pub(crate) fn test_dir_pid(name: &str) -> Option<u32> {
    if let Some(rest) = TAGGED_TEST_PREFIXES.iter().find_map(|p| name.strip_prefix(p)) {
        let rest = rest.strip_suffix(".json").unwrap_or(rest);
        let parts: Vec<&str> = rest.split('-').collect();
        return if parts.len() >= 3 { parts[parts.len() - 2].parse().ok() } else { None };
    }
    let rest = TEST_DIR_PREFIXES.iter().find_map(|p| name.strip_prefix(p))?;
    rest.split('-').next()?.parse().ok()
}

#[cfg(test)]
fn process_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let _ = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        code == 259 // STILL_ACTIVE
    }
}

#[cfg(test)]
fn sweep_stale_test_dirs() {
    let me = std::process::id();
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(pid) = test_dir_pid(&name)
            && pid != me && !process_running(pid) {
                let p = e.path();
                let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            }
    }
}

pub fn get_local_appdata() -> PathBuf {
    #[cfg(test)]
    {
        static TEST_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        TEST_ROOT
            .get_or_init(|| {
                // the folders earlier test runs left behind (this root, and the fake
                // geniex copies of the supervisor and recovery tests) are removed once
                // the run that made them has ended; a run still going is left alone
                sweep_stale_test_dirs();
                let dir = std::env::temp_dir().join(format!("mkmn-cargo-test-root-{}", std::process::id()));
                let _ = fs::create_dir_all(&dir);
                dir
            })
            .clone()
    }

    #[cfg(not(test))]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            PathBuf::from(local).join("MKMN")
        } else if let Ok(profile) = std::env::var("USERPROFILE") {
            PathBuf::from(profile).join("AppData").join("Local").join("MKMN")
        } else {
            PathBuf::from(".").join("data")
        }
    }
}

pub fn get_geniex_dir() -> PathBuf {
    get_local_appdata().join("GenieX")
}

pub fn get_geniex_models_dir() -> PathBuf {
    get_geniex_dir().join("models")
}

/// The model caches the GenieX CLI itself uses, in preference order:
/// `%GENIEX_DATADIR%\models` when the override is set, then `~\.cache\geniex\models` —
/// the same resolution the sidecar's `modelsDir()` (src/core/geniex.ts) performs — and
/// finally the legacy app-local location. Estimation and inventory must read the cache
/// geniex.exe actually writes, which is not the app-local one.
pub fn get_geniex_models_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(over) = std::env::var("GENIEX_DATADIR")
        && !over.trim().is_empty() {
            dirs.push(PathBuf::from(&over).join("models"));
        }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(profile).join(".cache").join("geniex").join("models"));
    } else if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join(".cache").join("geniex").join("models"));
    }
    let legacy = get_geniex_dir().join("models");
    if !dirs.contains(&legacy) {
        dirs.push(legacy);
    }
    dirs
}

/// `%LOCALAPPDATA%\MKMN\QAIRT`: the QAIRT runtimes a native model runs against (`qairt_runtime.rs`).
pub fn get_qairt_dir() -> PathBuf {
    get_local_appdata().join("QAIRT")
}

pub fn get_config_dir() -> PathBuf {
    get_local_appdata().join("Config")
}

pub fn get_settings_path() -> PathBuf {
    get_config_dir().join("settings.json")
}

pub fn get_hardware_path() -> PathBuf {
    get_config_dir().join("hardware.json")
}

pub fn get_custom_models_path() -> PathBuf {
    get_config_dir().join("custom-models.json")
}

pub fn get_logs_dir() -> PathBuf {
    get_local_appdata().join("Logs")
}

pub fn get_mkmn_log_path() -> PathBuf {
    get_logs_dir().join("mkmn.log")
}

pub fn get_geniex_log_path() -> PathBuf {
    get_logs_dir().join("geniex.log")
}

pub fn get_workspace_dir() -> PathBuf {
    get_local_appdata().join("Workspace")
}

pub fn get_voice_models_dir() -> PathBuf {
    get_workspace_dir().join("voice-models")
}

pub fn get_conversations_path() -> PathBuf {
    get_workspace_dir().join("conversations.json")
}

pub fn get_artifacts_path() -> PathBuf {
    get_workspace_dir().join("artifacts.json")
}

/// Create an NTFS Directory Junction from `link` pointing to `target`.
/// Requires zero administrator privileges on NTFS volumes.
pub fn create_junction(link: &Path, target: &Path) -> bool {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "mklink", "/J", link.to_str().unwrap_or(""), target.to_str().unwrap_or("")]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = cmd.output();
    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Ensures the standard Windows Enterprise application directory architecture:
/// %LOCALAPPDATA%\MKMN\
/// ├── GenieX\
/// │   └── models\           <-- Controlled via GENIEX_DATADIR
/// ├── Config\               <-- settings.json, hardware.json, custom-models.json
/// ├── Logs\                 <-- mkmn.log, geniex.log (each rotated to <name>.1.log at 1 MiB)
/// └── Workspace\            <-- conversations, artifacts, voice-models
pub fn init_filesystem() {
    let local = get_local_appdata();
    let geniex_dir = get_geniex_dir();
    let config_dir = get_config_dir();
    let logs_dir = get_logs_dir();
    let workspace_dir = get_workspace_dir();
    let voice_dir = get_voice_models_dir();

    let _ = fs::create_dir_all(&local);
    let _ = fs::create_dir_all(&geniex_dir);
    let _ = fs::create_dir_all(&config_dir);
    let _ = fs::create_dir_all(&logs_dir);
    let _ = fs::create_dir_all(&workspace_dir);
    let _ = fs::create_dir_all(&voice_dir);

    append_log("mkmn", &format!("MKMN v{} filesystem initialized.", crate::system::app_version()));

    // The sidecar wrote custom-models.json to %APPDATA%\MKMN while the host read
    // %LOCALAPPDATA%\MKMN\Config. Copy any such file into Config once, always, leaving
    // the roaming source in place: a small settings file, not the multi-gigabyte opt-in
    // migration below.
    import_legacy_custom_models();

    // Legacy migration moves/copies multi-gigabyte assets from prior installations.
    // It must never happen just because the app launched: it runs only when the user
    // explicitly opted in via the "migrateLegacyData" setting (default: false).
    if legacy_migration_enabled() {
        perform_zero_copy_migration();
    } else if legacy_data_present() {
        append_log("mkmn", "[migration] Legacy data detected but migration is not enabled (settings: migrateLegacyData=false); leaving prior installations untouched.");
    }
}

/// Copy an earlier sidecar custom-models.json into the host's Config directory.
/// Copy, never move or delete: the source is the person's only other copy until they
/// choose to remove it.
fn import_legacy_custom_models() {
    let target = get_custom_models_path();
    if target.exists() {
        return;
    }
    let roaming = match std::env::var_os("APPDATA") {
        Some(p) => PathBuf::from(p),
        None => return,
    };
    let legacy = roaming.join("MKMN").join("custom-models.json");
    if !legacy.is_file() {
        return;
    }
    match fs::copy(&legacy, &target) {
        Ok(_) => {
            append_log("mkmn", &format!("[migration] Copied legacy custom models {:?} -> {:?} (source preserved)", legacy, target));
            record_migration_step("copy", &legacy, &target, "ok (source preserved)");
        }
        Err(e) => append_log("mkmn", &format!("[migration] WARNING: failed to copy legacy custom models {:?}: {}", legacy, e)),
    }
}

/// Migration is strictly opt-in. Nothing is moved or linked until the user has set
/// "migrateLegacyData": true in settings.json.
fn legacy_migration_enabled() -> bool {
    crate::settings::load_settings()
        .get("migrateLegacyData")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// True when at least one known legacy asset location exists — used only for logging.
fn legacy_data_present() -> bool {
    let candidates = [
        std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join(".cache").join("geniex").join("models")),
        std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join(".geniex").join("models")),
        std::env::var("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("models")),
        std::env::var("APPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("voice-models")),
        std::env::var("APPDATA").map(|p| PathBuf::from(p).join("MKMN").join("models")),
    ];
    candidates.iter().flatten().any(|c| c.exists())
}

/// Append a recoverable record of one migration step to Config\migration-log.json.
fn record_migration_step(action: &str, source: &Path, target: &Path, result: &str) {
    let log_path = get_config_dir().join("migration-log.json");
    let mut entries: Vec<Value> = fs::read_to_string(&log_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    entries.push(serde_json::json!({
        "timestamp": timestamp,
        "action": action,
        "source": source.to_string_lossy(),
        "target": target.to_string_lossy(),
        "result": result,
    }));

    if let Ok(serialized) = serde_json::to_string_pretty(&entries) {
        let _ = fs::create_dir_all(get_config_dir());
        let _ = fs::write(&log_path, serialized);
    }
}

/// Legacy data migration (OPT-IN, see `legacy_migration_enabled`):
/// Migrates existing multi-gigabyte models and state from legacy paths
/// (earlier app folders, %USERPROFILE%\.geniex, %USERPROFILE%\.cache\geniex)
/// using NTFS Directory Junctions or copies. Sources are preserved wherever
/// possible and every step is recorded to Config\migration-log.json so it can
/// be reviewed or rolled back.
pub fn perform_zero_copy_migration() {
    let target_models = get_geniex_models_dir();

    // 1. GenieX Models Migration (Zero-Copy NTFS Junction)
    if !target_models.exists() {
        let legacy_candidates = [
            std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join(".cache").join("geniex").join("models")),
            std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join(".geniex").join("models")),
            std::env::var("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("models")),
            std::env::var("APPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("models")),
            std::env::var("APPDATA").map(|p| PathBuf::from(p).join("MKMN").join("models")),
        ];

        for candidate in legacy_candidates.iter().flatten() {
            if candidate.exists() && candidate.is_dir() {
                if create_junction(&target_models, candidate) {
                    // Zero-copy: the source tree stays exactly where it is and can be
                    // removed by hand at any time to roll back.
                    append_log("mkmn", &format!("[migration] Created zero-copy NTFS junction: {:?} -> {:?}", target_models, candidate));
                    record_migration_step("junction", candidate, &target_models, "ok (source preserved; delete junction to roll back)");
                    break;
                } else if fs::rename(candidate, &target_models).is_ok() {
                    append_log("mkmn", &format!("[migration] Atomically moved model directory: {:?} -> {:?}", candidate, target_models));
                    record_migration_step("move", candidate, &target_models, "ok (source moved; original location no longer exists)");
                    break;
                } else {
                    append_log("mkmn", &format!("[migration] FAILED to migrate model directory {:?} -> {:?}; source left untouched.", candidate, target_models));
                    record_migration_step("junction+move", candidate, &target_models, "failed (source left untouched)");
                }
            }
        }
    }

    // 2. Voice Models Migration
    let target_voice = get_voice_models_dir();
    let legacy_voice_candidates = [
        std::env::var("APPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("voice-models")),
        std::env::var("APPDATA").map(|p| PathBuf::from(p).join("MKMN").join("voice-models")),
        std::env::var("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("voice-models")),
    ];

    for candidate in legacy_voice_candidates.iter().flatten() {
        if candidate.exists() && candidate.is_dir()
            && let Ok(entries) = fs::read_dir(candidate) {
                for entry in entries.flatten() {
                    let dest = target_voice.join(entry.file_name());
                    if !dest.exists() {
                        // Copy, not move: the source asset stays in the prior
                        // installation until the user removes it, so a failed or
                        // regretted migration loses nothing.
                        match copy_dir_recursive(&entry.path(), &dest) {
                            Ok(count) => {
                                append_log("mkmn", &format!(
                                    "[migration] Copied voice model {:?} -> {:?} ({} items; source preserved)",
                                    entry.path(), dest, count
                                ));
                                record_migration_step("copy", &entry.path(), &dest, "ok (source preserved)");
                            }
                            Err(e) => {
                                append_log("mkmn", &format!(
                                    "[migration] WARNING: failed to copy voice model {:?} -> {:?}: {}",
                                    entry.path(), dest, e
                                ));
                                record_migration_step("copy", &entry.path(), &dest, &format!("failed: {}", e));
                                let _ = fs::remove_dir_all(&dest);
                            }
                        }
                    }
                }
            }
    }

    // 3. Settings Migration
    let target_settings = get_settings_path();
    if !target_settings.exists() {
        let legacy_settings = [
            std::env::var("APPDATA").map(|p| PathBuf::from(p).join("MKMN").join("settings.json")),
            std::env::var("APPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("settings.json")),
        ];
        for candidate in legacy_settings.iter().flatten() {
            if candidate.exists() {
                // Copy leaves the legacy file in place; nothing is lost if the new
                // settings turn out to be unusable.
                match fs::copy(candidate, &target_settings) {
                    Ok(_) => {
                        append_log("mkmn", &format!("[migration] Migrated settings from {:?}", candidate));
                        record_migration_step("copy", candidate, &target_settings, "ok (source preserved)");
                    }
                    Err(e) => {
                        append_log("mkmn", &format!("[migration] WARNING: failed to copy settings {:?}: {}", candidate, e));
                        record_migration_step("copy", candidate, &target_settings, &format!("failed: {}", e));
                    }
                }
                break;
            }
        }
    }

    // 4. Hardware Migration
    let target_hw = get_hardware_path();
    if !target_hw.exists() {
        let legacy_hw = [
            std::env::var("APPDATA").map(|p| PathBuf::from(p).join("MKMN").join("hardware.json")),
            std::env::var("APPDATA").map(|p| PathBuf::from(p).join("Open-NPU").join("hardware.json")),
        ];
        for candidate in legacy_hw.iter().flatten() {
            if candidate.exists() {
                match fs::copy(candidate, &target_hw) {
                    Ok(_) => {
                        append_log("mkmn", &format!("[migration] Migrated hardware profile from {:?}", candidate));
                        record_migration_step("copy", candidate, &target_hw, "ok (source preserved)");
                    }
                    Err(e) => {
                        append_log("mkmn", &format!("[migration] WARNING: failed to copy hardware profile {:?}: {}", candidate, e));
                        record_migration_step("copy", candidate, &target_hw, &format!("failed: {}", e));
                    }
                }
                break;
            }
        }
    }
}

/// Recursively copy a directory tree. Returns the number of entries copied.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<usize> {
    let mut count = 0usize;
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            count += copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path)?;
            count += 1;
        }
    }
    Ok(count)
}

/// The size at which a log moves to `<name>.1.log` and a new one starts. Each log and
/// its one older file stay near this size; an antivirus scan of either stays short.
const LOG_MAX_BYTES: u64 = 1 << 20;

/// `geniex.log` -> `geniex.1.log`. The name keeps its `.log` ending, so
/// scripts/audit-context.mjs reads the older file too.
fn rotated_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("{stem}.1.log"))
}

/// One log file kept open while the process runs. Opening and closing the file for
/// every line made Microsoft Defender scan the whole file again after each line: it
/// scans a changed file when its last handle closes. Writes are unbuffered, so a crash
/// loses nothing that was written.
struct LogSink {
    path: PathBuf,
    max: u64,
    file: Option<fs::File>,
    /// Bytes in the file as this sink knows them; other processes' lines are not counted
    /// until the real size is read at the limit.
    len: u64,
    /// How often the open file is checked against the file under the name (see `still_current`).
    recheck: std::time::Duration,
    checked_at: std::time::Instant,
    #[cfg(test)]
    opens: u32,
}

/// The identity of an open file: its volume and file index. Two handles with the same
/// identity are the same file, whatever its name is now.
fn file_identity(f: &fs::File) -> Option<(u32, u32, u32)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) };
    (ok != 0).then_some((info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
}

impl LogSink {
    fn new(path: PathBuf, max: u64) -> Self {
        Self {
            path,
            max,
            file: None,
            len: 0,
            recheck: std::time::Duration::from_secs(1),
            checked_at: std::time::Instant::now(),
            #[cfg(test)]
            opens: 0,
        }
    }

    /// Whether the open file is still the one under the name. Another MKMN process
    /// that rotated the log moved it away; one that rotated it twice deleted it, and
    /// lines written to a deleted file are in neither log. The name is opened for its
    /// attributes only (no data access, so no antivirus scan), at most once per `recheck`.
    fn still_current(&mut self) -> bool {
        use std::os::windows::fs::OpenOptionsExt;
        if self.checked_at.elapsed() < self.recheck {
            return true;
        }
        self.checked_at = std::time::Instant::now();
        const FILE_READ_ATTRIBUTES: u32 = 0x80;
        let Some(open) = self.file.as_ref().and_then(file_identity) else { return false };
        match fs::OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES).open(&self.path) {
            Ok(named) => file_identity(&named) == Some(open),
            Err(_) => false, // the name is gone: open a new file
        }
    }

    fn open(&mut self) {
        self.file = fs::OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.len = self.file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
        self.checked_at = std::time::Instant::now();
        #[cfg(test)]
        {
            self.opens += 1;
        }
    }

    /// At the limit: when the file under the name is smaller than this sink's count,
    /// another writer rotated it and this handle points at the older file, so it opens
    /// the new one. Otherwise it moves the full file to `<name>.1.log` and starts again.
    fn make_room(&mut self, incoming: u64) {
        let real = fs::metadata(&self.path).map_or(0, |m| m.len());
        if real < self.len {
            self.open();
            if self.len + incoming <= self.max {
                return;
            }
        }
        self.file = None;
        let older = rotated_path(&self.path);
        let _ = fs::remove_file(&older);
        let moved = fs::rename(&self.path, &older).is_ok();
        self.open();
        if !moved {
            // Another process holds the older file: keep writing and try again after
            // another full limit, not on every line.
            self.len = 0;
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        use std::io::Write;
        if self.file.is_none() || !self.still_current() {
            self.open();
        }
        if self.len + bytes.len() as u64 > self.max {
            self.make_room(bytes.len() as u64);
        }
        if let Some(f) = self.file.as_mut()
            && f.write_all(bytes).is_ok()
        {
            self.len += bytes.len() as u64;
        } else {
            self.file = None; // a failed write (the folder was removed): open again next line
        }
    }
}

/// The open logs, one per path. The lock also keeps a line from being split by a
/// rotation in another thread.
static LOG_SINKS: std::sync::Mutex<Vec<LogSink>> = std::sync::Mutex::new(Vec::new());

/// Append log message to %LOCALAPPDATA%\MKMN\Logs\<kind>.log
pub fn append_log(kind: &str, line: &str) {
    let file_path = match kind {
        "geniex" => get_geniex_log_path(),
        _ => get_mkmn_log_path(),
    };
    // The WHOLE line goes out in one write: write!/writeln! on a File issues one
    // syscall per format piece, and concurrent writers — threads in one process,
    // several MKMN processes in the field — interleave at piece granularity,
    // shredding lines mid-timestamp and mid-detail. A single write_all of the
    // fully formatted line is atomic at EOF in append mode.
    let timestamp = chrono_lite_timestamp();
    let mut full = String::with_capacity(timestamp.len() + line.len() + 4);
    full.push('[');
    full.push_str(&timestamp);
    full.push_str("] ");
    full.push_str(line);
    full.push('\n');

    let mut sinks = LOG_SINKS.lock().unwrap_or_else(|e| e.into_inner());
    let at = match sinks.iter().position(|s| s.path == file_path) {
        Some(i) => i,
        None => {
            sinks.push(LogSink::new(file_path, LOG_MAX_BYTES));
            sinks.len() - 1
        }
    };
    sinks[at].write(full.as_bytes());
}

/// The process identity that owns every subsequent startup log line. Multiple MKMN
/// processes write to the same log file (that is how the incident hid:
/// seven processes' lines interleaved with no way to tell whose was whose), so each
/// startup line carries the pid, the version, and the build flavor.
pub fn process_identity() -> String {
    format!(
        "pid={} v={} build={}",
        std::process::id(),
        crate::system::app_version(),
        if cfg!(debug_assertions) { "dev" } else { "installed" }
    )
}

static STARTED_AT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Startup-stage logging with process identity and elapsed time. No settings, chat
/// contents, paths with user names beyond the log file's own location, or secrets
/// ever go through here — only stage names and operational details.
pub fn startup_log(stage: &str, detail: &str) {
    let elapsed_ms = STARTED_AT
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis();
    append_log(
        "mkmn",
        &format!("[startup {} +{}ms] {}: {}", process_identity(), elapsed_ms, stage, detail),
    );
}

/// Lifecycle logging for mechanisms that run at any point in the process's life
/// (the Computer Use grant, the agent-desktop driver process, the shutdown path),
/// in the same identity-bearing format as `startup_log`. The 2026-11 host exits
/// could not be explained because the driver and grant events only reached the
/// tauri log plugin's stdout, never this file; every line here carries the pid,
/// the version, and the build flavor, and NEVER task text or window contents —
/// only handles, pids, stage names, and outcomes.
pub fn lifecycle_log(stage: &str, detail: &str) {
    let elapsed_ms = STARTED_AT
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis();
    append_log(
        "mkmn",
        &format!("[lifecycle {} +{}ms] {}: {}", process_identity(), elapsed_ms, stage, detail),
    );
}

/// The WebView2 user-data folder for THIS build flavor.
///
/// The installed build uses Tauri's default location —
/// `%LOCALAPPDATA%\app.mkmn.desktop\EBWebView` — so the existing installed profile
/// (its settings cache, local storage, chats' browser storage) is untouched.
/// Development builds use a SEPARATE folder: a `tauri dev` run must never read or
/// write the installed app's browser profile, and the two must never contend for
/// its profile lock.
pub fn webview_data_dir() -> PathBuf {
    let folder = if cfg!(debug_assertions) {
        "app.mkmn.desktop-dev"
    } else {
        "app.mkmn.desktop"
    };
    get_local_appdata().join(folder).join("EBWebView")
}

fn chrono_lite_timestamp() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now();
    let dur = now.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:03}", dur.as_secs(), dur.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sweep of earlier runs' test folders only ever matches this crate's own
    /// names, read with the process id that made them.
    #[test]
    fn only_our_test_folders_are_swept() {
        assert_eq!(test_dir_pid("mkmn-cargo-test-root-86092"), Some(86092));
        assert_eq!(test_dir_pid("mkmn-adopt-test-77160-3"), Some(77160));
        assert_eq!(test_dir_pid("mkmn-liveness-test-62944"), Some(62944));
        assert_eq!(test_dir_pid("mkmn-npu-recovery-test-12-0"), Some(12));
        assert_eq!(test_dir_pid("MKMN"), None);
        assert_eq!(test_dir_pid("mkmn-adopt-test-notapid"), None);
        assert_eq!(test_dir_pid("open-npu-setup"), None);
        assert_eq!(test_dir_pid("mkmn-settings-test-sidecar-patch-94228-1794568429249911602.json"), Some(94228));
        assert_eq!(test_dir_pid("mkmn-settings-repair-test-created-fresh-45640-1794514816634746501"), Some(45640));
        assert_eq!(test_dir_pid("mkmn-settings-backup.json"), None);
    }

    /// In test builds the data root is a per-process temp directory: no cargo test
    /// may ever touch the real user data, even through a code path that resolves
    /// the real settings file on its own (the adopt tests once did, and the repair
    /// path rewrote the person's settings.json for real).
    #[test]
    fn in_test_builds_the_data_root_is_a_per_process_temp_dir() {
        let root = get_local_appdata();
        assert!(
            root.starts_with(std::env::temp_dir()),
            "the test data root {:?} must sit under the temp dir, not the real user profile",
            root
        );
        assert!(
            root.to_string_lossy().contains(&format!("mkmn-cargo-test-root-{}", std::process::id())),
            "the test data root {:?} is per process", root
        );
        assert!(get_settings_path().starts_with(&root), "settings resolve inside the test root");
        assert!(get_custom_models_path().starts_with(&root), "custom models resolve inside the test root");
        assert!(get_mkmn_log_path().starts_with(&root), "the app log resolves inside the test root");
        assert!(get_conversations_path().starts_with(&root), "conversations resolve inside the test root");
    }

    /// Lifecycle lines carry the process identity (pid, version, build flavor) so
    /// interleaved processes' lines can be told apart — and they carry no task
    /// text: what goes in is what the log holds.
    #[test]
    fn lifecycle_lines_carry_the_process_identity() {
        // The real boot creates Logs\ via init_filesystem; a bare test process
        // must make it itself for the append to land.
        let _ = fs::create_dir_all(get_logs_dir());
        lifecycle_log("test-stage", "a detail with no task text");
        let log = fs::read_to_string(get_mkmn_log_path()).unwrap_or_default();
        let line = log
            .lines()
            .rev()
            .find(|l| l.contains("test-stage"))
            .expect("the lifecycle line was written");
        assert!(line.contains("[lifecycle "), "the line is tagged as lifecycle: {line}");
        assert!(line.contains("pid="), "the line carries the pid: {line}");
        assert!(line.contains(&format!("v={}", crate::system::app_version())), "the line carries the version: {line}");
        assert!(line.contains("build="), "the line carries the build flavor: {line}");
        assert!(line.ends_with("test-stage: a detail with no task text"), "the line is stage then detail: {line}");
    }

    /// Concurrent writers never shred a line: a log line lands whole or not at
    /// all. writeln! on a File used to issue one syscall per format piece, and
    /// racing writers interleaved at piece granularity — a line came back missing
    /// its leading bracket with the next writer's bracket glued on the tail
    /// (observed live in the release cargo test).
    fn sink_test_dir(tag: &str) -> PathBuf {
        let dir = get_logs_dir().join(format!("sink-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("the sink test folder");
        dir
    }

    /// The log stays open between lines. Opening and closing it for every line made
    /// Microsoft Defender scan the whole file again after each line (a recording showed
    /// geniex.log scanned 16 times, up to 64 ms each).
    #[test]
    fn a_log_is_opened_once_for_many_lines() {
        let path = sink_test_dir("open-once").join("app.log");
        let mut sink = LogSink::new(path.clone(), 1 << 20);
        for i in 0..100 {
            sink.write(format!("line {i}\n").as_bytes());
        }
        assert_eq!(sink.opens, 1, "100 lines need one open, not one per line");
        let text = fs::read_to_string(&path).expect("the log can be read while it is open");
        assert_eq!(text.lines().count(), 100, "every line landed");
    }

    /// A log that passes its size limit moves to `<name>.1.log` and a new one starts,
    /// so neither file grows without end. The `.log` ending keeps the rotated file in
    /// what scripts/audit-context.mjs reads.
    #[test]
    fn a_full_log_rotates_to_one_older_file() {
        let dir = sink_test_dir("rotate");
        let path = dir.join("app.log");
        let older = dir.join("app.1.log");
        let mut sink = LogSink::new(path.clone(), 1000);
        let line = [b'x'; 99].iter().chain(b"\n").copied().collect::<Vec<u8>>();
        for _ in 0..35 {
            sink.write(&line);
        }
        let now = fs::metadata(&path).expect("the current log").len();
        let old = fs::metadata(&older).expect("the rotated log").len();
        assert!(now <= 1000, "the current log stays at its limit: {now} bytes");
        assert!(old <= 1000, "the rotated log stays at its limit: {old} bytes");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "one older file is kept, no more");
        assert_eq!(rotated_path(Path::new("x\\geniex.log")), PathBuf::from("x\\geniex.1.log"));
    }

    /// Several MKMN processes can write one log. When another writer has already
    /// rotated it, this one opens the new file instead of rotating again, which would
    /// move the nearly empty new file over the older one and lose its lines.
    #[test]
    fn a_log_another_writer_rotated_is_not_rotated_again() {
        let dir = sink_test_dir("other-writer");
        let path = dir.join("app.log");
        let line = [b'y'; 99].iter().chain(b"\n").copied().collect::<Vec<u8>>();
        let mut stale = LogSink::new(path.clone(), 1000);
        stale.write(&line); // opened before the other writer rotates
        let mut other = LogSink::new(path.clone(), 1000);
        for _ in 0..12 {
            other.write(&line); // rotates at the 10th line: 3 lines end up in app.log
        }
        for _ in 0..10 {
            stale.write(&line); // its count fills; app.log itself is small
        }
        let old = fs::read_to_string(dir.join("app.1.log")).expect("the rotated log");
        assert!(old.lines().count() >= 10, "the first rotation's lines are kept: {} lines", old.lines().count());
        let now = fs::read_to_string(&path).unwrap();
        assert_eq!(now.lines().count(), 4, "the other writer's 3 lines and the stale writer's last one");
        assert_eq!(stale.opens, 2, "the stale writer opened the new file once");
    }

    /// A quiet writer whose file another writer rotated twice (so the file it held was
    /// deleted) checks the file under the name before it appends, and its line lands in
    /// the current log instead of disappearing (the Codex review on #78).
    #[test]
    fn a_quiet_writer_after_two_rotations_still_lands_its_line() {
        let dir = sink_test_dir("two-rotations");
        let path = dir.join("app.log");
        let line = [b'z'; 99].iter().chain(b"\n").copied().collect::<Vec<u8>>();
        let mut quiet = LogSink::new(path.clone(), 1000);
        quiet.recheck = std::time::Duration::ZERO;
        quiet.write(&line);
        let mut busy = LogSink::new(path.clone(), 1000);
        for _ in 0..25 {
            busy.write(&line); // rotates twice: the file `quiet` holds is removed
        }
        quiet.write(b"the quiet writer's line\n");
        let now = fs::read_to_string(&path).unwrap();
        assert!(now.contains("the quiet writer's line"), "the line is in the current log");
    }

    #[test]
    fn concurrent_log_writes_never_shred_a_line() {
        let _ = fs::create_dir_all(get_logs_dir());
        const THREADS: usize = 8;
        const LINES: usize = 60;
        let handles: Vec<_> = (0..THREADS)
            .map(|t| {
                std::thread::spawn(move || {
                    for i in 0..LINES {
                        lifecycle_log(
                            &format!("race-probe-{t}"),
                            &format!("payload {i} of thread {t} ends here"),
                        );
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().expect("the writer thread did not panic");
        }
        let log = fs::read_to_string(get_mkmn_log_path()).unwrap_or_default();
        let mut seen = 0;
        for line in log.lines().filter(|l| l.contains("race-probe-")) {
            assert!(line.starts_with('['), "every line opens with its timestamp bracket: {line}");
            assert!(
                line.ends_with("ends here"),
                "the detail survives whole, no other writer's bytes inside it: {line}"
            );
            seen += 1;
        }
        assert_eq!(seen, THREADS * LINES, "every concurrent write landed as its own whole line");
    }
}
