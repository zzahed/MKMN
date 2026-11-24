import type { ComputeTarget, HardwareProfile, RuntimeSettings } from "../shared/types";

/**
 * The compute targets this PC can offer and what each does to memory: pure functions, no file or path access,
 * so the window can import them without pulling the engine's Node-only code (runtime.ts) into its bundle.
 */

const int = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : null);

/** One architecture identity across the app: Rust reports "aarch64", Node and the UI say "arm64". */
export const normalizeArch = (arch: string | undefined | null): string =>
  arch === "aarch64" ? "arm64" : (arch ?? "unknown");

/** What each choice does to memory, for the sentence under the selector. */
export function backendNote(target: ComputeTarget, rt: RuntimeSettings = {}): string {
  if (target === "npu" || target === "hybrid") return "Runs on the NPU of a Snapdragon X with GenieX. Offloads model compute to dedicated neural hardware.";
  const layers = int(rt.gpuLayers);
  if (target === "gpu") {
    if (layers === 0) return "Graphics card selected, but the model is set to run entirely on the processor.";
    if (layers !== null && layers > 0) return `${layers} layers (parts) of the model run on the graphics card and the rest on the processor, so a model larger than the card's memory still loads, more slowly.`;
    return "Runs on the graphics card. If the model is larger than the card's memory, lower “Layers on the GPU” under Advanced load options so part of it runs on the processor.";
  }
  return rt.mmap === false ? "Runs on the processor, loaded fully into memory." : "Runs on the processor. A model larger than the free memory still starts, but more slowly.";
}

/** A machine-readable summary for the selector: which targets this PC can offer and why not. */
export function backendChoices(hw: Pick<HardwareProfile, "npuDetected" | "isSnapdragon" | "gpus">, o: { geniex: boolean; platform: NodeJS.Platform; arch: string }): { id: "npu" | "gpu" | "cpu"; available: boolean; note: string }[] {
  const npuOk = o.platform === "win32" && normalizeArch(o.arch) === "arm64" && hw.isSnapdragon && hw.npuDetected;
  const gpus = hw.gpus ?? [];
  return [
    { id: "npu", available: npuOk, note: npuOk ? (o.geniex ? "Snapdragon NPU, through GenieX." : "Snapdragon NPU. GenieX will be installed on first use.") : "Needs a Windows PC with a Snapdragon X (ARM64) and its NPU driver." },
    { id: "gpu", available: gpus.length > 0 || o.platform === "darwin", note: gpus.length ? gpus.map((g) => g.name + (g.vramGB ? ` (${g.vramGB} GB)` : "")).join(", ") : o.platform === "darwin" ? "Apple GPU, through Metal." : "No graphics card found; the CPU option always works." },
    { id: "cpu", available: true, note: "Works on every PC." }
  ];
}
