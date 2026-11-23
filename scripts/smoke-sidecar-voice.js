// Live smoke test of the voice pipeline, end to end through the stdio protocol:
// mark a model installed (fake backend, temp data dir), load it through voiceApply (the
// sidecar forks dist/voice/worker.js), transcribe fake audio, speak a sentence and receive
// the audio chunks as events.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-voice-smoke-"));
fs.mkdirSync(path.join(tmp, "data", "Workspace", "voice-models", "stt-whisper-tiny"), { recursive: true });
fs.mkdirSync(path.join(tmp, "data", "Workspace", "voice-models", "tts-kokoro-multi"), { recursive: true });
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "stt-whisper-tiny", ".complete"), new Date().toISOString());
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "stt-whisper-tiny", "tokens.txt"), "a\nb\n");
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "stt-whisper-tiny", "encoder.onnx"), "fake");
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "stt-whisper-tiny", "decoder.onnx"), "fake");
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "tts-kokoro-multi", ".complete"), new Date().toISOString());
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "tts-kokoro-multi", "tokens.txt"), "a\nb\n");
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "tts-kokoro-multi", "model.onnx"), "fake");
fs.writeFileSync(path.join(tmp, "data", "Workspace", "voice-models", "tts-kokoro-multi", "voices.bin"), "fake");
fs.writeFileSync(path.join(tmp, "settings.json"), JSON.stringify({ voice: { sttModelId: "stt-whisper-tiny", ttsModelId: "tts-kokoro-multi" } }));

const child = spawn(process.execPath, ["dist/sidecar/main.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MKMN_FAKE_VOICE: "1", MKMN_DATA_DIR: path.join(tmp, "data"), MKMN_SETTINGS: path.join(tmp, "settings.json") }
});
let buf = "";
const events = [];
let nextId = 1;
const waiters = new Map();

child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.t === "event") {
      events.push(m);
      const p = JSON.stringify(m.payload);
      if (m.name !== "voiceAudio" || m.payload.done) console.log(`EVENT ${m.name}:`, p.slice(0, 140));
    } else if (m.t === "res") {
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); if (m.ok) w.res(m.result); else w.rej(new Error(m.error)); }
    }
  }
});
child.stderr.on("data", (b) => console.error("STDERR:", b.toString().trim().slice(0, 160)));

function call(method, ...args) {
  const id = `t-${nextId++}`;
  return new Promise((res, rej) => {
    waiters.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ t: "req", id, method, args }) + "\n");
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("voiceApply (loads stt + tts through the forked worker):");
  const st = await call("voiceApply");
  console.log("  status:", JSON.stringify(st));

  console.log("transcribe:");
  const text = await call("transcribe", Array.from(new Float32Array(4800).fill(0.1)), 16000, false);
  console.log("  text:", JSON.stringify(text));

  console.log("speak:");
  await call("speak", "u1", "Hello there.");
  const audio = events.filter((e) => e.name === "voiceAudio");
  const done = audio.find((e) => e.payload.done);
  console.log(`  ${audio.length} audio chunks, last done=${!!done}, sampleRate=${done?.payload.sampleRate}, first chunk samples=${done ? "array ok" : "?"}`);

  console.log("saveVoice({ minLevel: 0.03 }):");
  const s = await call("saveVoice", { minLevel: 0.03 });
  console.log("  voice.minLevel now:", s.voice.minLevel, "| sttModelId kept:", s.voice.sttModelId);
  console.log("  saved file:", fs.readFileSync(path.join(tmp, "settings.json"), "utf8").slice(0, 80) + "...");

  child.stdin.end();
  await sleep(400);
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error("DRIVER FAIL:", e); child.kill(); process.exit(1); });
