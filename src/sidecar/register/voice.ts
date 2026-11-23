// The voice methods of the sidecar: speech models (list, download, remove), the speech
// worker's status, dictation (transcribe) and read-aloud (speak). Moved out of main.ts as
// it was; main.ts owns the VoiceService and the voice settings and passes them in.
import type { VoiceService } from "../../core/voiceService";
import { clampVoice, defaultVoiceModel, voiceModel } from "../../core/voiceModels";
import type { VoiceKind, VoiceNeed, VoiceSettings, VoiceStatus } from "../../shared/types";
import type { SidecarDispatcher } from "../protocol";

export interface VoiceDeps {
  voice: VoiceService;
  voiceSettings: () => VoiceSettings;
  saveSettings: (patch: Record<string, unknown>) => any;
  /** Loads the chosen speech models once; concurrent callers share the same load. */
  ensureVoice: () => Promise<void>;
}

export function registerVoice(dispatcher: SidecarDispatcher, { voice, voiceSettings, saveSettings, ensureVoice }: VoiceDeps): void {
  const voiceInstalled = (id: string | null | undefined): boolean => {
    if (!id) return false;
    const m = voiceModel(id);
    return !!m && voice.isInstalled(m);
  };

  /** Samples as they arrive over JSON: a real Float32Array (fork IPC), an array, or an object with numeric keys (invoke). */
  function toFloat32(v: unknown): Float32Array | null {
    if (v instanceof Float32Array) return v;
    if (Array.isArray(v)) return Float32Array.from(v as number[]);
    if (v && typeof v === "object") {
      const keys = Object.keys(v as Record<string, unknown>).filter((k) => /^\d+$/.test(k));
      if (!keys.length) return null;
      const out = new Float32Array(keys.length);
      for (const k of keys) out[Number(k)] = Number((v as Record<string, unknown>)[k]);
      return out;
    }
    return null;
  }

  dispatcher.register("voiceModels", () => voice.models());

  dispatcher.register("voiceStatus", () => voice.status());

  dispatcher.register("voiceDownload", async (id: string) => { await voice.download(String(id)); });

  dispatcher.register("voiceCancelDownload", (id: string) => voice.cancelDownload(String(id)));

  dispatcher.register("voiceRemove", async (id: string) => {
    await voice.remove(String(id));
    const v = voiceSettings();
    if (v.sttModelId === id || v.ttsModelId === id) {
      saveSettings({ voice: { ...v, ...(v.sttModelId === id ? { sttModelId: null } : {}), ...(v.ttsModelId === id ? { ttsModelId: null } : {}) } });
    }
  });

  dispatcher.register("voiceApply", async (): Promise<VoiceStatus> => {
    try { await ensureVoice(); } catch { /* status carries the error */ }
    return voice.status();
  });

  dispatcher.register("transcribe", async (samples: unknown, sampleRate: number, partial?: boolean) => {
    const s = toFloat32(samples);
    if (!s) throw new Error("No audio samples arrived.");
    if (!voice.status().stt) await ensureVoice();
    return voice.transcribe(s, Number(sampleRate) || 16000, !!partial);
  });

  dispatcher.register("voiceNeeds", async (kinds: VoiceKind[]): Promise<VoiceNeed[]> => {
    const out: VoiceNeed[] = [];
    for (const kind of Array.isArray(kinds) ? kinds : []) {
      const v = voiceSettings();
      if (voiceInstalled(kind === "stt" ? v.sttModelId : v.ttsModelId)) continue;
      // no Foundry Local in this build: the CPU model is the recommendation
      out.push({ kind, model: defaultVoiceModel(kind) });
    }
    return out;
  });

  dispatcher.register("voiceQuickInstall", async (kinds: VoiceKind[], _alt?: boolean) => {
    for (const kind of Array.isArray(kinds) ? kinds : []) {
      const m = defaultVoiceModel(kind);
      if (!voiceInstalled(m.id)) {
        await voice.download(m.id);
        if (!voiceInstalled(m.id)) return { ok: false, error: `${m.name} could not be installed.` };
      }
      const v = voiceSettings();
      saveSettings({ voice: { ...v, ...(kind === "stt" ? { sttModelId: m.id } : { ttsModelId: m.id }) } });
    }
    void ensureVoice().catch(() => undefined);
    return { ok: true };
  });

  dispatcher.register("speak", async (id: string, text: string) => {
    if (!voice.status().tts) await ensureVoice();
    const v = voiceSettings();
    await voice.speak(String(id), String(text), v.ttsSid, v.ttsSpeed);
  });

  dispatcher.register("cancelSpeak", (id: string) => voice.cancelSpeak(String(id)));

  dispatcher.register("saveVoice", async (patch: Partial<VoiceSettings>): Promise<any> => {
    const before = voiceSettings();
    const clamped: any = { ...patch };
    for (const k of ["minLevel", "minSpeechMs", "endSilenceMs", "waitMs", "interruptLevel", "interruptMs"] as const) if (k in clamped) clamped[k] = clampVoice(k, clamped[k] as number);
    const merged = saveSettings({ voice: { ...before, ...clamped } });
    const reload = ["sttModelId", "ttsModelId", "sttCompute", "ttsCompute", "sttLanguage"].some((k) => k in (patch as any) && (patch as any)[k] !== (before as any)[k]);
    if (reload) void ensureVoice().catch(() => undefined);
    return merged;
  });
}
