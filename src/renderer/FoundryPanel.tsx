import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { CopyLog } from "./CopyLog";
import type { FoundryAdminView, FoundryActionResult, FoundryConfigSetting, FoundryModelInfo } from "../core/foundryHost";

/**
 * Microsoft Foundry Local's own management surface, for Developer settings.
 *
 * Everything here is Foundry's: its daemon, its persistent settings, its cache,
 * its registrations and its speech models. The panel does not guess a port (it
 * reads the one Foundry reports), does not invent execution-provider controls
 * (this CLI has none), and keeps model installation in the Models library.
 */

const CONFIG_ROWS: { key: string; label: string; hint: string; placeholder?: string }[] = [
  { key: "port", label: "Port", hint: "auto, a fixed port, or 0 to ask Windows for a free one", placeholder: "auto" },
  { key: "cache-directory", label: "Cache folder", hint: "Where Foundry keeps downloaded models", placeholder: "Choose a folder" },
  { key: "idle-timeout-minutes", label: "Idle timeout", hint: "disabled, or minutes before the daemon stops by itself", placeholder: "disabled" },
  { key: "log-level", label: "Log level", hint: "How much Foundry writes to its daemon log", placeholder: "info" }
];

const TASKS = [
  { id: "chat-completion", label: "Chat" },
  { id: "vision-language-chat", label: "Vision and chat" },
  { id: "embeddings", label: "Embeddings" },
  { id: "automatic-speech-recognition", label: "Speech recognition" }
];

const AUDIO = ["wav", "mp3", "m4a", "flac", "ogg", "webm"];

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const size = (gb: number | null | undefined) => gb === null || gb === undefined ? "–" : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
const bytes = (n: number | null | undefined) => n === null || n === undefined ? "–" : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
const when = (s: string | null | undefined) => {
  if (!s) return "–";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
};
const yesNo = (v: boolean | null | undefined) => v === null || v === undefined ? "not reported" : v ? "yes" : "no";

type Note = { ok: boolean; text: string };

