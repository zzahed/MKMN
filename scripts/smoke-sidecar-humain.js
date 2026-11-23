// Live end-to-end smoke of the HUMAIN Fuse and Node integrations through the real sidecar bundle (run `pnpm build:sidecar` first).
// It makes real, billed requests with the saved keys; copies of the keys go to a temporary folder that is deleted at the end.
// Runs with a scratch LOCALAPPDATA holding copies of the saved keys, so the person's settings are untouched.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = process.argv[2] || path.join(__dirname, "..");
// a new folder with a name no one can guess, made for this run alone: the copies of the keys never go where someone else prepared a place
const SCRATCH = fs.mkdtempSync(path.join(require("os").tmpdir(), "mkmn-humain-e2e-"));
const CONFIG = path.join(SCRATCH, "MKMN", "Config");
const REAL_CONFIG = path.join(process.env.LOCALAPPDATA, "MKMN", "Config");
fs.mkdirSync(path.join(CONFIG, "Humain"), { recursive: true });
for (const f of ["fuse.dpapi", "node.dpapi"]) fs.copyFileSync(path.join(REAL_CONFIG, "Humain", f), path.join(CONFIG, "Humain", f));
const base = JSON.parse(fs.readFileSync(path.join(REAL_CONFIG, "settings.json"), "utf8"));
const writeSettings = (patch) => fs.writeFileSync(path.join(CONFIG, "settings.json"), JSON.stringify({ ...base, webSearch: false, subagents: false, ...patch }, null, 2));
writeSettings({});

