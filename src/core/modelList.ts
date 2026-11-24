import type { CatalogItem } from "../shared/api";
import { normalizeName } from "./foundry";
import { scoreOf } from "./scores";
import { verdictOf } from "./loadFailures";

/**
 * How the list of models is arranged for the screen: the ones that were tested first, one line per model, the faster engine when two were
 * tested; the ones with no score in a fold. The quality of a short test varies from run to run, so it never decides which of two builds is
 * shown: the speed does.
 */
export type SortBy = "score" | "speed" | "size" | "name";
export type EngineFilter = "all" | "geniex" | "foundry";
export interface ListOptions { sortBy: SortBy; engine: EngineFilter; installedOnly: boolean }

export const isFoundryItem = (i: Pick<CatalogItem, "entry">) => i.entry.id.startsWith("foundry:");

/** Where a model was seen to run: on this PC, else in the tests shipped with the app. Nothing when it was never measured: the build says what it is made for, not where it runs. */
export const placementOf = (i: Pick<CatalogItem, "entry" | "runsOn">): CatalogItem["runsOn"] | undefined => i.runsOn ?? (scoreOf(i.entry)?.runsOn as CatalogItem["runsOn"] | undefined);

/** What the RunsBadge shows, as { on, here }: an explicit placement wins (here = it was
 *  measured on THIS PC, not just in the shipped tests); when there is none, the SAME
 *  local bench record the "Measured here" line reads feeds the badge — one measurement
 *  shows in both places, so a card never claims "Not measured here" beside its own
 *  measured tok/s. Only the badge's real compute targets pass; anything else (and no
 *  bench record at all) stays the unmeasured badge. */
export function badgePlacement(i: Pick<CatalogItem, "entry" | "runsOn">, benchCompute?: string | null): { on?: "npu" | "hybrid" | "gpu" | "cpu"; here: boolean } {
  const p = placementOf(i);
  if (p) return { on: p, here: !!i.runsOn };
  const c = benchCompute ?? undefined;
  const ok = c === "npu" || c === "hybrid" || c === "gpu" || c === "cpu";
  return { on: ok ? c : undefined, here: ok };
}

/** The label of one model in the benchmark form's select: the NAME only — the long ref
 *  (custom:repo:quant) rides in the option's tooltip, where a wide list never crowds
 *  it — and a model already measured on this PC says so right in the list, so the
 *  person can see at a glance which runs would be new and which would re-measure. */
export function benchOptionLabel(i: Pick<CatalogItem, "entry" | "runsOn">, benchCompute?: string | null): string {
  return `${i.entry.name}${badgePlacement(i, benchCompute).here ? " — measured here" : ""}`;
}

/** The one-line hint an UNMEASURED model's card shows: where a placement comes from.
 *  The wording matches the section names the Settings screen really renders. */
export function measureHint(): string {
  return "Where this model runs is measured on this PC, never assumed: Settings → Developer → NPU load test (a few minutes), or the Single-model benchmark beside it (both need Developer tools on).";
}

/** Precompiled for the NPU, and seen running on it alone: an AI Hub bundle, or a Foundry Local build made for the NPU. */
export const isNativeNpu = (i: Pick<CatalogItem, "entry" | "runsOn">) =>
  placementOf(i) === "npu" && (i.entry.engine === "qairt" || (isFoundryItem(i) && i.entry.foundryDevice === "NPU"));

/** The same model whichever engine runs it: "Qwen3-1.7B (native NPU bundle)" and "Qwen3-1.7B (Foundry Local)" meet. */
export const modelKey = (i: Pick<CatalogItem, "entry">) => normalizeName(i.entry.name.replace(/\s*\(Foundry Local\)/i, ""));

const speed = (i: CatalogItem) => scoreOf(i.entry)?.tokPerSec ?? 0;
const quality = (i: CatalogItem) => scoreOf(i.entry)?.quality ?? -1;

function sorted(list: CatalogItem[], by: SortBy): CatalogItem[] {
  const out = [...list];
  const name = (a: CatalogItem, b: CatalogItem) => a.entry.name.localeCompare(b.entry.name);
  if (by === "size") return out.sort((a, b) => a.entry.sizeGB - b.entry.sizeGB || name(a, b));
  if (by === "name") return out.sort(name);
  if (by === "speed") return out.sort((a, b) => speed(b) - speed(a) || quality(b) - quality(a) || name(a, b));
  return out.sort((a, b) => quality(b) - quality(a) || speed(b) - speed(a) || name(a, b));
}

export interface Arranged {
  /** Tested, one line per model. */
  tested: CatalogItem[];
  /** The same models on the engine that was slower: kept apart, not lost. */
  slower: CatalogItem[];
  /** No score yet. */
  unscored: CatalogItem[];
  /** For a model shown once, the same model on the other engine, which was slower: by the id of the line shown. */
  alt: Record<string, CatalogItem>;
}

