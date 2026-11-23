import { checkArtifactWithoutWindow, type SandboxPageReport } from "./pagecheck";
import type { FileLike } from "../bundle";
import { isJs, quickErrors } from "../codecheck";

/**
 * The ONE windowless artifact check the sidecar's build path uses (the desktop build
 * plays the page in a real window; the sidecar has none): an HTML page is played in
 * the VM sandbox — keys pressed, buttons clicked, ticks — and a script or stylesheet
 * is run against the page's stand-ins. Lives in core (not in the sidecar) so the
 * tests can drive the EXACT check a build's Test run consumes.
 *
 * Errors come back with the function they happened in; with `probe` on, controls that
 * changed nothing in the state are named. The scenarios of the page are played too,
 * and their verdicts come back in `scenarios` — the caller judges the finished build
 * by them. What is never claimed here: the screen (screenshots, blank and hidden-
 * element checks) — those stay with the desktop build, and callers treat them as
 * unverified, not as passed.
 */
export async function checkArtifact(a: unknown, all: unknown, o?: { scenarios?: unknown }): Promise<SandboxPageReport> {
  const f = a && typeof a === "object" ? (a as { content?: unknown; title?: string; kind?: string; language?: string }) : null;
  if (!f || typeof f.content !== "string") return { ran: "none", errors: [], notes: [] };
  const files: FileLike[] = Array.isArray(all)
    ? (all as unknown[]).filter((x): x is FileLike => !!x && typeof x === "object" && typeof (x as { content?: unknown }).content === "string")
    : [];
  const scenarios = Array.isArray(o?.scenarios) ? o.scenarios : undefined;
  try {
    if (f.kind === "html") {
      const r = await checkArtifactWithoutWindow(f as { content: string }, files, scenarios);
      // the shape checks that need no run (no <body>, a network load, an element the
      // script looks for that the page does not have) still apply, and stay cheap
      const extra = quickErrors({ title: f.title ?? "file", kind: f.kind, language: f.language ?? "", content: f.content });
      return { ...r, errors: [...new Set([...r.errors, ...extra])] };
    }
    if (f.kind === "code" && (isJs(f.language ?? "") || /^css$/i.test(f.language ?? ""))) {
      return await checkArtifactWithoutWindow(f as { content: string }, files, scenarios);
    }
  } catch {
    // the sandbox itself failed (something in the VM): the shape check below is the
    // honest answer — never a pretend pass, never a made-up "the page crashed"
  }
  const errors = quickErrors({ title: f.title ?? "file", kind: f.kind ?? "code", language: f.language ?? "", content: f.content as string });
  return { ran: errors.length ? "syntax" : "none", errors, notes: [] };
}
