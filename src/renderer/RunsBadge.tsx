/** Where a model runs on this PC, as the benchmark or the NPU load test saw it. A model nobody measured says so, instead of a guess. */
const INFO = {
  npu: { label: "NPU", hint: "Seen running on the NPU. Usually the fastest placement and it keeps the CPU free, but it is not guaranteed to be fastest for every model and prompt." },
  hybrid: { label: "NPU + CPU", hint: "Seen running hybrid: part of the model on the NPU, part on the CPU. Qualcomm's scheduler can make this the fastest path for some models — it is not always slower than NPU-only." },
  gpu: { label: "GPU", hint: "Seen running on the graphics chip: it does not use the NPU and it draws more power." },
  cpu: { label: "CPU", hint: "Seen running on the CPU only: it keeps the CPU busy." }
} as const;

const ELSEWHERE = " This placement was measured on ANOTHER PC (the tests shipped with the app); it has not been reproduced on this device.";

export function RunsBadge({ on, native, here }: { on?: "npu" | "hybrid" | "gpu" | "cpu"; native?: boolean; here?: boolean }) {
  // "here" separates a placement measured on THIS PC (settings.placements) from
  // the shipped test results (scores.json, recorded on a Snapdragon X Plus):
  // the latter must never read as this device's verification.
  if (!on) return <span className="badge runs-untested" title="Where this model runs was not measured on this device yet. It is known once it has been tried here.">Not measured here</span>;
  if (on === "npu" && native) return <span className="badge runs-native" title={"Compiled for the NPU (an AI Hub bundle or NPU Foundry build) and placed on it when it was tried." + (here ? "" : ELSEWHERE)}>Built for the NPU</span>;
  return <span className={`badge runs-${on}${here ? "" : " elsewhere"}`} title={INFO[on].hint + (here ? "" : ELSEWHERE)}>{INFO[on].label}{here ? "" : " (tested elsewhere)"}</span>;
}