const child = spawn(process.execPath, [path.join(REPO, "dist", "sidecar", "main.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, LOCALAPPDATA: SCRATCH, GENIEX_PATH: path.join(process.env.LOCALAPPDATA, "GenieX CLI", "geniex.exe") },
});
let buf = ""; let next = 1; const waiters = new Map(); const chat = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.t === "event" && m.name === "chat") chat.push(m.payload);
    else if (m.t === "res") { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); } }
    else if (m.t === "req") child.stdin.write(JSON.stringify({ t: "res", id: m.id, ok: true, result: null }) + "\n");
  }
});
const stderr = [];
child.stderr.on("data", (d) => stderr.push(d.toString()));
const call = (method, ...args) => new Promise((res, rej) => {
  const id = next++; waiters.set(id, { res, rej });
  child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n");
  setTimeout(() => { if (waiters.delete(id)) rej(new Error(`${method}: no answer in 120 s`)); }, 120_000);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

async function turn(name, text, timeoutMs = 240_000) {
  // the system prompt the window builds for this request (the chart rules ride it), as Chat.tsx does
  const { buildSystemPrompt } = require(path.join(REPO, "dist", "core", "projects.js"));
  const { routeVisual } = require(path.join(REPO, "dist", "core", "visualRoute.js"));
  const sys = buildSystemPrompt({ custom: "", project: null, knowledgeChars: 20000, artifacts: false, visual: routeVisual(text, { hasFiles: false }), contextTokens: 32768, conversationTokens: 50 });
  const id = `e2e-${name}-${Date.now()}`;
  const start = chat.length;
  await call("chat", id, "humain:chat", [{ role: "system", content: sys }, { role: "user", content: text }], { effort: null, subagents: false });
  const end = Date.now() + timeoutMs;
  let ev;
  while (Date.now() < end && !(ev = chat.slice(start).find((e) => e.id === id && (e.type === "done" || e.type === "error")))) await sleep(500);
  const mine = chat.slice(start).filter((e) => e.id === id);
  const answer = mine.filter((e) => e.type === "answer").map((e) => e.text).join("");
  return { ev, mine, answer };
}

(async () => {
  await sleep(1500);
  for (const provider of ["fuse", "node"]) {
    console.log(`\n===== ${provider} =====`);
    let models;
    try {
      models = await call("humainModels", provider);
      record(`${provider}: list models`, models.length > 0, `${models.length} models`);
      fs.writeFileSync(path.join(SCRATCH, `${provider}-models.json`), JSON.stringify(models, null, 2));
    } catch (e) { record(`${provider}: list models`, false, e.message); continue; }
    const chosen = process.env[`E2E_${provider.toUpperCase()}_MODEL`] || (provider === "node" ? base.humainNodeModel : models.find((m) => Array.isArray(m.supported_reasoning_efforts))?.id);
    if (!chosen) { record(`${provider}: chat model`, false, "no model given"); continue; }
    record(`${provider}: chosen model is listed`, models.some((m) => m.id === chosen), chosen);
    const listed = models.find((m) => m.id === chosen)?.node?.supported_formats;
    const apis = ["chat/completions", "responses", "messages"].filter((a) => !listed || listed.includes(a === "chat/completions" ? "chat_completions" : a));
    for (const api of apis) {
      writeSettings({ humainMode: provider, [provider === "fuse" ? "humainFuseModel" : "humainNodeModel"]: chosen, [provider === "fuse" ? "humainFuseChatApi" : "humainNodeChatApi"]: api });
      const t = await turn(`${provider}-${api.replace("/", "-")}`, "Reply with exactly the word: ready");
      const err = t.ev?.type === "error" ? JSON.stringify(t.ev.error).slice(0, 300) : null;
      record(`${provider}: chat over ${api}`, t.ev?.type === "done" && /ready/i.test(t.answer), err ?? `answer: ${JSON.stringify(t.answer.slice(0, 80))}`);
      if (provider === "fuse") break; // the pipeline sends chat/completions whatever the setting: one turn proves it
    }
    if (provider === "fuse") {
      writeSettings({ humainMode: "fuse", humainFuseModel: chosen });
      const t = await turn("fuse-chart", "Draw a bar chart of these sales: January 12, February 18, March 9.");
      const text = t.answer;
      const err = t.ev?.type === "error" ? JSON.stringify(t.ev.error).slice(0, 300) : null;
      record("fuse: pipeline turn draws a chart block", t.ev?.type === "done" && /```chart/.test(text), err ?? `chart block: ${/```chart/.test(text)}; answer: ${JSON.stringify(text.slice(0, 600))}; notices: ${JSON.stringify(t.mine.filter((e) => e.type === "notice" || e.type === "stage").map((e) => e.text ?? e.label).slice(0, 8))}`);
      writeSettings({ humainMode: "fuse", humainFuseModel: "no-such/model-e2e" });
      const bad = await turn("fuse-badmodel", "Hello");
      record("fuse: an unavailable model is named", bad.ev?.type === "error" && bad.ev.error?.id === "humain-model", JSON.stringify(bad.ev?.error ?? null).slice(0, 200));
      record("fuse: the turn carries its run ledger", t.mine.some((e) => e.type === "run"), "");
      // direct services the documentation lists
      const emb = models.find((m) => /embedding/i.test(m.id));
      if (emb) {
        try { const r = await call("humainOperation", "fuse", "POST", "/v1/embeddings", { model: emb.id, input: "hello" }); record("fuse: embeddings", Array.isArray(r?.value?.data ?? r?.data), emb.id); }
        catch (e) { record("fuse: embeddings", false, e.message.slice(0, 200)); }
      }
      const rr = models.find((m) => /rerank/i.test(m.id));
      if (rr) {
        try { const r = await call("humainOperation", "fuse", "POST", "/v1/rerank", { model: rr.id, query: "cat", documents: ["a cat", "a car"] }); record("fuse: rerank", !!r, rr.id); }
        catch (e) { record("fuse: rerank", false, e.message.slice(0, 200)); }
      }
      // the operation that no app feature calls except the HUMAIN API panel: each documented one, once
      const op = async (name, method, p, body, upload) => {
        try { return await call("humainOperation", "fuse", method, p, body, upload); }
        catch (e) { record(name, false, e.message.slice(0, 200)); return null; }
      };
      const lim = await op("fuse: limits", "GET", "/v1/limits");
      if (lim) record("fuse: limits", lim.type === "json", JSON.stringify(lim.value).slice(0, 120));
      const tts = models.find((m) => /tts|voxcpm/i.test(m.id));
      const stt = models.find((m) => /stt|transcribe/i.test(m.id));
      if (tts) {
        const v = await op("fuse: voices", "GET", `/v1/audio/voices?model=${encodeURIComponent(tts.id)}`);
        if (v) record("fuse: voices", v.type === "json", JSON.stringify(v.value).slice(0, 120));
        const sp = await op("fuse: speech", "POST", "/v1/audio/speech", { model: tts.id, input: "Hello from MKMN. This is a test.", response_format: "wav" });
        if (sp) record("fuse: speech", sp.type === "file" && sp.base64.length > 1000, `${tts.id}, ${sp.mime}, ${Math.round((sp.base64?.length ?? 0) * 0.75 / 1024)} KB`);
        if (sp?.type === "file" && stt) {
          const tr = await op("fuse: transcription of that speech", "POST", "/v1/audio/transcriptions", { model: stt.id }, { field: "file", filename: "speech.wav", base64: sp.base64, mime: "audio/wav" });
          const text = tr?.value?.text ?? "";
          if (tr) record("fuse: transcription of that speech", /hello|test/i.test(text), `${stt.id}: ${JSON.stringify(text).slice(0, 100)}`);
        }
      }
      const img = models.find((m) => /image/i.test(m.id));
      if (img) {
        const r = await op("fuse: image generation", "POST", "/v1/images/generations", { model: img.id, prompt: "A small red circle on a white background", n: 1, size: "1328x1328", response_format: "b64_json" });
        const b64 = r?.value?.data?.[0]?.b64_json;
        if (r) record("fuse: image generation", typeof b64 === "string" && b64.startsWith("iVBORw0KGgo"), `${img.id}, ${Math.round((b64?.length ?? 0) * 0.75 / 1024)} KB PNG`);
      }
      const files = await op("fuse: files list", "GET", "/v1/files");
      if (files) record("fuse: files list", files.type === "json", JSON.stringify(files.value).slice(0, 100));
      const batches = await op("fuse: batches list", "GET", "/v1/batches");
      if (batches) record("fuse: batches list", batches.type === "json", JSON.stringify(batches.value).slice(0, 100));
      // web search through the pipeline: asked of Fuse over Responses first, then the turn runs with its findings
      writeSettings({ humainMode: "fuse", humainFuseModel: chosen, humainChatSearch: "search" });
      const ws = await turn("fuse-search", "What is the latest long-term support (LTS) release line of Node.js? Answer in one sentence and cite your source.");
      const notes = ws.mine.filter((e) => e.type === "notice").map((e) => e.text);
      const werr = ws.ev?.type === "error" ? JSON.stringify(ws.ev.error).slice(0, 300) : null;
      record("fuse: web search through the pipeline", ws.ev?.type === "done" && notes.some((n) => /Searching the web/.test(n)) && !notes.some((n) => /did not answer/.test(n)) && !/We'll open|request the page/i.test(ws.answer), werr ?? `notices: ${JSON.stringify(notes)}; sources listed: ${/\*\*Sources\*\*/.test(ws.answer)}; answer: ${JSON.stringify(ws.answer.slice(0, 300))}`);
      writeSettings({ humainMode: "fuse", humainFuseModel: chosen, humainChatSearch: "off" });
    }
    if (provider === "node") {
      try { const r = await call("humainOperation", "node", "GET", "/healthz"); record("node: healthz", !!r, JSON.stringify(r).slice(0, 80)); }
      catch (e) { record("node: healthz", false, e.message.slice(0, 200)); }
      // realtime: open and close one session (the model may not offer it: the refusal must be named)
      try {
        await call("humainRealtimeOpen", "e2e-rt", chosen);
        await sleep(1500);
        const evs = await call("humainRealtimeEvents", "e2e-rt");
        await call("humainRealtimeClose", "e2e-rt");
        record("node: realtime open and close", true, JSON.stringify(evs).slice(0, 160));
      } catch (e) { record("node: realtime open and close", /HUMAIN Node|realtime|websocket|model/i.test(e.message), `refused with a named reason: ${e.message.slice(0, 200)}`); }
    }
  }
  fs.writeFileSync(path.join(SCRATCH, "results.json"), JSON.stringify({ results, stderr: stderr.join("").slice(-6000) }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  child.kill(); fs.rmSync(SCRATCH, { recursive: true, force: true }); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("DRIVER FAIL", e); child.kill(); process.exit(1); });
