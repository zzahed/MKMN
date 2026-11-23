// The model methods of the sidecar: finding models (Hugging Face, Docker Hub, Qualcomm AI
// Hub, a pasted name), installing and removing them (one model or a Dynamic pack), the
// GenieX CLI's own model commands, and what this PC measured (identity, speeds, compiled
// contexts). Moved out of main.ts as they were; main.ts owns the catalog, the installs in
// progress, the hardware profile and the host channel, and passes them in.
import { lookup as dnsLookup } from "node:dns/promises";
import * as fs from "fs";
import * as path from "path";
import { browse as browseCore, dockerVariants as dockerVariantsCore } from "../../core/browse";
import { ref as entryRef } from "../../core/catalog";
import type { DockerClient } from "../../core/docker";
import { entryMatches, installedOf, packParts, type BundleModel } from "../../core/dynamic";
import { DYNAMIC_DATA } from "../../core/dynamic-data";
import { canonicalName, cleanAll, configList, diskCheck, freeDiskGB, modelsDir, nameVariants, pullModel, setModelType, type Pull } from "../../core/geniex";
import type { HfClient } from "../../core/hf";
import type { EvidenceKind } from "../../core/manifest";
import { resolveModelIdentity } from "../../core/modelIdentity";
import { nativeRow, type NativeBundle } from "../../core/native";
import { pinnedGet } from "../../core/netGuard";
import { compiledContextOf } from "../../core/qairt";
import { resolveModel } from "../../core/resolve";
import { speedsById as mergeSpeeds } from "../../core/speeds";
import { readBool } from "../../shared/settingsSchema";
import type { BrowseQuery, BrowseResult, CatalogEntry, HardwareProfile, HfSearchResult, InstallProgress, Settings } from "../../shared/types";
import type { SidecarDispatcher, SidecarMessage } from "../protocol";

type InstallResult = { ok: boolean; error?: string; cancelled?: boolean; alreadyInstalled?: boolean };

export interface ModelDeps {
  hf: HfClient;
  docker: DockerClient;
  nativeBundles: () => Promise<NativeBundle[]>;
  chatHardware: () => Promise<HardwareProfile>;
  hardware: (refresh?: boolean) => Promise<HardwareProfile>;
  settings: () => Settings;
  /** The person's own resolved and downloaded models (custom-models.json). */
  saveCustom: (e: CatalogEntry) => void;
  customModels: () => CatalogEntry[];
  refreshInstalledOnly: () => Promise<CatalogEntry[]>;
  /** The GenieX pulls and the Foundry downloads in progress, by ref, so an install can be cancelled. */
  pulls: Map<string, Pull>;
  foundryDownloads: Map<string, AbortController>;
  installEntry: (entry: CatalogEntry, pullAs?: string) => Promise<InstallResult>;
  installPackModel: (m: BundleModel) => Promise<{ done: boolean; failures: string[]; cancelled?: boolean }>;
  installFoundryEntry: (entry: CatalogEntry) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
  uninstallFoundryEntry: (entry: CatalogEntry) => Promise<{ ok: boolean; message: string }>;
  /** A model the app does not know is load-tested once after it is installed. */
  checkNewModel: (entry: CatalogEntry) => Promise<void>;
  removeGeniexModel: (ref: string, why: string) => Promise<{ ok: boolean; out: string }>;
  geniexExe: () => string;
  emitEvent: (name: string, payload: unknown) => void;
  recordEvidence: (records: Array<{ kind: EvidenceKind; ref: string; result?: unknown }>) => Promise<unknown>;
  installedEntries: () => Promise<CatalogEntry[]>;
  isFoundryEntry: (e: CatalogEntry) => boolean;
  allEntries: () => CatalogEntry[];
  /** speeds.json: the generation speeds measured here, by catalog id. */
  speedFile: () => string;
  readJson: <T>(file: string, fallback: T) => T;
  write: (m: SidecarMessage) => Promise<void>;
}

