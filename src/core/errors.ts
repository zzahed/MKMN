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
    title: "This model's package cannot be read by the installed GenieX",
    fix: "Its files lack the metadata this GenieX version needs, and its current download lacks it too, so installing it again does not help. Choose another model until its maker updates it."
  },
  // HUMAIN Fuse and Node, by the codes their documentation names
  {
    id: "humain-key",
    test: /HUMAIN (Fuse|Node): HTTP 401|invalid_api_key|missing_api_key/i,
    title: "The HUMAIN key was refused",
    fix: "The key is missing, revoked or wrong. Save a new key in Settings, HUMAIN."
  },
  {
    id: "humain-model",
    test: /HUMAIN (Fuse|Node): HTTP 404 · model_not_found/i,
    title: "This HUMAIN model is not available to your key",
    fix: "Load the models again in Settings, HUMAIN, and choose one from the list."
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
    fix: "Choose an installed model in the model menu above the message box (Models lists them), then send again."
  },
  {
    id: "ram-low",
    test: /Only [\d.]+ GB of RAM is free/i,
    title: "Not enough free RAM for this model",
    fix: "The NPU works in the PC's own RAM, so a model needs that much free memory. Close other apps (Task Manager, Memory column), or restart the PC if the memory stays full after closing them, then try again."
  },
  {
    id: "model-load",
    test: /Could not create context from binary|SDKError\s*\(Model loading failed\)/i,
    title: "GenieX failed to load the model",
    fix: "Use Try again to explicitly retry, or choose another installed model in Models. See Raw message for the runtime error."
  },
  { id: "dsp-info", test: /DSP_INFO\s+UNSUPPORTED_KEY/i, title: "Driver is older than the runtime", fix: "Harmless, ignored.", ignore: true },
  {
    id: "npu-overflow",
    test: /dspqueue_read failed|ggml-hex/i,
    title: "The model and its context did not fit in NPU memory",
    fix: "MKMN will restart the server with a smaller context. Close other apps that use the NPU, then try again. If it keeps failing, use Settings, Developer, Reset the NPU, or restart the PC."
  },
  {
    // GenieX's generic catch-all (code -100000). A real out-of-NPU-memory failure says
    // so itself (-100201, "ggml-hex ... buffer mapping failed", rule npu-overflow);
    // calling this one OOM sent users to shrink models that were not the problem
    // (a warmed-up server answered this in ~13 ms, with the NPU
    // idle and plenty of RAM free — the request shape was the trigger, not memory).
    id: "npu-sdk-error",
    test: /SDKError\s*\(Unknown error\)/i,
    title: "The model server hit an internal error",
    fix: "GenieX failed the request without saying why (its generic SDK error, code -100000). Send the message again; if it repeats, restart the server in Models, and look at the server log in Settings."
  },
  {
    id: "connection-reset",
    test: /ERR_CONNECTION_RESET|ECONNRESET|ECONNREFUSED|fetch failed/i,
    title: "The local model server is not running",
    fix: "MKMN is restarting it. If this keeps happening, look at the last server error in Settings."
  },
  {
    id: "ram-exhausted",
    test: /Server error.*(97|98|99)\s*%|out of memory|ENOMEM|std::bad_alloc/i,
    title: "Windows ran out of memory",
    fix: "Close browsers and other heavy apps before loading this model, then retry."
  },
  {
    id: "quant-missing",
    test: /requested quant\s*"?([A-Za-z0-9_]+)"?\s*not found/i,
    title: "This repo has no file in that format",
    fix: "MKMN will try the official repo, then MXFP4, and warn you if only slower formats exist."
  },
  {
    id: "no-chipset",
    test: /Requested chipset not available|chipset\s+"[^"]*"\s+not available/i,
    title: "No precompiled build of this model exists for this chip",
    fix: "Qualcomm AI Hub has no NPU bundle of this model for your chip (a Snapdragon X Plus is listed under its own name, and not every model has a build for it). MKMN can try a GGUF version instead; actual NPU execution must be checked on your device."
  },
  {
    id: "win193",
    test: /WinError 193/i,
    title: "An x64 program tried to load ARM64 libraries",
    fix: "MKMN only uses the GenieX command line and native ARM64 builds. Do not use the geniex Python package from an x64 Python."
  },
  { id: "sox", test: /SoX is not installed/i, title: "SoX is not installed", fix: "Only needed for audio features. Ignored.", ignore: true },
  {
    id: "npu-busy",
    test: /another (infer|session)|(?:npu|htp|hexagon).{0,40}(?:resource busy|in use)/i,
    title: "The runtime reported that the NPU is busy",
    fix: "Wait for the NPU workload to finish, then try again."
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

/** Rules whose advice is about sending a chat message; wrong on a download. */
const CHAT_ONLY = new Set(["npu-sdk-error", "connection-reset", "no-model", "humain-key", "humain-model", "humain-limit", "humain-offline", "npu-busy"]);

/**
 * The message for a failed `geniex pull`. A rule written for chat ("Send the message
 * again") would point the user at the wrong thing on a model card, so those fall back
 * to download wording; the raw output stays attached for the details.
 */
export function pullFailure(raw: string): FriendlyError {
  const fe = translateError(raw);
  if (fe && !CHAT_ONLY.has(fe.id)) return fe;
  const sdk = fe?.id === "npu-sdk-error";
  return {
    id: "pull",
    title: "The download did not finish",
    fix: sdk
      ? "GenieX stopped without giving a reason (its generic error, code -100000). Install it again: the download continues where it stopped. If it fails the same way, this model may not have a build for this PC; choose another one."
      : "Check your connection and disk space, then install it again: the download continues where it stopped.",
    raw,
  };
}

/** True when the line is known to be harmless noise. */
export function isNoise(line: string): boolean {
  return RULES.some((r) => r.ignore && r.test.test(line));
}