export function arrangeModels(items: CatalogItem[], o: ListOptions): Arranged {
  let list = items;
  if (o.engine !== "all") list = list.filter((i) => (o.engine === "foundry") === isFoundryItem(i));
  if (o.installedOnly) list = list.filter((i) => i.installed);
  const groups = new Map<string, CatalogItem[]>();
  const unscored: CatalogItem[] = [];
  for (const i of list) {
    if (!scoreOf(i.entry)) { unscored.push(i); continue; }
    const k = modelKey(i);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const tested: CatalogItem[] = [], slower: CatalogItem[] = [];
  const alt: Record<string, CatalogItem> = {};
  for (const g of groups.values()) {
    // the build that runs fully on the NPU is shown before a faster one that does not: a hybrid or CPU build never hides it
    const full = (i: CatalogItem) => Number(placementOf(i) === "npu");
    const [best, ...others] = [...g].sort((a, b) => full(b) - full(a) || speed(b) - speed(a) || quality(b) - quality(a));
    tested.push(best);
    slower.push(...others);
    if (others[0]) alt[best.entry.id] = others[0];
  }
  return { tested: sorted(tested, o.sortBy), slower: sorted(slower, o.sortBy), unscored: sorted(unscored, o.sortBy === "size" ? "size" : "name"), alt };
}

/**
 * The short list at the top: the tested models worth the download. Good enough (quality of 45 or more), not too slow (10 tokens per second or
 * more), the full-NPU build of each, then the faster one, only the ones seen running fully on the NPU (never a hybrid or CPU build; a GGUF counts as much as a native build, and the provider does not matter), the best scores first, at most `max`. The rest of the tested models stay below, and the ones with no score
 * are folded: nothing is recommended that was not measured.
 */
export function recommendedModels(items: CatalogItem[], max = 9): CatalogItem[] {
  const { tested } = arrangeModels(items, { sortBy: "score", engine: "all", installedOnly: false });
  return tested.filter((i) => placementOf(i) === "npu" && (scoreOf(i.entry)?.quality ?? 0) >= 45 && (scoreOf(i.entry)?.tokPerSec ?? 0) >= 10).slice(0, max);
}

/** What a line says of the other engine, when the same model was tested on it too and was slower: "Faster than on GenieX (34.7 against 27.9 tokens/s)". */
export function altNote(shown: CatalogItem, other: CatalogItem): string {
  const a = scoreOf(shown.entry)?.tokPerSec, b = scoreOf(other.entry)?.tokPerSec;
  const name = isFoundryItem(other) ? "Foundry Local" : "Qualcomm's NPU engine";
  // words a second (about ¾ of a word per token), the unit of the speed column beside it
  const words = (t: number) => Math.max(1, Math.round(t * 0.75));
  return a && b ? `Faster here than with ${name} (about ${words(a)} against ${words(b)} words/s)` : `Also tested with ${name}`;
}

/**
 * The models the list shows: those that can work on this PC. A model whose load test failed here
 * (`loadFailures`, kept per GenieX version) is left out, and a Foundry Local build made for the GPU or the
 * CPU is left out unless part-CPU loading is allowed or it was measured on the NPU here (the decided
 * NPU-first rule). The chosen model always stays, so the choice never points at nothing.
 */
export function listedHere(
  items: CatalogItem[],
  s: { loadFailures?: Record<string, unknown>; placements?: Record<string, string>; allowHybridLoad?: boolean; selectedModelId?: string | null },
): CatalogItem[] {
  const failed = s.loadFailures ?? {};
  return items.filter((i) => {
    if (i.entry.id === s.selectedModelId) return true;
    // the registered machine modelVerdict: a model that does not load here is left out (a load that worked wins)
    if ([i.ref, i.entry.repo].some((r) => verdictOf(r, { placements: s.placements, loadFailures: failed }) === "fails")) return false;
    const device = i.entry.foundryDevice;
    if (isFoundryItem(i) && device && device !== "NPU" && !s.allowHybridLoad) return s.placements?.[i.ref] === "npu";
    return true;
  });
}

/**
 * What a chat preloads through GenieX for the chosen item: its ref, or nothing for a model GenieX does not serve
 * (a Foundry Local model is loaded by Foundry Local on the first message; a cloud chat loads nothing here). The ref
 * of a Foundry item carries no "foundry:" mark, so the item itself is asked, never its ref.
 */
export function preloadRefOf(item: Pick<CatalogItem, "entry" | "ref"> | null | undefined, cloud: boolean): string {
  if (!item || cloud || isFoundryItem(item)) return "";
  return item.ref || item.entry.id;
}