export function registerModels(dispatcher: SidecarDispatcher, deps: ModelDeps): void {
  const {
    hf, docker, nativeBundles, chatHardware, hardware, settings, saveCustom, customModels, refreshInstalledOnly,
    pulls, foundryDownloads, installEntry, installPackModel, installFoundryEntry, uninstallFoundryEntry, checkNewModel,
    removeGeniexModel, geniexExe, emitEvent, recordEvidence, installedEntries, isFoundryEntry, allEntries, speedFile, readJson, write,
  } = deps;

  dispatcher.register("hfSearch", async (query: string): Promise<HfSearchResult[]> => {
    return typeof query === "string" ? hf.search(query) : [];
  });

  dispatcher.register("browse", async (q: BrowseQuery): Promise<BrowseResult> => {
    const hw = await chatHardware();
    const notes: string[] = [];
    const want = (id: BrowseQuery["sources"][number]) => q.sources.includes(id);
    const [h, d, n] = await Promise.all([
      want("hf") ? hf.browse(q).catch((e) => { notes.push(`Hugging Face: ${(e as Error).message}`); return []; }) : [],
      want("docker") ? docker.models(q.sort === "recent" ? "updated" : "pulls").catch((e) => { notes.push(`Docker Hub: ${(e as Error).message}`); return []; }) : [],
      want("aihub") ? nativeBundles().then((b) => b.map((x) => nativeRow(x, hw, compiledContextOf(`ai-hub-models/${x.name}`)))).catch((e) => { notes.push(`Qualcomm AI Hub: ${(e as Error).message}`); return []; }) : []
    ]);
    return browseCore({ hf: h, docker: d, native: n }, hw, q, notes);
  });

  dispatcher.register("dockerVariants", async (name: string) => {
    if (typeof name !== "string" || name.length > 200) return [];
    return dockerVariantsCore(name, await docker.tags(name), await chatHardware());
  });

  dispatcher.register("resolveModel", async (input: string) => {
    const r = await resolveModel({ hf, docker, native: nativeBundles }, input, await hardware(), { showKQuants: readBool(settings(), "showKQuants") });
    if (r.type === "model" && r.inspection.entry) saveCustom(r.inspection.entry);
    return r;
  });

  dispatcher.register("fetchLibrary", async (url: string) => {
    if (typeof url !== "string" || !/^https:\/\//i.test(url) || url.length > 500) return { ok: false, error: "A library must come from an https address." };
    try {
      // https only, no redirect to this PC or the local network, each address checked by the connection's own lookup
      const r = await pinnedGet(url, { lookup: (host) => dnsLookup(host, { all: true }), maxBytes: 600_000, timeoutMs: 20_000 });
      if (r.status < 200 || r.status >= 300) return { ok: false, error: `The server answered ${r.status}.` };
      if (r.truncated) return { ok: false, error: "This library is over 600 KB: too big to keep with a skill." };
      const source = r.body.toString("utf8");
      if (/^\s*<(!doctype|html)/i.test(source)) return { ok: false, error: "The address gives a web page, not a JavaScript or CSS file." };
      return { ok: true, source, kind: /\.css(\?|$)/i.test(url) || /^text\/css/i.test(String(r.headers["content-type"] ?? "")) ? "css" : "js" };
    } catch (e) { return { ok: false, error: `Could not download it: ${(e as Error).message}` }; }
  });

  dispatcher.register("customEntries", async () => [...customModels() as CatalogEntry[], ...await refreshInstalledOnly()]);

  dispatcher.register("install", async (entry: CatalogEntry) => {
    if (isFoundryEntry(entry)) return installFoundryEntry(entry);
    let r = await installEntry(entry);
    // a native bundle is `qualcomm/X` to this GenieX and `ai-hub-models/X` to older ones: the other name is tried before giving up on it.
    // A CANCELLED first attempt must stay cancelled: the user stopped the install, they did
    // not ask for the same download again under its other name (a cancellation is not a
    // failed provider to be retried).
    if (!r.ok && !r.cancelled && entry.engine === "qairt") for (const name of nameVariants(entryRef(entry)).filter((n) => n !== entryRef(entry))) {
      r = await installEntry(entry, name);
      if (r.ok || r.cancelled) break;
    }
    if (r.ok || r.cancelled || entry.engine !== "qairt") {
      // a model the app does not know is loaded once under the best setting this PC accepts, and gets its badge
      if (r.ok) void checkNewModel(entry).catch(() => undefined);
      return r;
    }
    // a precompiled bundle this chip has no build of: the GGUF of the same model, when a Dynamic pack knows one
    const m = Object.values(DYNAMIC_DATA.packs).flatMap((p) => packParts(p)).find((x) => x.repo === entry.repo && x.altRepos?.length);
    if (!m) return r;
    const alt = await installPackModel(m);
    return alt.done ? { ok: true } : r;
  });

  dispatcher.register("cancelInstall", (ref: string) => {
    pulls.get(String(ref))?.cancel();
    foundryDownloads.get(String(ref))?.abort();
  });

  dispatcher.register("uninstall", async (entry: CatalogEntry) => {
    if (isFoundryEntry(entry)) return uninstallFoundryEntry(entry);
    const r = await removeGeniexModel(entryRef(entry), "the person removed it in Models");
    return { ok: r.ok, message: r.out.trim() };
  });

  // ---- GenieX model management (the CLI's own commands, surfaced in MKMN)

  /** `geniex model set-type <name> <llm|vlm>`: which path a cached model takes. */
  dispatcher.register("geniexSetType", async (input: { name?: string; type?: string }) => {
    const exe = geniexExe();
    const name = String(input?.name ?? "").trim();
    const type = String(input?.type ?? "").trim().toLowerCase();
    if (!name) return { ok: false, message: "Name the model first." };
    if (type !== "llm" && type !== "vlm") return { ok: false, message: "The type must be llm or vlm." };
    const r = await setModelType(exe, name, type);
    return { ok: r.ok, message: r.ok ? `${name} now installs as a ${type.toUpperCase()}.` : r.out || "geniex refused the change" };
  });

  /** `geniex config list`: the CLI's own stored configuration (chipset and friends), as text. */
  dispatcher.register("geniexConfigList", async (): Promise<{ ok: boolean; text?: string; error?: string }> => {
    try {
      const exe = geniexExe();
      return { ok: true, text: await configList(exe) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  /** `geniex clean`: remove every cached model. The UI confirms twice; a refusal is reported. */
  dispatcher.register("geniexClean", async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const exe = geniexExe();
      const r = await cleanAll(exe);
      return { ok: r.ok, message: r.ok ? (r.out || "All cached models were removed.") : r.out };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });

  /** The byte size of a file, or of a folder walked recursively (0 when it cannot be read). */
  function sourceBytes(p: string): number {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return st.size;
      if (!st.isDirectory()) return 0;
      let total = 0;
      for (const entry of fs.readdirSync(p)) total += sourceBytes(path.join(p, entry));
      return total;
    } catch {
      return 0;
    }
  }

  /** `geniex pull <name> --local-path <path> [--model-type llm|vlm]`: import a local model
   *  folder or an AI Hub .zip. Progress rides the same `install` events as a normal install,
   *  keyed by the local name, so the Models library shows one familiar progress card. */
  dispatcher.register("geniexPullLocal", async (input: { path?: string; name?: string; type?: string }) => {
    const exe = geniexExe();
    const localPath = String(input?.path ?? "").trim();
    const name = String(input?.name ?? "").trim();
    if (!localPath) return { ok: false, error: "Choose a model folder or an AI Hub .zip file first." };
    if (!fs.existsSync(localPath)) return { ok: false, error: "That folder or file does not exist." };
    if (!name || !/^[\w.-]+(\/[\w.-]+)*$/.test(name)) return { ok: false, error: "Give the model a name like local/my-model (letters, digits, dots, dashes, slashes)." };
    const type = String(input?.type ?? "").trim().toLowerCase();
    if (type && type !== "llm" && type !== "vlm") return { ok: false, error: "The model type must be llm or vlm, or left empty so GenieX detects it." };
    const ref = name;
    let last: InstallProgress | null = null;
    const emit = (p: InstallProgress) => { last = p; emitEvent("install", p); };
    let pull: Pull | null = null;
    try {
      // geniex pull COPIES the source into the cache: the free space must hold the source itself.
      const needGB = Math.max(sourceBytes(localPath) / 1024 ** 3, 0.1);
      emit({ ref, phase: "checking", percent: null, line: "Checking disk space" });
      const disk = diskCheck(freeDiskGB(modelsDir()), needGB);
      if (disk) { emit({ ref, phase: "error", percent: null, error: disk }); return { ok: false, error: disk.title }; }
      emit({ ref, phase: "downloading", percent: null, line: `Importing ${localPath}` });
      pull = pullModel(exe, ref, (x) => emit({ ...x, ref }), undefined, { localPath, ...(type ? { modelType: type as "llm" | "vlm" } : {}) });
      pulls.set(ref, pull);
      await pull.done;
    } catch (e) {
      emit({ ref, phase: "error", percent: null, error: { id: "install", title: "Import could not start", fix: "See the raw message below.", raw: String((e as Error).message) } });
    } finally {
      pulls.delete(ref);
    }
    if (pull?.cancelled) return { ok: false, cancelled: true, error: "cancelled" };
    // The closure-assigned `last` is re-widened by hand (the same as installEntry above):
    // the type checker cannot see through `emit`.
    const end = last as InstallProgress | null;
    const ok = end?.phase === "done";
    if (ok) void recordEvidence([{ kind: "download-verified", ref }]);
    return ok ? { ok: true, name: ref } : { ok: false, error: (end?.error as { title?: string } | undefined)?.title ?? end?.phase ?? "not finished" };
  });

  dispatcher.register("installDynamic", async (packId: string) => {
    const pack = DYNAMIC_DATA.packs[packId];
    if (!pack) return;
    const have = await installedEntries().catch(() => [] as CatalogEntry[]);
    const todo = packParts(pack).filter((m) => !installedOf(m, have));
    const say = (p: { tier: string; name: string; step: number; total: number; phase: "start" | "done" | "error"; error?: string; cancelled?: boolean }) => emitEvent("dynamicInstall", p);
    let step = 0;
    for (const m of todo) {
      step++;
      say({ tier: packId, name: m.name, step, total: todo.length, phase: "start" });
      // A cancellation ends the WHOLE pack run: moving on to the next model would start
      // new downloads behind the back of a user who just pressed stop.
      const { done, failures, cancelled } = await installPackModel(m);
      say({ tier: packId, name: m.name, step, total: todo.length, phase: done ? "done" : "error", error: done ? undefined : cancelled ? `Stopped before ${m.name} finished installing.` : `Could not install ${m.name} from any provider. ${failures.join("; ")}`, cancelled: done ? undefined : cancelled });
      if (cancelled) break;
    }
  });

  // One model of a pack, for the voice chat pack: the speech models and this one are installed together, not the whole pack.
  dispatcher.register("installDynamicModel", async (packId: string, ref: string) => {
    const m = packParts(DYNAMIC_DATA.packs[packId] ?? ({ models: [] } as never)).find((x) => x.ref === ref);
    if (!m) return;
    const say = (p: { tier: string; name: string; step: number; total: number; phase: "start" | "done" | "error"; error?: string; cancelled?: boolean }) => emitEvent("dynamicInstall", p);
    say({ tier: packId, name: m.name, step: 1, total: 1, phase: "start" });
    const { done, failures, cancelled } = await installPackModel(m);
    say({ tier: packId, name: m.name, step: 1, total: 1, phase: done ? "done" : "error", error: done ? undefined : cancelled ? "Stopped before the install finished." : `Could not install ${m.name} from any provider. ${failures.join("; ")}`, cancelled: done ? undefined : cancelled });
  });

  // One click removes every installed model of a pack. A model that two packs share goes too: it is installed again with the other pack.
  // The model server is stopped by the caller (the bridge) before this runs: the sidecar does not own the server, the Rust host does.
  dispatcher.register("uninstallDynamic", async (packId: string) => {
    const pack = DYNAMIC_DATA.packs[packId];
    if (!pack) return { ok: false, removed: [] as string[], failed: [] as string[] };
    const have = await installedEntries().catch(() => [] as CatalogEntry[]);
    const removed: string[] = [], failed: string[] = [];
    for (const m of packParts(pack)) {
      const e = installedOf(m, have);
      if (!e) continue;
      const r = await removeGeniexModel(entryRef(e), `the person removed the ${packId} pack`);
      (r.ok ? removed : failed).push(m.name);
    }
    return { ok: failed.length === 0, removed, failed };
  });

  dispatcher.register("resolveModelIdentity", (id: string) => resolveModelIdentity(String(id), {
    customEntries: customModels() as CatalogEntry[],
  }));

  /** Measured speeds of the Dynamic pack models, by the pack model's own ref (the same
   * mapping the desktop build's speedsByRef does): only models ACTUALLY timed here are
   * reported, so the UI never quotes an invented figure for a model it never ran. */
  dispatcher.register("speedsByRef", async (): Promise<Record<string, number>> => {
    const all = readJson<Record<string, number>>(speedFile(), {});
    const entries = allEntries();
    const out: Record<string, number> = {};
    for (const pack of Object.values(DYNAMIC_DATA.packs)) {
      for (const m of packParts(pack)) {
        const e = entries.find((x) => x.dynamicRef === m.ref || entryMatches(x, m.ref) || entryMatches(x, m.repo) || entryMatches(x, m.name));
        if (e && all[e.id]) out[m.ref] = all[e.id];
      }
    }
    return out;
  });

  /** Measured generation speeds by catalog id, for the model menu: the chat EMA and
   * the benchmark evidence merged (the EMA wins; see core/speeds.ts). Only models
   * this machine actually timed appear — no estimate is invented here. */
  dispatcher.register("speedsById", async (): Promise<Record<string, number>> => {
    const evidence = await dispatcher.callHost(
      (m) => { void write(m); }, "getModelEvidence", [], 30_000
    ).then((r) => (Array.isArray(r) ? (r as import("../../core/manifest").EvidenceRecord[]) : []))
      .catch(() => [] as import("../../core/manifest").EvidenceRecord[]);
    return mergeSpeeds(readJson<Record<string, number>>(speedFile(), {}), evidence, allEntries(), entryMatches, (e) => entryRef(e));
  });

  /** The compiled window of every installed QAIRT pack artifact, keyed by the pack's model ref
   * (canonical, ai-hub-models counts as qualcomm). Read from each bundle's own genie_config.json —
   * the per-artifact evidence the renderer and the pack verdicts need but cannot read themselves
   * (the renderer never touches the file system). A bundle that is not installed (or says nothing)
   * is simply absent: the caller then labels its context number as an estimate. */
  dispatcher.register("compiledContexts", (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const pack of Object.values(DYNAMIC_DATA.packs)) {
      for (const m of packParts(pack)) {
        if (!/^ai-hub-models\//i.test(m.repo)) continue;
        const v = compiledContextOf(m.repo);
        if (v !== null) out[canonicalName(m.repo)] = v;
      }
    }
    return out;
  });
}
