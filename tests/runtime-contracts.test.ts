import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itWindows } from "./helpers/platform";

/**
 * Runtime contracts that the installed build must keep (seen on an installed build):
 *   - an elevated launch hands itself to the unelevated shell BEFORE the instance lock,
 *     the job object or any sidecar exists; a one-shot guard prevents a relaunch loop;
 *   - the main window fits the monitor's WORK AREA at 200 % scaling (1440 x 852), instead
 *     of asking for 860 px of height and losing its title bar under the taskbar;
 *   - closing the window starts the shutdown immediately and a native watchdog forces a
 *     bounded exit even when the Tauri exit event never arrives (the hung PID in the report
 *     never wrote a single `[shutdown]` line);
 *   - the after-close check counts only real processes: 0-thread/no-path records are dead
 *     Windows hang-report leftovers, never running instances.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const PS = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

describe("an elevated launch becomes an unelevated one before anything is owned", () => {
  it("the host asks for the relaunch before the instance lock and the job object", () => {
    const lib = read("src-tauri/src/lib.rs");
    const relaunch = lib.indexOf("ensure_unelevated_launch");
    expect(relaunch, "lib.rs must call ensure_unelevated_launch()").toBeGreaterThanOrEqual(0);
    const acquire = lib.indexOf("single_instance::acquire()");
    const job = lib.indexOf("job_object::init_process_lifecycle_guard()");
    expect(relaunch).toBeLessThan(acquire);
    expect(relaunch).toBeLessThan(job);
  });

  it("only a full administrator token relaunches, through the shell, once", () => {
    const si = read("src-tauri/src/single_instance.rs");
    expect(si).toMatch(/pub fn ensure_unelevated_launch/);
    expect(si).toMatch(/TokenIsElevated/);
    expect(si).toMatch(/MKMN_UNELEVATED_RETRY/);
    expect(si).toMatch(/explorer\.exe/);
    // The child must carry the one-shot guard, or the relaunched process would loop.
    expect(si).toMatch(/MKMN_UNELEVATED_RETRY[\s\S]{0,400}(set_var|env\()/);
    // The default token continues and logs; elevation is never silently accepted.
    expect(si).toMatch(/startup_log\(\s*"elevation"/);
  });
});

describe("the window fits the monitor's work area", () => {
  it("does not request a fixed 1280 x 860 window", () => {
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).not.toContain(".inner_size(1280.0, 860.0)");
    expect(lib).toMatch(/fit_window_to_work_area|window_fit::/);
  });

  it("fits the created window from its own monitor before showing it", () => {
    // The pre-build monitor query returned nothing on the installed build, so the
    // old logical 1280x860 was requested again (2560x1720 physical at 200 %). The window
    // must exist first, then be fitted in physical pixels and only then shown.
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).toContain(".visible(false)");
    const build = lib.indexOf(".build()?");
    expect(build, "the window builder must be built").toBeGreaterThan(-1);
    const after = lib.slice(build);
    expect(after).toMatch(/fit_window_to_monitor\(&window/);
    expect(after).toMatch(/primary_monitor|current_monitor/);
    const fnAt = after.indexOf("fn fit_window_to_monitor");
    expect(fnAt, "the fit helper must be defined").toBeGreaterThan(-1);
    const fit = after.slice(fnAt);
    const min = fit.search(/window\.set_min_size\(/);
    const size = fit.search(/window\.set_size\(/);
    expect(min, "the fitted minimum is set before the size, or the old minimum clamps it").toBeGreaterThan(-1);
    expect(size).toBeGreaterThan(min);
    expect(after).toMatch(/set_position/);
    // `set_size` sets the INNER size; the fit describes the whole window, so the
    // measured outer/inner frame must be subtracted or the border overflows the area.
    expect(after).toMatch(/outer_size\(\)/);
    expect(after).toMatch(/inner_size\(\)/);
    expect(after).toMatch(/saturating_sub\(frame\.0\)/);
    expect(after.indexOf(".show()")).toBeGreaterThan(after.indexOf("fit_window_to_monitor(&window"));
  });

  it("has one pure fit function that clamps to the work area and centres the window", () => {
    expect(existsSync(join(ROOT, "src-tauri/src/window_fit.rs")), "src-tauri/src/window_fit.rs is missing").toBe(true);
    const wf = read("src-tauri/src/window_fit.rs");
    expect(wf).toMatch(/pub fn fit_window_to_work_area/);
    expect(wf).toMatch(/pub fn centre_in_work_area/);
    expect(wf).toMatch(/margin/i);
  });
});

describe("closing the window cannot hang the process", () => {
  it("CloseRequested hides the window and starts the coordinated shutdown, not only ExitRequested", () => {
    const lib = read("src-tauri/src/lib.rs");
    const start = lib.indexOf("WindowEvent::CloseRequested");
    const end = lib.indexOf("WindowEvent::Focused");
    expect(start).toBeGreaterThanOrEqual(0);
    const close = lib.slice(start, end);
    expect(close).toContain("shutdown::kick");
    expect(close).toContain("window.hide()");
    // The tray path is an explicit user choice and must not quit.
    expect(close).toMatch(/close_hides_to_tray[\s\S]{0,300}prevent_close/);
  });

  it("arms a native watchdog at shutdown start, below the Windows session-end limit", () => {
    const s = read("src-tauri/src/shutdown.rs");
    const arm = s.indexOf("arm_watchdog(");
    expect(arm, "shutdown must call arm_watchdog()").toBeGreaterThanOrEqual(0);
    const deadline = /WATCHDOG[^=\n]*=\s*Duration::from_(millis|secs)\((\d+)\)/.exec(s);
    expect(deadline, "the watchdog deadline must be an explicit constant").not.toBeNull();
    const ms = deadline![1] === "millis" ? Number(deadline![2]) : Number(deadline![2]) * 1000;
    expect(ms).toBeLessThan(5000);
    expect(s.indexOf("appShutdown", arm)).toBeGreaterThan(arm);
    expect(s).toMatch(/std::process::exit/);
  });

  it("logs every step before running it, and writes a clean-exit marker at the end", () => {
    const s = read("src-tauri/src/shutdown.rs");
    expect(s).toMatch(/step 4\/6[^\n]*sidecar/i);
    expect(s).toMatch(/step 5\/6[^\n]*model server/i);
    expect(s).toMatch(/step 6\/6/i);
    expect(s).toMatch(/clean[- ]exit marker/i);
    expect(s).toMatch(/inventory/i);
  });
});

describe("after-close checking knows what a real process is", () => {
  itWindows("Check-After-Close.ps1 resolves paths and treats 0-thread records as dead", () => {
    const script = join(ROOT, "scripts", "Check-After-Close.ps1");
    expect(existsSync(script), "scripts/Check-After-Close.ps1 is missing").toBe(true);
    const s = read("scripts/Check-After-Close.ps1");
    expect(s).toMatch(/Resolve-MkmnPaths\.ps1/);
    expect(s).toMatch(/Threads/);
    expect(s).toMatch(/clean[- ]exit marker/i);

    const dir = mkdtempSync(join(tmpdir(), "mkmn-after-close-"));
    const out = execFileSync(PS, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-SelfTest", "-Json"
    ], {
      encoding: "utf8",
      env: { ...process.env, MKMN_AFTER_CLOSE_SELFTEST_DIR: dir },
      timeout: 30000
    });
    const r = JSON.parse(out.replace(/^\uFEFF/, "").trim());
    expect(r).toMatchObject({ ok: true, live: 1, zombies: 2 });
  });
});