function Details({ info, text }: { info: FoundryModelInfo | null; text: string }) {
  if (!info) {
    return text
      ? <details className="small"><summary>What Foundry answered</summary><pre>{text}</pre></details>
      : <div className="muted small">Foundry did not return details for that model.</div>;
  }
  return (
    <>
      <table className="kv"><tbody>
        <tr><td>Model</td><td><strong>{info.displayName}</strong> <span className="muted">({info.alias})</span></td></tr>
        <tr><td>Model ID</td><td><code>{info.id || "not reported"}</code></td></tr>
        <tr><td>Task</td><td>{info.task || "not reported"}</td></tr>
        <tr><td>Device</td><td>{info.device || "not reported"}</td></tr>
        <tr><td>Source</td><td>{info.source || "not reported"}</td></tr>
        <tr><td>Publisher</td><td>{info.publisher || "not reported"}</td></tr>
        <tr><td>Licence</td><td>{info.license || "not reported"}</td></tr>
        <tr><td>Size</td><td>{size(info.sizeGB)}</td></tr>
        <tr><td>Cached here</td><td>{yesNo(info.cached)}</td></tr>
        <tr><td>Tool calling</td><td>{yesNo(info.supportsToolCalling)}</td></tr>
      </tbody></table>
      {info.variants.length > 0 && (
        <table className="bd-table small">
          <thead><tr><th>Variant</th><th>Device</th><th>Execution provider</th><th>Size</th><th>Cached</th></tr></thead>
          <tbody>
            {info.variants.map((v) => (
              <tr key={v.id}>
                <td><code>{v.id}</code><div className="muted small">{v.displayName}</div></td>
                <td>{v.device || "–"}</td>
                <td>{v.executionProvider || "not reported"}</td>
                <td>{size(v.sizeGB)}</td>
                <td>{yesNo(v.cached)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted small">Foundry downloads the execution provider a variant needs for this PC. This version has no separate command to list, install or remove providers.</div>
    </>
  );
}

export function FoundryPanel() {
  const [data, setData] = useState<FoundryAdminView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const [cacheDraft, setCacheDraft] = useState("");
  const [portDraft, setPortDraft] = useState("");
  const [idleDraft, setIdleDraft] = useState("");
  const [logs, setLogs] = useState("");
  const [query, setQuery] = useState("");
  const [infoAlias, setInfoAlias] = useState("");
  const [info, setInfo] = useState<{ info: FoundryModelInfo | null; text: string } | null>(null);
  const [register, setRegister] = useState({ path: "", modelId: "", task: "chat-completion", displayName: "", device: "", executionProvider: "", contextLength: "" });
  const [unregister, setUnregister] = useState("");
  const [audio, setAudio] = useState({ file: "", model: "", language: "", text: "", error: "" });

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const next = await api().foundryAdmin();
      setData(next);
      setConfigDraft(Object.fromEntries((next.config ?? []).map((s) => [s.key, s.value])));
      setCacheDraft(next.cacheLocation?.path ?? "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (key: string, fn: () => Promise<FoundryActionResult>, success?: string) => {
    setBusy(key);
    setNote(null);
    try {
      const r = await fn();
      setNote({ ok: r.ok, text: r.message || (r.ok ? success ?? "Done." : "That did not work.") });
      if (r.ok) await refresh(true);
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy("");
    }
  };

  const server = data?.server ?? null;
  const running = !!server?.running;
  const endpoint = server?.webUrls?.[0] ?? "";
  const cache = data?.cache ?? [];
  const models = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? cache.filter((m) => m.alias.toLowerCase().includes(q) || m.device.toLowerCase().includes(q)) : cache;
  }, [cache, query]);
  const totalGB = cache.reduce((n, m) => n + (m.sizeGB ?? 0), 0);
  const settings: FoundryConfigSetting[] = data?.config ?? CONFIG_ROWS.map((r) => ({ key: r.key, value: configDraft[r.key] ?? "", userSet: false }));
  const diagnosticText = useMemo(() => {
    if (!data) return "";
    if (data.statusText) return data.statusText;
    return JSON.stringify({ server: data.server, settings: data.config, cache: data.cacheLocation, status: data.status, recent: data.recent }, null, 2);
  }, [data]);

  const readPort = () => {
    const raw = portDraft.trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      setNote({ ok: false, text: "The port must be a whole number from 0 to 65535. Leave it empty to let Foundry choose." });
      return undefined;
    }
    return n;
  };
  const runServer = (action: "start" | "stop" | "restart") => {
    const port = readPort();
    if (port === undefined) return;
    const idle = idleDraft.trim() === "" ? null : Number(idleDraft);
    if (idle !== null && (!Number.isInteger(idle) || idle < 0)) {
      setNote({ ok: false, text: "The idle timeout must be 0 (keep running) or a whole number of minutes." });
      return;
    }
    void act(`server:${action}`, () => api().foundryServer(action, { port, idleTimeoutMinutes: idle }), action === "stop" ? "The Foundry Local server stopped." : "The server answered.");
  };

  const saveConfig = (s: FoundryConfigSetting) => {
    let value = (configDraft[s.key] ?? "").trim();
    if (s.key === "port" && !value) value = "auto";
    if (s.key === "idle-timeout-minutes" && !value) value = "disabled";
    if (!value) {
      setNote({ ok: false, text: `Enter a value for ${s.key}.` });
      return;
    }
    void act(`config:${s.key}`, () => api().foundryConfigSet(s.key, value));
  };
  const chooseCacheFolder = async () => {
    const folder = await api().pickFolder().catch(() => null);
    if (folder) setCacheDraft(folder);
  };
  const chooseRegisterFolder = async () => {
    const folder = await api().pickFolder().catch(() => null);
    if (folder) setRegister((r) => ({ ...r, path: folder }));
  };
  const chooseAudio = async () => {
    const file = await api().foundryPickAudio().catch(() => null);
    if (file) setAudio((a) => ({ ...a, file, text: "", error: "" }));
  };
  const showInfo = async (alias = infoAlias) => {
    const a = alias.trim();
    if (!a) return;
    setBusy("info");
    setNote(null);
    try {
      const r = await api().foundryModelInfo(a);
      setInfo(r);
      if (!r.info && !r.text) setNote({ ok: false, text: `Foundry did not find a model named ${a}.` });
    } catch (e) {
      setNote({ ok: false, text: errorText(e) });
    } finally {
      setBusy("");
    }
  };
  const loadLogs = async () => {
    setBusy("logs");
    try { setLogs(await api().foundryLogs(80)); } catch (e) { setNote({ ok: false, text: errorText(e) }); }
    finally { setBusy(""); }
  };
  const transcribe = async () => {
    if (!audio.file.trim()) {
      setAudio((a) => ({ ...a, error: "Choose an audio file first." }));
      return;
    }
    setBusy("transcribe");
    setAudio((a) => ({ ...a, text: "", error: "" }));
    try {
      const r = await api().foundryTranscribe({ file: audio.file.trim(), model: audio.model.trim() || undefined, language: audio.language.trim() || undefined });
      if (r.ok) setAudio((a) => ({ ...a, text: r.text ?? "" }));
      else setAudio((a) => ({ ...a, error: r.error ?? "Transcription did not finish." }));
    } catch (e) {
      setAudio((a) => ({ ...a, error: errorText(e) }));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="foundry-panel">
      <p className="muted small">
        Microsoft Foundry Local's own settings, its server and its model cache. Everything here is written by the installed
        <code> foundry </code> command; the port shown is the one it reports, never a number this app chose.
      </p>

      {loading && !data && <div className="muted small">Reading Foundry Local…</div>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {note && <div className={`small ${note.ok ? "ok" : "warn"}`} role="status" aria-live="polite">{note.text}</div>}

      {data && !data.installed && (
        <div className="warn small">
          {data.error ?? "Microsoft Foundry Local is not installed on this PC."} Install downloads it with winget (Windows asks for permission);
          the Models library then shows the Foundry models this machine can offer.
          <div className="row">
            <button type="button" className="primary" disabled={busy !== ""} onClick={() => void act("install", () => api().installRequirement("foundry"), "Foundry Local is installed.")}>
              {busy === "install" ? "Installing…" : "Install Foundry Local"}
            </button>
          </div>
        </div>
      )}

      {data?.installed && <>
        <div className="row tight">
          <span className="tag">Foundry Local {data.version ?? "unknown version"}</span>
          {data.exe && <span className="muted small"><code>{data.exe}</code></span>}
          <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading || !!busy}>Refresh</button>
        </div>

        <section className="foundry-block">
          <h3>Server</h3>
          <table className="kv"><tbody>
            <tr><td>State</td><td>{server ? `${server.state || (running ? "running" : "stopped")}${server.running ? "" : " · not running"}` : "not reported"}</td></tr>
            <tr><td>Endpoint</td><td>{endpoint ? <code>{endpoint}</code> : "not running"}</td></tr>
            <tr><td>Process</td><td>{server?.pid ?? "–"}</td></tr>
            <tr><td>Started</td><td>{when(server?.startedAt)}</td></tr>
            <tr><td>Uptime</td><td>{server?.uptime ?? "–"}</td></tr>
            <tr><td>Log file</td><td>{server?.logFile ? <code>{server.logFile}</code> : "not reported"}</td></tr>
          </tbody></table>
          <div className="row">
            <label className="small">Port <input value={portDraft} inputMode="numeric" placeholder="auto" onChange={(e) => setPortDraft(e.target.value)} /></label>
            <label className="small">Idle timeout (minutes) <input value={idleDraft} inputMode="numeric" placeholder="keep running" onChange={(e) => setIdleDraft(e.target.value)} /></label>
            <button type="button" className="primary" disabled={!!busy || running} onClick={() => runServer("start")}>Start</button>
            <button type="button" disabled={!!busy || !running} onClick={() => runServer("restart")}>Restart</button>
            <button type="button" className="ghost" disabled={!!busy || !running} onClick={() => runServer("stop")}>Stop</button>
            <button type="button" className="ghost" disabled={!!busy} onClick={() => void loadLogs()}>Show logs</button>
          </div>
          <div className="muted small">
            Leave the port empty to use Foundry's configured value; 0 asks Windows for a free port. Restarting unloads the model in memory.
            The endpoint above is read back from Foundry after every change.
          </div>
          {logs && (
            <details className="small" open>
              <summary>Daemon and SDK log ({logs.split(/\r?\n/).filter((l) => l.trim()).length} lines)</summary>
              <CopyLog lines={logs.split(/\r?\n/)} />
              <pre>{logs}</pre>
            </details>
          )}
        </section>

        <section className="foundry-block">
          <h3>Persistent settings</h3>
          {data.config === null
            ? <div className="muted small">Foundry did not report its settings. Its command log below says what it answered.</div>
            : <table className="bd-table small foundry-settings">
                <thead><tr><th>Setting</th><th>Value</th><th>Source</th><th></th></tr></thead>
                <tbody>
                  {settings.map((s) => {
                    const meta = CONFIG_ROWS.find((r) => r.key === s.key);
                    return (
                      <tr key={s.key}>
                        <td><strong>{meta?.label ?? s.key}</strong><div className="muted small">{meta?.hint ?? "A setting this version reports"}</div></td>
                        <td>
                          <div className="inline">
                            <input
                              className="foundry-input"
                              value={configDraft[s.key] ?? ""}
                              placeholder={meta?.placeholder}
                              list={s.key === "log-level" ? "foundry-log-levels" : undefined}
                              onChange={(e) => setConfigDraft((c) => ({ ...c, [s.key]: e.target.value }))}
                            />
                            {s.key === "cache-directory" && <button type="button" className="linkbtn" onClick={() => void chooseCacheFolder()}>Browse…</button>}
                          </div>
                        </td>
                        <td>{s.userSet ? "set by you" : "default"}</td>
                        <td>
                          <div className="inline">
                            <button type="button" className="ghost" disabled={!!busy} onClick={() => saveConfig(s)}>Save</button>
                            <button type="button" className="linkbtn" disabled={!!busy} onClick={() => void act(`reset:${s.key}`, () => api().foundryConfigReset(s.key))}>Reset</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>}
          <datalist id="foundry-log-levels">
            {["trace", "debug", "info", "warning", "error", "critical", "none"].map((v) => <option key={v} value={v} />)}
          </datalist>
          <div className="row tight">
            <button type="button" className="linkbtn" disabled={!!busy} onClick={() => { if (confirm("Reset every Foundry Local setting to its default?")) void act("reset:all", () => api().foundryConfigReset()); }}>Reset all settings</button>
            <span className="muted small">Port or cache changes can restart Foundry's daemon; the panel reads its new address afterwards.</span>
          </div>
        </section>

        <section className="foundry-block">
          <h3>Model cache</h3>
          <table className="kv"><tbody>
            <tr><td>Folder</td><td><code>{data.cacheLocation?.path ?? "not reported"}</code>{data.cacheLocation?.userSet ? <span className="muted"> · set by you</span> : null}</td></tr>
            <tr><td>Models</td><td>{cache.length} cached{cache.length ? ` · ${size(totalGB)}` : ""}</td></tr>
          </tbody></table>
          <div className="row">
            <label className="small grow">Cache folder <input value={cacheDraft} onChange={(e) => setCacheDraft(e.target.value)} /></label>
            <button type="button" className="ghost" onClick={() => void chooseCacheFolder()}>Browse…</button>
            <button type="button" disabled={!!busy || !cacheDraft.trim()} onClick={() => void act("cache:set", () => api().foundryCacheSet(cacheDraft.trim()))}>Use this folder</button>
            <button type="button" className="danger" disabled={!!busy || !cache.length} onClick={() => { if (confirm(`Remove all ${cache.length} cached Foundry Local models? They can be downloaded again from the Models library.`)) void act("cache:all", () => api().foundryCacheRemove()); }}>Remove all cached models</button>
          </div>

          <div className="row tight">
            <label className="small grow">Find a cached model <input value={query} placeholder="alias or device" onChange={(e) => setQuery(e.target.value)} /></label>
          </div>
          {models.length > 0 ? (
            <table className="bd-table small">
              <thead><tr><th>Model</th><th>Device</th><th>Size</th><th>Memory</th><th></th></tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={`${m.alias}:${m.device}`}>
                    <td><strong>{m.alias}</strong></td>
                    <td>{m.device || "–"}</td>
                    <td>{size(m.sizeGB)}</td>
                    <td>{m.loaded ? "loaded" : "not loaded"}</td>
                    <td>
                      <div className="inline">
                        <button type="button" className="linkbtn" disabled={!!busy || m.loaded} onClick={() => void act(`load:${m.alias}:${m.device}`, () => api().foundryModelLoad(m.alias, m.device || undefined))}>Load</button>
                        <button type="button" className="linkbtn" disabled={!!busy || !m.loaded} onClick={() => void act(`unload:${m.alias}`, () => api().foundryModelUnload(m.alias))}>Unload</button>
                        <button type="button" className="linkbtn" disabled={!!busy} onClick={() => { setInfoAlias(m.alias); void showInfo(m.alias); }}>Details</button>
                        <button type="button" className="linkbtn danger-link" disabled={!!busy} onClick={() => { if (confirm(`Remove ${m.alias} from Foundry Local's cache?`)) void act(`remove:${m.alias}`, () => api().foundryCacheRemove(m.alias)); }}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="muted small">{cache.length ? "No cached model matches that search." : "No models are cached yet. Install one from the Models library."}</div>}
        </section>

        <section className="foundry-block">
          <h3>Model details</h3>
          <div className="row">
            <label className="small grow">Alias or model ID <input value={infoAlias} placeholder="qwen3-0.6b" onChange={(e) => setInfoAlias(e.target.value)} /></label>
            <button type="button" className="ghost" disabled={!!busy || !infoAlias.trim()} onClick={() => void showInfo()}>Show details</button>
          </div>
          {info && <Details info={info.info} text={info.text} />}
        </section>

        <section className="foundry-block">
          <h3>Register a model folder</h3>
          <p className="muted small">
            For a compatible ONNX Runtime GenAI folder with <code>genai_config.json</code> and its assets. Foundry registers the folder where it is;
            the files are not copied. Unregistering keeps the files.
          </p>
          <div className="row">
            <label className="small grow">Model folder <input value={register.path} onChange={(e) => setRegister((r) => ({ ...r, path: e.target.value }))} /></label>
            <button type="button" className="ghost" onClick={() => void chooseRegisterFolder()}>Browse…</button>
          </div>
          <div className="row">
            <label className="small">Model ID <input value={register.modelId} placeholder="my-model:1" onChange={(e) => setRegister((r) => ({ ...r, modelId: e.target.value }))} /></label>
            <label className="small">Task
              <select value={register.task} onChange={(e) => setRegister((r) => ({ ...r, task: e.target.value }))}>
                {TASKS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
          </div>
          <details className="small">
            <summary>Optional metadata</summary>
            <div className="row">
              <label className="small">Display name <input value={register.displayName} onChange={(e) => setRegister((r) => ({ ...r, displayName: e.target.value }))} /></label>
              <label className="small">Device
                <select value={register.device} onChange={(e) => setRegister((r) => ({ ...r, device: e.target.value }))}>
                  <option value="">not set</option><option value="cpu">CPU</option><option value="gpu">GPU</option><option value="npu">NPU</option>
                </select>
              </label>
              <label className="small">Execution provider <input value={register.executionProvider} placeholder="CPUExecutionProvider" onChange={(e) => setRegister((r) => ({ ...r, executionProvider: e.target.value }))} /></label>
              <label className="small">Context length <input value={register.contextLength} inputMode="numeric" placeholder="tokens" onChange={(e) => setRegister((r) => ({ ...r, contextLength: e.target.value }))} /></label>
            </div>
          </details>
          <div className="row">
            <button type="button" className="primary" disabled={!!busy || !register.path.trim() || !register.modelId.trim()} onClick={() => void act("register", () => api().foundryModelRegister({ ...register, contextLength: register.contextLength.trim() ? Number(register.contextLength) : undefined }), "Model registered.")}>Register</button>
            <label className="small grow">Unregister <input value={unregister} placeholder="alias or model ID" onChange={(e) => setUnregister(e.target.value)} /></label>
            <button type="button" className="ghost" disabled={!!busy || !unregister.trim()} onClick={() => void act("unregister", () => api().foundryModelUnregister(unregister.trim()), "Model unregistered. Its files stay in place.")}>Unregister</button>
          </div>
        </section>

        <section className="foundry-block">
          <h3>Transcribe a file</h3>
          <p className="muted small">
            One-shot transcription through a cached Foundry speech model. Install speech models from the Models library first; the language is optional.
          </p>
          <div className="row">
            <label className="small grow">Audio file <input value={audio.file} placeholder={`Choose a ${AUDIO.join(", ")} file`} onChange={(e) => setAudio((a) => ({ ...a, file: e.target.value, text: "", error: "" }))} /></label>
            <button type="button" className="ghost" onClick={() => void chooseAudio()}>Browse…</button>
            <label className="small">Speech model <input value={audio.model} placeholder="whisper-tiny (optional)" onChange={(e) => setAudio((a) => ({ ...a, model: e.target.value }))} /></label>
            <label className="small">Language <input value={audio.language} placeholder="en (optional)" onChange={(e) => setAudio((a) => ({ ...a, language: e.target.value }))} /></label>
            <button type="button" className="primary" disabled={!!busy || !audio.file.trim()} onClick={() => void transcribe()}>{busy === "transcribe" ? "Transcribing…" : "Transcribe"}</button>
          </div>
          {audio.error && <div className="warn small" role="alert">{audio.error}</div>}
          {audio.text && (
            <div>
              <div className="row tight"><strong>Text</strong><CopyLog lines={[audio.text]} /></div>
              <pre>{audio.text}</pre>
            </div>
          )}
        </section>

        <section className="foundry-block">
          <h3>Diagnostics</h3>
          {data.status ? (
            <table className="kv"><tbody>
              <tr><td>This PC</td><td>{[data.status.system?.operatingSystem, data.status.system?.architecture, data.status.system?.cpu].filter(Boolean).join(" · ") || "not reported"}</td></tr>
              <tr><td>Memory</td><td>{bytes(data.status.system?.availableMemoryBytes)} free of {bytes(data.status.system?.totalMemoryBytes)}</td></tr>
              <tr><td>GPU</td><td>{data.status.system?.gpus.length ? data.status.system.gpus.map((g) => `${g.name} (${bytes(g.videoMemoryBytes)})`).join(" · ") : "none reported"}</td></tr>
              <tr><td>NPU</td><td>{data.status.system?.npus.length ? data.status.system.npus.map((n) => n.name).join(" · ") : "none reported"}</td></tr>
              <tr><td>Service</td><td>{data.status.service ? `${data.status.service.state || "unknown"}${data.status.service.ready === null ? "" : data.status.service.ready ? " · ready" : " · not ready"}` : "not reported"}</td></tr>
              <tr><td>Versions</td><td>{data.status.service && Object.keys(data.status.service.versions).length ? Object.entries(data.status.service.versions).map(([k, v]) => `${k.replace(/Version$/, "")} ${v}`).join(" · ") : "not reported"}</td></tr>
              <tr><td>Models</td><td>{data.status.models ? `${data.status.models.available ?? "?"} available · ${data.status.models.cached ?? "?"} cached · ${data.status.models.loaded ?? "?"} loaded` : "not reported"}</td></tr>
              <tr><td>Connectivity</td><td>{data.status.connectivity ? `local service ${yesNo(data.status.connectivity.localServiceReachable)} · model registry ${yesNo(data.status.connectivity.modelRegistryReachable)}` : "not reported"}</td></tr>
              <tr><td>Warnings</td><td>{data.status.warnings.length ? data.status.warnings.join(" · ") : "none"}</td></tr>
            </tbody></table>
          ) : data.statusText
            ? <pre>{data.statusText}</pre>
            : <div className="muted small">Foundry did not return a status report.</div>}
          <details className="small">
            <summary>Raw status</summary>
                        <pre>{data.statusText || JSON.stringify(data.status, null, 2)}</pre>
          </details>
          <div className="row tight">
            {diagnosticText && <CopyLog lines={[diagnosticText]} />}
            <button type="button" className="ghost" disabled={!!busy} onClick={() => void act("report", () => api().foundryReport(), "GitHub issue opened. Check your browser.")}>Report issue</button>
            <span className="muted small">Runs <code>foundry report</code> — opens a pre-filled GitHub issue with Foundry's diagnostics.</span>
          </div>
        </section>

        {data.recent.length > 0 && (
          <details className="small">
            <summary>What the foundry commands answered ({data.recent.length} lines)</summary>
            <CopyLog lines={data.recent} />
            <pre>{data.recent.join("\n")}</pre>
          </details>
        )}

        <section className="foundry-block">
          <h3>Upgrade and removal</h3>
          <p className="muted small">
            Foundry Local is installed and upgraded outside MKMN; use Windows' installed apps (or winget). This panel does not change the Foundry
            installation or its execution providers. Model installation and removal stay in the Models library, where Foundry entries are marked.
          </p>
        </section>
      </>}
    </div>
  );
}
