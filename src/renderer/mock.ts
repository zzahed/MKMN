// Browser-only stand-in for the desktop bridge, used by `npm run dev:renderer` and screenshots.
import { DYNAMIC_DATA } from "../core/dynamic-data";
import type { MkmnApi, CatalogItem } from "../shared/api";
import { CATALOG, ref } from "../core/catalog";
import { scoreEntry } from "../core/fit";
import { buildProfile } from "../core/hardware";
import type { Artifact, ChatEvent, Project, ScheduledTask, InstallProgress, ServerStatus, Settings, SpeakChunk, VoiceDownloadProgress, VoiceStatus } from "../shared/types";
import { DEFAULT_VOICE_SETTINGS, VOICE_MODELS } from "../core/voiceModels";
import { planNpu } from "../core/budget";
import { nextRun } from "../core/schedule";
import { VersionBook } from "../core/versionBook";
import type { History } from "../core/versions";
import { textOf } from "../core/attachments";
import type { Session } from "../core/build";
import { SKELETONS } from "../core/skeletons";
import { browse, dockerVariants } from "../core/browse";
import { nativeRow } from "../core/native";
import { createMockBench } from "./mockBench";

export function installMockIfNeeded() {
  if ((window as any).mkmn) return;
  const hw = buildProfile(
    { cpuName: "Snapdragon(R) X Plus - X1P64100 - Qualcomm(R) Oryon(TM) CPU", totalRamBytes: 16 * 1024 ** 3, npuDevices: [{ name: "Hexagon NPU", driverVersion: "30.0.220.3000" }], osArch: "ARM64" },
    "arm64"
  );
  const installed = new Set<string>(["qwen3-4b-thinking-2507", "qwen3-1.7b-native", "lfm2.5-8b-a1b"]);
  let routerInstalled = false;
  let settings: Settings = { geniexPath: "C:\\Users\\demo\\AppData\\Local\\GenieX CLI\\geniex.exe", npuBudgetOverrideGB: null, showKQuants: false, compute: "npu", keepaliveSec: 300, selectedModelId: "qwen3-4b-thinking-2507", pinnedGeniexVersion: null, voice: { ...DEFAULT_VOICE_SETTINGS, sttModelId: "stt-whisper-base", ttsModelId: "tts-kokoro-multi" }, customInstructions: "", effort: "medium", subagents: false, autoCheck: true, reviewerModelId: null, reviewRounds: 2, writers: {}, developer: false, agentLoop: false, agentRounds: 6, agentMinutes: 30, agentGoal: "", openFilesBesideChat: true };
  const vinstalled = new Set<string>(["stt-whisper-base", "tts-kokoro-multi"]);
  let vstatus: VoiceStatus = { worker: "ready", stt: "stt-whisper-base", tts: "tts-kokoro-multi", sttProvider: "cpu", ttsProvider: "cpu", notice: null, ttsSampleRate: 24000, error: null };
  const vl: ((s: VoiceStatus) => void)[] = [], dl: ((p: VoiceDownloadProgress) => void)[] = [], al: ((c: SpeakChunk) => void)[] = [];
  let server: ServerStatus = { state: "ready", endpoint: "http://127.0.0.1:18181/v1", nctx: 16384, compute: "npu", restarts: 0, lastError: null, pid: 1234, model: "unsloth/Qwen3-4B-Thinking-2507-GGUF:Q4_0", hardwareVerification: { verifiedNpu: true, cpuFallbackDetected: false, executionTarget: "npu", powerModeActive: "burst", qosTier: "medium" } };
  const sl: ((s: ServerStatus) => void)[] = [], cl: ((e: ChatEvent) => void)[] = [], il: ((p: InstallProgress) => void)[] = [];
  let projects: Project[] = [], artifacts: Artifact[] = [], tasks: ScheduledTask[] = [];
  const histories = new Map<string, History>();
  const mockMedia = new Map<string, string>();
  const book = new VersionBook(
    { get: (id) => histories.get(id), put: (h) => void histories.set(h.id, h), drop: (id) => void histories.delete(id), list: () => [...histories.values()] },
    { list: () => artifacts, upsert: (a) => { artifacts = artifacts.some((x) => x.id === a.id) ? artifacts.map((x) => (x.id === a.id ? a : x)) : [...artifacts, a]; }, remove: (id) => { artifacts = artifacts.filter((a) => a.id !== id); } }
  );
  const tkl: ((t: ScheduledTask) => void)[] = [];
  /** Local benchmark measurements, mirroring hardware.json's calibratedProfiles: kept
   *  in localStorage so a preview reload exercises the restart/reload path. */
  let benchProfiles: Record<string, any> = (() => {
    try { return JSON.parse(localStorage.getItem("mkmn.mock.benchProfiles") ?? "{}") ?? {}; } catch { return {}; }
  })();
  const persistBenchProfiles = () => { try { localStorage.setItem("mkmn.mock.benchProfiles", JSON.stringify(benchProfiles)); } catch { /* preview only */ } };
  const bl: ((s: import("../core/benchRunner").BenchState) => void)[] = [];
  const ll: ((l: import("../core/benchRunner").BenchLive) => void)[] = [];
  const mockBench = createMockBench((st) => bl.forEach((f) => f(st)), (l) => ll.forEach((f) => f(l)));
  const items = (): CatalogItem[] => CATALOG.map((entry) => ({ entry, verdict: scoreEntry(entry, hw), hidden: !!entry.excluded, installed: installed.has(entry.id), ref: ref(entry), custom: false }));
  const api: MkmnApi = {
    appInfo: async () => ({ version: "0.1.0", arch: "arm64", platform: "win32", geniexPath: settings.geniexPath, geniexVersion: "preview", geniexVersionWarning: null, problems: [] }),
    knowledgeStatus: async () => null,
    knowledgeBuild: async () => null,
    vectorModelStatus: async () => null,
    vectorModelInstall: async () => null,
    vectorModelRemove: async () => null,
    hardware: async () => hw,
    catalog: async () => items(),
    installed: async () => [],
    modelEvidence: async () => ({ manifest: [], records: [] }),
    hfSearch: async () => [{ repo: "unsloth/Qwen3-8B-GGUF", downloads: 120000, likes: 300, updated: null }],
    browse: async (q) => browse({
      hf: [
        { id: "unsloth/Qwen3-4B-Thinking-2507-GGUF", downloads: 410000, likes: 520, lastModified: "2026-09-02T10:00:00Z", pipeline_tag: "text-generation", gguf: { total: 4.02e9, architecture: "qwen3" }, siblings: [{ rfilename: "Qwen3-4B-Thinking-2507-Q4_0.gguf" }, { rfilename: "Qwen3-4B-Thinking-2507-Q8_0.gguf" }] },
        { id: "LiquidAI/LFM2.5-8B-A1B-GGUF", downloads: 98000, likes: 310, lastModified: "2026-10-01T10:00:00Z", pipeline_tag: "text-generation", gguf: { total: 8.3e9, architecture: "lfm2moe" }, siblings: [{ rfilename: "LFM2.5-8B-A1B-Q4_0.gguf" }] },
        { id: "unsloth/Qwen3-VL-8B-Instruct-GGUF", downloads: 150000, likes: 260, lastModified: "2026-09-20T10:00:00Z", pipeline_tag: "image-text-to-text", gguf: { total: 8.2e9, architecture: "qwen3vl" }, siblings: [{ rfilename: "Qwen3-VL-8B-Instruct-Q4_0.gguf" }] },
        { id: "unsloth/Qwen3.5-9B-GGUF", downloads: 80000, likes: 190, lastModified: "2026-10-10T10:00:00Z", gguf: { total: 9e9, architecture: "qwen35" }, siblings: [{ rfilename: "Qwen3.5-9B-Q4_0.gguf" }] },
        { id: "someone/Llama-3.1-8B-GGUF", downloads: 640000, likes: 900, lastModified: "2026-05-02T10:00:00Z", gguf: { total: 8.03e9, architecture: "llama" }, siblings: [{ rfilename: "Llama-3.1-8B-Q4_K_M.gguf" }, { rfilename: "Llama-3.1-8B-Q8_0.gguf" }] }
      ],
      docker: [
        { name: "gemma3", namespace: "ai", description: "Google's Gemma 3 in several sizes", pull_count: 3200000, star_count: 40, last_updated: "2026-08-01T10:00:00Z" },
        { name: "qwen3", namespace: "ai", description: "Qwen3 dense and MoE models", pull_count: 2100000, star_count: 35, last_updated: "2026-09-12T10:00:00Z" }
      ],
      native: [nativeRow({ name: "Qwen3-1.7B" }, hw), nativeRow({ name: "Llama-3.2-1B-Instruct" }, hw)]
    }, hw, q),
    dockerVariants: async (name) => dockerVariants(name, [
      { name: "4B-Q4_0", full_size: 2.4e9, last_updated: "2026-09-01T10:00:00Z" }, { name: "8B-Q4_0", full_size: 4.7e9 }, { name: "8B-Q4_K_M", full_size: 5.0e9 }, { name: "14B-Q4_0", full_size: 8.4e9 }
    ], hw),
    resolveModel: async (input) => ({ type: "search", query: input, note: null }),
    install: async (e) => {
      const r = ref(e);
      for (const p of [10, 40, 75, 100]) { await new Promise((x) => setTimeout(x, 400)); il.forEach((f) => f({ ref: r, phase: p === 100 ? "done" : "downloading", percent: p })); }
      installed.add(e.id);
    },
    cancelInstall: async () => undefined,
    uninstall: async (e) => { installed.delete(e.id); return { ok: true, message: "" }; },
    selectModel: async (id) => { settings = { ...settings, selectedModelId: id }; },
    preloadModel: async (req?: any) => {
      // Report the precise ref (repo:quant) the real runtime announces, falling back
      // to the selected entry's ref — matching supervisor.rs `current_model`.
      const entry = CATALOG.find((e) => e.id === (req?.model || settings.selectedModelId));
      server = { ...server, state: "ready", model: req?.model?.includes("/") ? req.model : entry ? ref(entry) : req?.model || settings.selectedModelId };
      sl.forEach((f) => f(server));
      return server;
    },
    server: async () => server,
    stopServer: async () => { server = { ...server, state: "stopped" }; sl.forEach((f) => f(server)); },
    serverLog: async () => ["listening 127.0.0.1:18181"],
    compactChat: async () => ({ error: "Summaries need the real app." }),
    chat: async (id, _m, msgs, opts?: { buildWanted?: boolean }) => {
      const emit = (e: ChatEvent) => cl.forEach((f) => f(e));
      const lastUser = textOf(msgs[msgs.length - 1]?.content ?? "");
      if (/\bspare key\b/i.test(lastUser)) {
        // the split-vote demo: the votes split (router no, chat model yes), so the
        // request is answered in the chat with the build offered as one action; pressing
        // "Build it instead" sends the same request with buildWanted, and it builds
        const wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
        if (!opts?.buildWanted) {
          emit({ id, type: "notice", text: "Understood as: chat (something that runs to make or change: router no, chat model yes)" });
          emit({ id, type: "offer", offer: { action: "build", request: lastUser } });
          const reply = "The spare key to the reading room is kept in drawer C-12, by the front desk.";
          for (let i = 0; i < reply.length; i += 12) { await wait(20); emit({ id, type: "answer", text: reply.slice(i, i + 12) }); }
          emit({ id, type: "done", stats: { ttftSec: 1, tokPerSec: 14, tokens: 40, totalSec: 2 } });
          return;
        }
        emit({ id, type: "notice", text: "Understood as: new (the offered action was pressed: the click is the yes)" });
        const reply = 'Here is the spare-key log the build made.\n<artifact type="html" title="Spare key log">\n<!doctype html><html><body style="font-family:sans-serif;padding:40px"><h1>Spare key log</h1><p>Reading room — drawer C-12, by the front desk.</p></body></html>\n</artifact>';
        for (let i = 0; i < reply.length; i += 12) { await wait(25); emit({ id, type: "answer", text: reply.slice(i, i + 12) }); }
        emit({ id, type: "done", stats: { ttftSec: 1, tokPerSec: 14, tokens: 120, totalSec: 5 } });
        return;
      }
      if (/sub-?agent/i.test(lastUser)) {
        const wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
        for (const [index, name] of ["Pros", "Cons"].entries()) {
          const agent = { index, name, task: `List the ${name.toLowerCase()} of running models on an NPU.`, status: "running" as const, output: "" };
          emit({ id, type: "agent", agent: { ...agent } });
          for (const w of `${name}: low power draw, fast first token. `.split(" ")) { await wait(40); agent.output += w + " "; emit({ id, type: "agent", agent: { ...agent } }); }
          emit({ id, type: "agent", agent: { ...agent, status: "done" } });
        }
        for (const w of "Both sub-agents are done: the NPU is quiet and efficient, but memory is the limit.".split(" ")) { await wait(30); emit({ id, type: "answer", text: w + " " }); }
        emit({ id, type: "done", stats: { ttftSec: 1, tokPerSec: 14, tokens: 60, totalSec: 4 } });
        return;
      }
      if (/\b(chart|diagram\w*)\b/i.test(lastUser)) {
        const reply = 'Here is how a sum grows: the higher the rate, the more the curve climbs. Move the sliders.\n```chart\n{"type":"line","title":"Compound interest","x":{"label":"Years","min":0,"max":30,"step":1},"yLabel":"Euros","params":[{"id":"P","label":"Starting amount","min":1000,"max":50000,"value":10000,"step":500,"unit":"€"},{"id":"r","label":"Annual rate","min":0,"max":12,"value":5,"step":0.5,"unit":"%"}],"series":[{"name":"With interest","y":"P*(1+r/100)^x"},{"name":"Without interest","y":"P"}]}\n```\nThe gap between the two curves is the interest.';
        for (let i = 0; i < reply.length; i += 14) { await new Promise((x) => setTimeout(x, 20)); emit({ id, type: "answer", text: reply.slice(i, i + 14) }); }
        emit({ id, type: "done", stats: { ttftSec: 1, tokPerSec: 14, tokens: 160, totalSec: 6 } });
        return;
      }
      if (/\bsnake\b/i.test(lastUser)) {
        // the real build pipeline with a pretend model: a snake whose first version never moves, noticed by the test run and mended
        const wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
        const good = SKELETONS[0].html;
        const broken = good.replace("timer = setInterval(step, SPEED);", "timer = null;");
        const say = (name: string) => (name.startsWith("write") ? broken : name.startsWith("fix") ? good : name === "explain" ? "I made a snake game. Steer with the arrow keys or WASD, press Space to restart. It did not move at first, so I fixed that." : "");
        const model: Session = async function* (sid) {
          const name = sid.replace(/^[^:]*:/, "");
          const text = say(name);
          await wait(name.startsWith("write") || name.startsWith("fix") ? 300 : 1500);
          for (let i = 0; i < text.length; i += 60) { await wait(30); yield { id: sid, type: "answer", text: text.slice(i, i + 60) }; }
          yield { id: sid, type: "done", stats: { ttftSec: 1, tokPerSec: 9, tokens: Math.ceil(text.length / 4), totalSec: 3 } };
        };
        let runs = 0;
        const shot = (moving: boolean) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#11151c"/><rect x="60" y="100" width="${moving ? 90 : 60}" height="14" rx="3" fill="#4ade80"/><circle cx="220" cy="70" r="7" fill="#f87171"/><text x="14" y="26" fill="#e8eef6" font-family="sans-serif" font-size="15">Snake · Score ${moving ? 3 : 0}</text></svg>`)}`;
        const check = async () => { await wait(1800); return ++runs === 1 ? { errors: [], notes: ["The canvas never changed after load, even after arrow keys, WASD, space, Enter and clicks: nothing moves or reacts."], shot: shot(false) } : { errors: [], notes: [], shot: shot(true) }; };
        const { stepwise } = await import("../core/build");
        const g = stepwise({ id, messages: msgs, stream: model, maxChars: 20000, check, modelOf: () => "Qwen3.5-4B" });
        let r = await g.next();
        while (!r.done) { emit(r.value); r = await g.next(); }
        emit({ id, type: "done", stats: r.value.handled ? r.value.stats : { ttftSec: 1, tokPerSec: 9, tokens: 80, totalSec: 20 } });
        return;
      }
      if (/\b(make|build|create|write)\b/i.test(lastUser)) {
        const reply = `Here is a small page.\n<artifact type="html" title="Pomodoro timer">\n<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1 id="t">25:00</h1><button onclick="go()">Start</button><script>let s=1500;function go(){setInterval(()=>{s--;document.getElementById('t').textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0')},1000)}</script></body></html>\n</artifact>\nTell me if you want changes.`;
        for (let i = 0; i < reply.length; i += 12) { await new Promise((x) => setTimeout(x, 25)); emit({ id, type: "answer", text: reply.slice(i, i + 12) }); }
        emit({ id, type: "done", stats: { ttftSec: 1, tokPerSec: 14, tokens: 120, totalSec: 5 } });
        return;
      }
      if (/doi moi/i.test(lastUser)) {
        const reply = "Doi Moi means renewal. In 1986 Vietnam moved from a planned economy to a market one. Farms were handed back to families, private business was allowed again, and foreign investment was welcomed. Exports grew from about 48 billion dollars to 475 billion. So, shall we go through the dates one by one?";
        for (const w of reply.split(" ")) { await new Promise((x) => setTimeout(x, 45)); emit({ id, type: "answer", text: w + " " }); }
        emit({ id, type: "done", stats: { ttftSec: 1, tokPerSec: 14, tokens: 80, totalSec: 4 } });
        return;
      }
      const think = "The user greeted me. Reply briefly.";
      for (const w of think.split(" ")) { await new Promise((x) => setTimeout(x, 30)); emit({ id, type: "thinking", text: w + " " }); }
      for (const w of "Hello! This is the preview build, so I am a mock. On a Snapdragon X machine this answer comes from the NPU.".split(" ")) { await new Promise((x) => setTimeout(x, 35)); emit({ id, type: "answer", text: w + " " }); }
      emit({ id, type: "done", stats: { ttftSec: 1.2, tokPerSec: 14.1, tokens: 38, totalSec: 3.9 } });
    },
    abortChat: async () => undefined,
    skipStep: async () => undefined,
    routerStatus: async () => ({ model: "Qwen3-0.6B", sizeGB: 0.4, installed: routerInstalled, enabled: settings.dynamic?.router !== false, running: routerInstalled, asked: routerInstalled ? 12 : 0, lastMs: routerInstalled ? 640 : null, lastError: null }),
    routerCandidates: async () => ({ chosen: "qwen3-0.6b", candidates: [{ id: "qwen3-0.6b", name: "Qwen3-0.6B", sizeGB: 0.4 }, { id: "gemma-3-1b-it", name: "Gemma-3-1B-it", sizeGB: 0.72 }, { id: "lfm2-1.2b-tool", name: "LFM2-1.2B-Tool", sizeGB: 0.7 }] }),
    routerBench: async () => { await new Promise((x) => setTimeout(x, 1500)); return { rows: [{ id: "qwen3-0.6b", name: "Qwen3-0.6B", sizeGB: 0.4, ms: 180, right: 4, total: 4, error: null }, { id: "gemma-3-1b-it", name: "Gemma-3-1B-it", sizeGB: 0.72, ms: 310, right: 4, total: 4, error: null }, { id: "lfm2-1.2b-tool", name: "LFM2-1.2B-Tool", sizeGB: 0.7, ms: 260, right: 3, total: 4, error: null }], chosen: "qwen3-0.6b" }; },
    routerInstall: async () => { await new Promise((x) => setTimeout(x, 1200)); routerInstalled = true; return { done: true, failures: [] }; },
    // the closed file question: undefined = no answer (the deep file rules stay), null = definitely none of them
    routerFileKind: async (text: string) => (/excel|spreadsheet|xlsx/i.test(text) ? "xlsx" : /word|docx|document|letter|report|cv/i.test(text) ? "docx" : undefined),
    routerTest: async (text) => /diagram|graph|chart/i.test(text)
      ? { kind: "web_code", ms: 710, rules: { category: "translate_other", confidence: 0.45, reason: "written in another language" }, asked: [{ id: "q_translate", yes: false }, { id: "q_code", yes: true }, { id: "q_error", yes: false }, { id: "q_read", yes: false }, { id: "q_web", yes: true }] }
      : { kind: "chat", ms: 1900, rules: { category: "chat", confidence: 0.35, reason: "nothing specific found" }, asked: [{ id: "q_code", yes: false }, { id: "q_translate", yes: false }, { id: "q_math", yes: false }, { id: "q_fact", yes: false }, { id: "q_creative", yes: false }, { id: "q_message", yes: false }, { id: "q_summary", yes: false }, { id: "q_plan", yes: false }] },
    convertLegacyDoc: async () => null,
    fixBlock: async () => null,
    fetchLibrary: async () => ({ ok: false, error: "Downloading is not available in the browser preview." }),
    conversations: async () => [],
    saveConversations: async (convs) => convs,
    markLegacyMigrated: () => {},
    onAppShutdown: () => () => {},
    saveMedia: async (dataUrl) => { const mediaId = `mock-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; mockMedia.set(mediaId, dataUrl); return { mediaId, path: "" }; },
    readMedia: async (mediaId) => { const dataUrl = mockMedia.get(mediaId); return dataUrl ? { dataUrl } : null; },
    projects: async () => projects,
    saveProject: async (p) => { projects = projects.some((x) => x.id === p.id) ? projects.map((x) => (x.id === p.id ? p : x)) : [...projects, p]; return projects; },
    deleteProject: async (id) => (projects = projects.filter((p) => p.id !== id)),
    artifacts: async () => artifacts,
    saveArtifact: async (a) => { artifacts = artifacts.some((x) => x.id === a.id) ? artifacts.map((x) => (x.id === a.id ? a : x)) : [...artifacts, a]; book.save(a); return artifacts; },
    deleteArtifact: async (id) => { book.forget(id); return artifacts; },
    artifactVersions: async (id) => book.versions(id),
    artifactVersionText: async (id, v) => book.text(id, v),
    artifactVersionAction: async (id, action) => book.act(id, action),
    exportArtifact: async () => null,
    saveOffice: async () => null,
    runCode: async () => undefined,
    runCommand: async () => undefined,
    writeRun: async () => undefined,
    stopRun: async () => undefined,
    onRun: () => () => undefined,
    agentListWindows: async () => [],
    agentBeginRun: async () => { throw new Error("Computer Use needs the desktop app."); },
    agentStopRun: async () => undefined,
    agentStartRun: async () => undefined,
    onAgentRun: () => () => undefined,
    docPickSource: async () => null,
    docEditStart: async () => undefined,
    docEditDecide: async () => undefined,
    openEditedCopy: async () => false,
    benchRoster: async () => ({
      targets: [...DYNAMIC_DATA.packs["2B"].models, ...DYNAMIC_DATA.packs["4B"].models, ...DYNAMIC_DATA.packs["9B"].models].map((m, i) => ({ key: m.ref, name: m.name, repo: m.repo, quant: m.quant, sizeGB: m.sizeGB, paramsB: m.paramsB, source: `Dynamic ${i < 3 ? "2B" : i < 7 ? "4B" : "9B"}`, bundleRef: m.ref, installed: i % 3 === 0, tested: i % 2 === 0 })).concat([{ key: "spec:lfm2-1.2b-extract", name: "LFM2-1.2B-Extract", repo: "LiquidAI/LFM2-1.2B-Extract-GGUF", quant: "Q4_0", sizeGB: 0.7, paramsB: 1.2, source: "Specialists", specialty: "Structured extraction to JSON/XML/YAML specialist", installed: false, tested: false } as never]),
      tests: { launch: 0, express: 13, quick: 33, full: 87 }, costs: { launch: [], express: Array(13).fill({ maxTokens: 120 }), quick: Array(33).fill({ maxTokens: 250 }), full: Array(87).fill({ maxTokens: 300 }) }, freeGB: 142, folder: "C:\\Users\\demo\\AppData\\Roaming\\MKMN\\benchmarks"
    }),
    benchState: async () => mockBench.state(),
    benchStart: async () => { mockBench.start(); return { ok: true }; },
    benchStop: async () => mockBench.stop(),
    npuTestRoster: async () => [{ id: "qwen3-4b-thinking", name: "Qwen3-4B-Thinking-2507", sizeGB: 2.4, failedBefore: true }, { id: "dolphin3", name: "Dolphin3-Cyber-8B", sizeGB: 4.3, failedBefore: true }, { id: "qwen3-1.7b", name: "Qwen3-1.7B", sizeGB: 1, failedBefore: false }],
    npuTestState: async () => ({ running: false, lines: [], results: [] }),
    npuTestStart: async () => ({ ok: true }),
    npuTestStop: async () => undefined,
    onNpuClean: () => () => undefined,
    engineCompareStart: async () => ({ ok: true }),
    engineCompareState: async () => ({ running: false, steps: [] }),
    labStart: async () => ({ ok: true }),
    labStop: async () => true,
    labState: async () => ({ running: false, phase: "", total: 0, done: 0, runs: [], models: [], log: [], failed: [] }),
    onLab: () => () => undefined,
    onEngineCompare: () => () => undefined,
    batteryRead: async () => ({ present: true, onMains: false, discharging: true, remainingMWh: 20760, fullMWh: 45890, dischargeMW: 8000 + Math.round(Math.random() * 6000), voltageMV: 11246, at: Date.now() }),
    foundryStatus: async () => ({ installed: true, source: "server" as const, version: "0.8.0 (demo)", models: 9, pairs: [{ key: "foundry:qwen2.5-0.5b", twinKey: "spec:qwen2-5-0-5b-instruct", name: "Qwen2.5-0.5B-Instruct", alias: "qwen2.5-0.5b", device: "NPU", sizeGB: 0.52 }, { key: "foundry:phi-3.5-mini", twinKey: "spec:phi-3-5-mini-instruct", name: "Phi-3.5-mini-instruct", alias: "phi-3.5-mini", device: "CPU", sizeGB: 2.2 }], foundryOnly: 3, log: [] }),
    foundryAdmin: async () => {
      const server = { running: true, state: "ready", pid: 4242, webUrls: ["http://127.0.0.1:50798"], startedAt: "2026-11-04T21:22:07Z", uptime: "8d 11h", logFile: "" };
      return {
        installed: true, version: "0.12.1 (demo)", exe: "C:\\Users\\demo\\AppData\\Local\\Microsoft\\WindowsApps\\foundry.exe",
        server,
        config: [
          { key: "port", value: "auto", userSet: false },
          { key: "cache-directory", value: "C:\\Users\\demo\\.foundry\\cache\\models", userSet: false },
          { key: "idle-timeout-minutes", value: "disabled", userSet: false },
          { key: "log-level", value: "info", userSet: false }
        ],
        cacheLocation: { path: "C:\\Users\\demo\\.foundry\\cache\\models", userSet: false },
        cache: [
          { alias: "deepseek-r1-7b", device: "NPU", sizeGB: 3.71, loaded: false },
          { alias: "qwen3-0.6b", device: "CPU", sizeGB: 0.58, loaded: true },
          { alias: "qwen3-embedding-0.6b", device: "CPU", sizeGB: 0.48, loaded: false }
        ],
        status: {
          system: { operatingSystem: "Windows 11", architecture: "Arm64", cpu: "Snapdragon X Elite", logicalCores: 18, physicalCores: 18, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 12 * 1024 ** 3, diskPath: "C:\\", diskTotalBytes: 1024 * 1024 ** 3, diskFreeBytes: 80 * 1024 ** 3, gpus: [{ name: "Adreno GPU", vendor: null, videoMemoryBytes: 128 * 1024 ** 2 }], npus: [{ name: "Hexagon NPU", vendor: "Qualcomm" }] },
          service: { state: "ready", ready: true, webUrls: server.webUrls, versions: { cliVersion: "0.12.1", daemonVersion: "0.12.1", protocolVersion: "2" } },
          models: { available: 109, loaded: 1, cached: 3 },
          connectivity: { localServiceReachable: true, modelRegistryReachable: true },
          warnings: []
        },
        statusText: "",
        recent: ["$ foundry --version → 0.12.1 (demo)"]
      };
    },
    foundryConfigSet: async () => ({ ok: true, message: "Setting saved (demo)." }),
    foundryConfigReset: async () => ({ ok: true, message: "Setting reset (demo)." }),
    foundryCacheSet: async () => ({ ok: true, message: "Cache folder changed (demo)." }),
    foundryCacheRemove: async () => ({ ok: true, message: "Cached model removed (demo)." }),
    foundryServer: async (action) => ({ ok: true, message: `The Foundry Local server was ${action === "stop" ? "stopped" : action === "restart" ? "restarted" : "started"} (demo).`, server: null }),
    foundryLogs: async () => "demo log line",
    foundryModelInfo: async (alias) => ({ info: { alias, id: `${alias}:1`, displayName: alias, source: "Public", task: "Chat", device: "CPU", publisher: "Microsoft", license: "MIT", sizeGB: 0.58, cached: true, supportsToolCalling: true, variants: [{ id: `${alias}:1`, displayName: alias, device: "CPU", executionProvider: "CPUExecutionProvider", sizeGB: 0.58, cached: true }] }, text: "" }),
    foundryModelRegister: async () => ({ ok: true, message: "Model registered (demo)." }),
    foundryModelUnregister: async () => ({ ok: true, message: "Model unregistered (demo)." }),
    foundryModelLoad: async (alias) => ({ ok: true, message: `Loaded ${alias} (demo).` }),
    foundryModelUnload: async (alias) => ({ ok: true, message: `Unloaded ${alias} (demo).` }),
    foundryTranscribe: async () => ({ ok: true, text: "This is a demo transcription." }),
    foundryReport: async () => ({ ok: true, message: "GitHub issue opened (demo)." }),
    requirements: async () => [
      { id: "webview2", present: true, detail: "157.0 (demo)" }, { id: "geniex", present: true, detail: "geniex.exe (demo)" },
      { id: "npuDriver", present: true, detail: "Qualcomm(R) Hexagon(TM) NPU (demo)" }, { id: "voiceRuntime", present: true, detail: null },
      { id: "foundry", present: false, detail: null }, { id: "python", present: false, detail: null }, { id: "libreoffice", present: false, detail: null }
    ],
    installRequirement: async (id) => ({ ok: true, message: `${id} is installed (demo).` }),
    requirementUpdates: async () => ({ ok: true, message: "1 update available.", updates: [{ id: "foundry", pkg: "Microsoft.FoundryLocal", current: "0.12.1.0", available: "0.14.0.0" }], geniex: { installed: "GenieX CLI Version: v0.10.0", newer: false } }),
    updateRequirement: async (id) => ({ ok: true, message: `${id} is up to date (demo).` }),
    geniexSetType: async ({ name, type }) => ({ ok: true, message: `${name} now installs as a ${type.toUpperCase()} (demo).` }),
    geniexConfigList: async () => ({ ok: true, text: "chipset: Snapdragon X2 Elite CRD (demo)" }),
    geniexClean: async () => ({ ok: true, message: "All cached models were removed (demo)." }),
    geniexPullLocal: async ({ name }) => ({ ok: true, name }),
    geniexPickLocal: async () => null,
    foundryPickAudio: async () => null,
    npuResetStatus: async () => ({ ready: true, auto: true }),
    supportInfo: async () => "MKMN AI support info (browser preview: no real machine)",
    npuReset: async () => ({ ok: true, message: "The NPU device was restarted (1 device). Try a model again." }),
    onNpuTest: () => () => undefined,
    onModelCheck: () => () => undefined,
    onBenchMeasured: () => () => undefined,
    benchImportResults: async () => 0,
    benchResults: async () => mockBench.results(),
    benchExport: async () => ({ ok: true, dir: "C:\\Users\\demo\\AppData\\Roaming\\MKMN\\benchmarks\\2026-10-25_0100\\publish", report: "report.md", html: "report.html", files: ["report.html", "report.md", "results.csv", "summary.json", "charts/", "models/"] }),
    benchReveal: async () => true,
    onBench: (cb) => { bl.push(cb); return () => undefined; },
    onBenchLive: (cb) => { ll.push(cb); return () => undefined; },
    dynamicInfo: async () => ({ data: DYNAMIC_DATA, speeds: { "qwen3-1.7b-native": 27 }, profile: "16", autoProfile: "16", installedRefs: ["qwen3-1.7b-native", "qwen3-4b-instruct-2507", "qwen3-4b-thinking-2507"], runsOn: { "qwen3-1.7b-native": "npu", "qwen3-4b-instruct-2507": "npu", "qwen3-4b-thinking-2507": "hybrid" }, engines: {}, missing: {} }),
    compiledContexts: async () => ({}),
    speedsById: async () => ({ "qwen3-1.7b-native": 27 }),
    setDynamicProfile: async () => undefined,
    installDynamic: async () => undefined,
    installDynamicModel: async () => undefined,
    uninstallDynamic: async () => ({ ok: true, removed: [], failed: [] }),
    onDynamicInstall: () => () => undefined,
    launchSite: async () => ({ error: "Opening a site in the browser works in the desktop app." }),
    onSiteNav: () => () => undefined,
    onFigureRequest: () => () => undefined,
    figureResult: async () => undefined,
    tasks: async () => tasks,
    saveTask: async (t) => {
      const now = Date.now();
      const t2 = { ...t, created: t.created || now, nextRun: t.enabled ? nextRun(t.schedule, now) : null };
      tasks = tasks.some((x) => x.id === t.id) ? tasks.map((x) => (x.id === t.id ? { ...x, ...t2, runs: x.runs } : x)) : [...tasks, t2];
      return tasks;
    },
    deleteTask: async (id) => (tasks = tasks.filter((t) => t.id !== id)),
    forgetConversation: async () => ({ journals: 0, payloads: 0 }),
    runTask: async (id) => {
      const set = (t: ScheduledTask) => { tasks = tasks.map((x) => (x.id === id ? t : x)); tkl.forEach((f) => f(t)); };
      const t = tasks.find((x) => x.id === id)!;
      set({ ...t, running: true });
      await new Promise((x) => setTimeout(x, 1500));
      const at = Date.now();
      set({ ...t, running: false, nextRun: nextRun(t.schedule, at), runs: [{ id: `${id}:${at}`, startedAt: at - 1500, finishedAt: at, status: "ok", output: "Preview result: this is where the task's answer appears.", artifactIds: [] }, ...t.runs] });
    },
    onTasks: (cb) => { tkl.push(cb); return () => tkl.splice(tkl.indexOf(cb), 1); },
    onArtifacts: () => () => undefined,
    settings: async () => settings,
    saveSettings: async (p) => (settings = { ...settings, ...p }),
    exportSettingsJson: async (contents) => {
      // the browser preview downloads the export instead of opening a save dialog
      const blob = new Blob([contents], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mkmn-settings.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return "mkmn-settings.json";
    },
    importSettingsJson: async () => {
      // the browser preview reads the chosen file through a file input
      return new Promise<string | null>((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json,application/json";
        inp.onchange = () => {
          const f = inp.files?.[0];
          if (!f) return resolve(null);
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => resolve(null);
          r.readAsText(f);
        };
        inp.click();
      });
    },
    settingsRepairNotice: async () => null,
    humainRealtimeOpen: async () => {},
    humainRealtimeEvents: async () => [],
    humainRealtimeSend: async () => {},
    humainRealtimeClose: async () => {},
    humainKeySaved: async () => false,
    humainSaveKey: async () => { throw new Error("Credential storage requires the desktop app."); },
    humainModels: async () => [],
    humainOperation: async () => ({ type: "json", value: null }),
    pickGeniex: async () => null,
    runtimeInfo: async () => ({ choices: [{ id: "npu", available: true, note: "Snapdragon NPU, through GenieX." }, { id: "gpu", available: true, note: "Qualcomm Adreno X1-85 GPU" }, { id: "cpu", available: true, note: "Works on every PC." }], note: "Runs on the NPU of a Snapdragon X with GenieX. Fastest and lightest on the battery.", llamaPath: null, llamaVersion: null, llamaAvailable: true, cpuName: "Snapdragon X Elite", cpuThreads: 12, ramGB: 16, gpus: [{ name: "Qualcomm Adreno X1-85 GPU", vramGB: null }], problems: [] }),
    installLlamaServer: async () => undefined,
    pickLlamaServer: async () => null,
    pickFolder: async () => null,
    openGeniexDownload: async () => undefined,
    npuDiagnostics: async () => ({ ok: false, problem: "Windows has no performance counters for the NPU on this PC (mock).", windows: "26100.4061", windowsHasNpuMonitoring: false, sets: [], adapter: null, topUtil: [], adapters: ["Qualcomm(R) Adreno(TM) X1-85 GPU luid_0x00000000_0x0000a1b2"], allSets: ["Processor", "Memory"], sample: [], util: null, memGB: null }),
    meters: async () => ({ ramPercent: 62, ramUsedGB: 9.9, ramTotalGB: 16, npuMemGB: 3.1, npuBudgetGB: hw.npuBudgetGB, npuUtilPercent: 4, ramWarning: false }),
    estimateMemory: async (modelRef, nctx, kvType) => ({
      modelRef,
      weightsGB: 4.2,
      kvCacheGB: 0.6,
      scratchpadGB: 0.5,
      totalRequiredGB: 5.3,
      availableRamGB: 21.5,
      totalRamGB: 32.0,
      npuBudgetGB: 24.0,
      fits: true,
      recommendedNctx: nctx ?? 4096,
      recommendedKvType: kvType ?? "f16",
      isQairt: modelRef.includes("qualcomm"),
      note: "Optimal NPU fit"
    }),
    powerStatus: async () => ({
      onAcPower: true,
      batteryPercent: 100,
      powerSaverRecommended: false,
      acLineStatus: 1
    }),
    runBenchmark: async (modelRef, compute, powerMode) => {
      await new Promise((x) => setTimeout(x, 1200)); // the cancel window, like a real run
      const res = {
        modelRef,
        compute: compute ?? "npu",
        powerMode: powerMode ?? "burst",
        ttftMs: 35.0,
        decodeTokPerSec: 64.8,
        prefillTokPerSec: 110.0,
        loadTimeMs: 1200,
        tokensGenerated: 24,
        ramUsedMB: 3450.0,
        verifiedNpu: true,
        outputSnippet: "25 * 4 = 100."
      };
      // the Rust host writes the run into hardware.json on success: the mock does the
      // same (persisted, so a preview reload shows the reload-after-restart path)
      const profile = benchProfiles[modelRef] ?? (benchProfiles[modelRef] = {});
      const runs = profile.runs ?? (profile.runs = {});
      runs[`${res.compute}|${res.powerMode}`] = {
        compute: res.compute, powerMode: res.powerMode, decodeTokPerSec: res.decodeTokPerSec, ttftMs: res.ttftMs,
        tokensGenerated: res.tokensGenerated, maxTokens: 24, ngl: -1, nctx: 4096,
        verifiedNpu: res.verifiedNpu, measuredAt: new Date().toISOString(),
      };
      persistBenchProfiles();
      return res;
    },
    hardwareConfig: async () => ({ calibratedProfiles: benchProfiles }),
    saveHardwareConfig: async (p) => p,
    cancelBenchmark: async () => undefined,
    adaptiveStatus: async () => ({
      mode: "manual" as const,
      goal: "balanced" as const,
      goals: [
        { id: "balanced" as const, label: "Balanced", why: "A measured compromise (mock)." },
        { id: "battery_saver" as const, label: "Battery Saver", why: "The lowest measured energy (mock)." },
        { id: "fastest" as const, label: "Fastest", why: "The lowest measured time (mock)." },
      ],
      last: null,
      state: null,
    }),
    inhibitSleep: async () => undefined,
    getQoSStatus: async (pid) => ({
      pid: pid ?? 1234,
      tier: "Interactive",
      priorityClass: "NORMAL_PRIORITY_CLASS",
      ecoqosActive: false,
      timerCoalescingActive: false,
      sleepInhibited: false,
      verifiedHwState: true,
      details: "PID 1234 running at NORMAL_PRIORITY_CLASS (EcoQoS: Disabled, Timers: High Precision)",
    }),
    setQoSTier: async (tier, pid) => ({
      pid: pid ?? 1234,
      tier: tier as any,
      priorityClass: tier === "inference_critical" ? "ABOVE_NORMAL_PRIORITY_CLASS" : (tier === "background_eco" ? "BELOW_NORMAL_PRIORITY_CLASS" : "NORMAL_PRIORITY_CLASS"),
      ecoqosActive: tier === "background_eco",
      timerCoalescingActive: tier === "background_eco",
      sleepInhibited: tier === "inference_critical",
      verifiedHwState: true,
      details: `PID ${pid ?? 1234} running at ${tier} (EcoQoS: ${tier === "background_eco" ? "Active" : "Disabled"})`,
    }),
    verifySha256: async (path) => ({
      path,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      matches: true,
      ecoqosVerified: true,
    }),
    npuPlan: async () => {
      const entry = CATALOG.find((e) => e.id === settings.selectedModelId) ?? null;
      return planNpu({ hw, chat: entry ? { entry, compute: settings.compute, estNpuGB: scoreEntry(entry, hw).estNpuGB } : null, voice: settings.voice });
    },
    voiceModels: async () => VOICE_MODELS.map((model) => ({ model, installed: vinstalled.has(model.id) })),
    voiceStatus: async () => vstatus,
    voiceDownload: async (id) => {
      for (const p of [20, 60, 100]) { await new Promise((x) => setTimeout(x, 300)); dl.forEach((f) => f({ id, phase: p === 100 ? "done" : "downloading", percent: p })); }
      vinstalled.add(id);
    },
    voiceCancelDownload: async () => undefined,
    voiceRemove: async (id) => { vinstalled.delete(id); },
    voiceApply: async () => vstatus,
    transcribe: async (_s, _r, partial) => (partial ? "Can you explain the Doi Moi reform to me?" : "Can you explain the Doi Moi reform to me?"),
    voiceNeeds: async (kinds) => kinds.flatMap((kind) => {
      const have = kind === "stt" ? settings.voice.sttModelId : settings.voice.ttsModelId;
      return have && vinstalled.has(have) ? [] : [{ kind, model: VOICE_MODELS.find((m) => m.kind === kind && m.default)! }];
    }),
    voiceQuickInstall: async (kinds) => {
      for (const kind of kinds) {
        const m = VOICE_MODELS.find((x) => x.kind === kind && x.default)!;
        for (const p of [20, 60, 100]) { await new Promise((x) => setTimeout(x, 300)); dl.forEach((f) => f({ id: m.id, phase: p === 100 ? "done" : "downloading", percent: p })); }
        vinstalled.add(m.id);
        settings = { ...settings, voice: { ...settings.voice, ...(kind === "stt" ? { sttModelId: m.id } : { ttsModelId: m.id }) } };
      }
      return { ok: true };
    },
    // silence as long as the sentence would take to say, so the preview reads at a real pace
    speak: async (id, text) => {
      const secs = Math.max(0.4, text.length / 14);
      al.forEach((f) => f({ id, samples: new Float32Array(Math.round(secs * 24000)), sampleRate: 24000, done: false }));
      al.forEach((f) => f({ id, samples: new Float32Array(0), sampleRate: 24000, done: true }));
    },
    cancelSpeak: async () => undefined,
    saveVoice: async (p) => {
      settings = { ...settings, voice: { ...settings.voice, ...p } };
      vstatus = { ...vstatus, sttProvider: settings.voice.sttCompute, ttsProvider: settings.voice.ttsCompute };
      vl.forEach((f) => f(vstatus));
      return settings;
    },
    onVoiceDownload: (cb) => { dl.push(cb); return () => dl.splice(dl.indexOf(cb), 1); },
    onVoiceAudio: (cb) => { al.push(cb); return () => al.splice(al.indexOf(cb), 1); },
    onVoiceStatus: (cb) => { vl.push(cb); return () => vl.splice(vl.indexOf(cb), 1); },
    setupState: async () => ({ active: false, awaitingConfirm: false, steps: [] }),
    setupSkip: async () => undefined, setupRetry: async () => undefined, setupRunUnsigned: async () => undefined, setupDismiss: async () => undefined, setupConfirm: async () => undefined, setupDecline: async () => undefined,
    onSetup: () => () => undefined,
    updateState: async () => ({ status: "idle", version: null, percent: null, error: null, checkedAt: Date.now() - 3600_000, installedAt: Date.now() - 3 * 86400_000 }),
    updateCheck: async () => ({ status: "current", version: null, percent: null, error: null, checkedAt: Date.now(), installedAt: Date.now() - 3 * 86400_000 }),
    updateForce: async () => ({ status: "downloading", version: null, percent: 10, error: null, checkedAt: Date.now(), installedAt: null }),
    updateInstall: async () => undefined,
    onUpdate: () => () => undefined,
    onInstall: (cb) => { il.push(cb); return () => il.splice(il.indexOf(cb), 1); },
    onChat: (cb) => { cl.push(cb); return () => cl.splice(cl.indexOf(cb), 1); },
    onServer: (cb) => { sl.push(cb); return () => sl.splice(sl.indexOf(cb), 1); }
  };
  (window as any).mkmn = api;
}
