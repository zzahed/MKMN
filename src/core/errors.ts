import { FriendlyError } from "../shared/types";

export class ModelStartError extends Error {
  constructor(readonly details: FriendlyError) {
    super(details.raw);
  }
}

interface Rule {
  id: string;
  test: RegExp;
  title: string;
  fix: string;
  /** Harmless lines are dropped instead of shown. */
  ignore?: boolean;
}

const RULES: Rule[] = [
  {
    id: "old-bundle",
    test: /cannot read metadata\.json/i,
    title: "This model can't run with the installed AI engine",
    fix: "Its files are missing information the current engine needs, and downloading it again won't help. Choose another model in Local Models until its maker updates it."
  },
  // HUMAIN Fuse and Node, by the codes their documentation names
  {
    id: "humain-key",
    test: /HUMAIN (Fuse|Node): HTTP 401|invalid_api_key|missing_api_key/i,
    title: "The HUMAIN key was refused",
    fix: "The key is missing, revoked or wrong. Save a new key in Settings › HUMAIN Fuse (or HUMAIN Node)."
  },
  {
    id: "humain-model",
    test: /HUMAIN (Fuse|Node): HTTP 404 · model_not_found/i,
    title: "This HUMAIN model is not available to your key",
    fix: "In Settings › HUMAIN Fuse (or HUMAIN Node), load the models again and choose one."
  },
  {
    id: "humain-limit",
    test: /(HUMAIN (Fuse|Node): HTTP 429|Server error 429)|rate_limit_exceeded|weekly_cap_exceeded|quota_exceeded|partner_credit_limit_exceeded/i,
    title: "A HUMAIN usage limit was reached",
    fix: "Wait for the time named below, or for the weekly reset, then send again."
  },
  {
    id: "humain-offline",
    test: /HUMAIN (Fuse|Node): connection unavailable/i,
    title: "HUMAIN could not be reached",
    fix: "Check the internet connection, then send again."
  },
  {
    id: "no-model",
    test: /^Pick a model first\.|^Install the models of this Dynamic size first/i,
    title: "No usable model is chosen for this chat",
    fix: "Choose an installed model in the model menu above the message box (Local Models lists them), then send again."
  },
  {
    id: "ram-low",
    test: /Only [\d.]+ GB of RAM is free/i,
    title: "Not enough free memory for this model",
    fix: "The NPU uses the PC's main memory, so the model needs that much of it free. Close other apps (Task Manager shows what uses memory), or restart the PC if memory stays full, then try again."
  },
  {
    id: "model-load",
    test: /Could not create context from binary|SDKError\s*\(Model loading failed\)/i,
    title: "The model failed to load",
    fix: "Use Try again, or choose another installed model in Local Models. The engine's own message is under Raw message."
  },
  { id: "dsp-info", test: /DSP_INFO\s+UNSUPPORTED_KEY/i, title: "The NPU driver is older than the AI engine", fix: "Harmless, ignored.", ignore: true },
  {
    id: "npu-overflow",
    test: /dspqueue_read failed|ggml-hex/i,
    title: "The model did not fit in the NPU's memory",
    fix: "MKMN tries to restart the AI with less room for the conversation and attachments. If this message stays, close other apps that use the NPU and use Settings › Developer › Reset the NPU, then try again. If it still fails, restart the PC."
  },
  {
    // GenieX's generic catch-all (code -100000). A real out-of-NPU-memory failure says
    // so itself (-100201, "ggml-hex ... buffer mapping failed", rule npu-overflow);
    // calling this one OOM sent users to shrink models that were not the problem
    // (a warmed-up server answered this in ~13 ms, with the NPU
    // idle and plenty of RAM free — the request shape was the trigger, not memory).
    id: "npu-sdk-error",
    test: /SDKError\s*\(Unknown error\)/i,
    title: "The AI engine hit an internal error",
    fix: "It failed without saying why. Send the message again. If it happens again, restart MKMN. The engine's log is in Settings › Developer."
  },
  {
    id: "connection-reset",
    test: /ERR_CONNECTION_RESET|ECONNRESET|ECONNREFUSED|fetch failed/i,
    title: "The AI on this PC is not running",
    fix: "MKMN tries to restart it. If it doesn't come back, send your message again, or restart MKMN. Details are in Settings › Developer › Last error."
  },
  {
    id: "ram-exhausted",
    test: /Server error.*(97|98|99)\s*%|out of memory|ENOMEM|std::bad_alloc/i,
    title: "Windows ran out of memory",
    fix: "Close browsers and other heavy apps, then try again."
  },
  {
    id: "quant-missing",
    test: /requested quant\s*"?([A-Za-z0-9_]+)"?\s*not found/i,
    title: "This version of the model isn't available",
    fix: "MKMN will look for another version of it, and tell you if only slower versions exist."
  },
  {
    id: "no-chipset",
    test: /Requested chipset not available|chipset\s+"[^"]*"\s+not available/i,
    title: "No version of this model is built for this PC's NPU",
    fix: "Qualcomm hasn't published one for your chip (a Snapdragon X Plus is listed separately). Choose another version of it, or another model, in Local Models."
  },
  {
    id: "win193",
    test: /WinError 193/i,
    title: "A program built for a different kind of PC tried to run",
    fix: "MKMN uses only programs built for this PC (ARM64). If you started MKMN's engine yourself, don't use the geniex Python package from an x64 Python."
  },
  { id: "sox", test: /SoX is not installed/i, title: "SoX is not installed", fix: "Only needed for audio features. Ignored.", ignore: true },
  {
    id: "npu-busy",
    test: /another (infer|session)|(?:npu|htp|hexagon).{0,40}(?:resource busy|in use)/i,
    title: "The NPU is busy with other work",
    fix: "Wait for the other work on the NPU to finish, then try again."
  }
];

export function translateError(raw: string): FriendlyError | null {
  for (const r of RULES) {
    if (r.test.test(raw)) {
      if (r.ignore) return null;
      return { id: r.id, title: r.title, fix: r.fix, raw };
    }
  }
  return null;
}

/** Fallback shown when nothing matched: still plain, never an empty box. */
export function genericError(raw: string): FriendlyError {
  return { id: "unknown", title: "Something went wrong", fix: "Details are below. If it repeats, restart MKMN.", raw };
}

export function friendly(raw: string): FriendlyError | null {
  return translateError(raw) ?? (raw.trim() ? genericError(raw) : null);
}

/** True when the line is known to be harmless noise. */
export function isNoise(line: string): boolean {
  return RULES.some((r) => r.ignore && r.test.test(line));
}
