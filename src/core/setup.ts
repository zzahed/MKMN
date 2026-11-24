import * as path from "path";
import type { SetupStep, StepId } from "./setupView";

/**
 * Official GenieX Windows ARM64 CLI installer (Qualcomm AI Hub docs, "CLI Install").
 * Found by web search; could not be downloaded from the build sandbox, so the
 * installer's flags and install location are not known: see locateGeniex().
 */
export const GENIEX_INSTALLER_URL = "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/geniex-cli.exe";

/**
 * Where geniex.exe may be after the installer ran: paths printed by the installer,
 * the documented %LOCALAPPDATA%\GenieX CLI folder, and the usual per-user / machine locations.
 */
export function geniexCandidates(installerOutput: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const m of installerOutput.matchAll(/([A-Za-z]:\\[^\r\n"'<>|*?]*?geniex(?:\.exe)?)(?=[\s"'<>|]|$)/gi)) {
    const p = m[1].trim();
    out.push(/\.exe$/i.test(p) ? p : path.win32.join(p, "geniex.exe"));
  }
  // directories printed for PATH ("... added to PATH: C:\Users\x\AppData\Local\GenieX CLI")
  for (const m of installerOutput.matchAll(/([A-Za-z]:\\[^\r\n"'<>|*?]+)/g)) {
    const p = m[1].trim().replace(/[.,;]+$/, "");
    if (!/\.\w{2,4}$/.test(p)) out.push(path.win32.join(p, "geniex.exe"));
  }
  const w = path.win32;
  if (env.LOCALAPPDATA) {
    out.push(w.join(env.LOCALAPPDATA, "GenieX CLI", "geniex.exe"), w.join(env.LOCALAPPDATA, "Programs", "GenieX CLI", "geniex.exe"), w.join(env.LOCALAPPDATA, "Programs", "GenieX", "geniex.exe"), w.join(env.LOCALAPPDATA, "GenieX", "geniex.exe"));
  }
  if (env.USERPROFILE) out.push(w.join(env.USERPROFILE, ".geniex", "bin", "geniex.exe"), w.join(env.USERPROFILE, "geniex", "geniex.exe"));
  for (const k of ["ProgramFiles", "ProgramFiles(Arm)"]) {
    if (env[k]) out.push(w.join(env[k]!, "GenieX CLI", "geniex.exe"), w.join(env[k]!, "GenieX", "geniex.exe"));
  }
  for (const dir of (env.Path ?? env.PATH ?? "").split(";").filter(Boolean)) out.push(w.join(dir, "geniex.exe"));
  return [...new Set(out)];
}

export function locateGeniex(installerOutput: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  return geniexCandidates(installerOutput, env).find((p) => exists(p)) ?? null;
}

export function initialSteps(needs: { geniex: boolean; llama?: boolean; stt: boolean; tts: boolean }, names: { stt: string; tts: string; sttMB?: number; ttsMB?: number }): SetupStep[] {
  const mk = (id: StepId, label: string, detail: string, needed: boolean): SetupStep => ({
    id, label, detail, ...WHAT_IT_DOES[id], sizeMB: id === "voice-stt" ? names.sttMB ?? null : id === "voice-tts" ? names.ttsMB ?? null : null, state: needed ? "pending" : "done", percent: null, message: needed ? null : "Already installed", error: null
  });
  return [
    mk("geniex", "AI engine for the NPU (Qualcomm GenieX)", "Downloaded from Qualcomm", needs.geniex),
    mk("llama", "AI engine for the graphics card and processor (llama.cpp)", "Free and open source, from github.com/ggml-org/llama.cpp", !!needs.llama),
    mk("voice-stt", `Dictation model: ${names.stt}`, "Speech to text, runs locally", needs.stt),
    mk("voice-tts", `Read-aloud model: ${names.tts}`, "Text to speech, runs locally", needs.tts)
  ];
}

/** What each part makes possible and what is left without it, so "Not now" and
 *  "Continue anyway" are choices the person can weigh. */
const WHAT_IT_DOES: Record<StepId, { enables: string; withoutIt: string }> = {
  geniex: { enables: "Chat, files and every model on the NPU", withoutIt: "Without it no model can run; you can still look around and install it later" },
  llama: { enables: "Models on the GPU or the CPU", withoutIt: "Without it only NPU models run" },
  "voice-stt": { enables: "Dictation and voice chat", withoutIt: "Without it you type; everything else works" },
  "voice-tts": { enables: "Answers read aloud and voice chat", withoutIt: "Without it answers stay on screen; everything else works" }
};

// Setup types and pure presentation logic live in the browser-safe ./setupView
// (no Node built-ins), re-exported here so existing imports keep working.
export type { StepId, StepState, SetupStep, SetupState, SetupOutcome, SetupOutcomeView } from "./setupView";
export { setupFinished, setupOutcomeView } from "./setupView";
