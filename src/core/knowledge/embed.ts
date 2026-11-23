/**
 * The multilingual sentence embedder the knowledge retrieval may use (
 * measured in docs/research/knowledge-retrieval-benchmark.md):
 * paraphrase-multilingual-MiniLM-L12-v2, q8 ONNX, run on the CPU through
 * onnxruntime-node. A question and a section written in different scripts, or a
 * question in words the files do not use, land near each other, which BM25 cannot do.
 *
 * Two parts: the model's own SentencePiece Unigram tokenizer (read from its
 * tokenizer.json, so no tokenizer library rides in the sidecar) and the pooling
 * (the mean of the last hidden state over the real tokens, L2-normalised). The ONNX
 * runtime is loaded only when an embedder is opened, so nothing here costs a
 * process that never uses it.
 */

/** What retrieval needs from an embedder: one unit vector per text. */
export interface Embedder {
  /** The model and its version, stored with the vectors: vectors of another model are never compared. */
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------- the tokenizer

interface TokenizerJson {
  model: { type: string; unk_id: number; vocab: [string, number][] };
  added_tokens?: { id: number; content: string }[];
}

const SPACE = "▁";

/**
 * The model's SentencePiece Unigram tokenizer, from its tokenizer.json: the text is
 * normalised (NFKC, control characters out, white space collapsed), split on white
 * space, each word prefixed with the metaspace mark, and cut into the pieces whose
 * scores add up highest (Viterbi). A character no piece holds is the unknown token.
 * The sequence is `<s> ... </s>`, cut to `maxTokens`.
 */
export class UnigramTokenizer {
  private readonly pieces = new Map<string, { id: number; score: number }>();
  private readonly maxPieceLength: number;
  private readonly unkId: number;
  private readonly unkScore: number;
  readonly bos: number;
  readonly eos: number;
  readonly pad: number;

  constructor(json: TokenizerJson, readonly maxTokens = 512) {
    if (json.model?.type !== "Unigram") throw new Error(`a Unigram tokenizer was expected, not ${json.model?.type}`);
    let longest = 1;
    let lowest = 0;
    for (const [i, [piece, score]] of json.model.vocab.entries()) {
      if (!this.pieces.has(piece)) this.pieces.set(piece, { id: i, score });
      if ([...piece].length > longest) longest = [...piece].length;
      if (score < lowest) lowest = score;
    }
    this.maxPieceLength = Math.min(longest, 64);
    this.unkId = json.model.unk_id;
    this.unkScore = lowest - 10;
    const special = (name: string, fallback: number) => json.added_tokens?.find((t) => t.content === name)?.id ?? this.pieces.get(name)?.id ?? fallback;
    this.bos = special("<s>", 0);
    this.pad = special("<pad>", 1);
    this.eos = special("</s>", 2);
  }

  static normalize(text: string): string {
    return text
      .normalize("NFKC")
      // eslint-disable-next-line no-control-regex -- control characters are dropped before the text is embedded
      .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** The best split of one metaspace-prefixed word into pieces (Viterbi over the piece scores). */
  private word(word: string): number[] {
    const chars = [...word];
    const n = chars.length;
    const best = new Array<number>(n + 1).fill(-Infinity);
    const from = new Array<number>(n + 1).fill(-1);
    const via = new Array<number>(n + 1).fill(-1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let piece = "";
      let matched = false;
      for (let j = i; j < Math.min(n, i + this.maxPieceLength); j++) {
        piece += chars[j];
        const hit = this.pieces.get(piece);
        if (!hit) continue;
        matched = true;
        const s = best[i] + hit.score;
        if (s > best[j + 1]) { best[j + 1] = s; from[j + 1] = i; via[j + 1] = hit.id; }
      }
      // no piece starts with this character: it is the unknown token, one character long
      if (!matched || best[i + 1] === -Infinity) {
        const s = best[i] + this.unkScore;
        if (s > best[i + 1]) { best[i + 1] = s; from[i + 1] = i; via[i + 1] = this.unkId; }
      }
    }
    const ids: number[] = [];
    for (let at = n; at > 0; at = from[at]) ids.push(via[at]);
    ids.reverse();
    // runs of unknown characters are one unknown token, as SentencePiece emits them
    return ids.filter((id, k) => !(id === this.unkId && ids[k - 1] === this.unkId));
  }

  encode(text: string): number[] {
    const words = UnigramTokenizer.normalize(text).split(" ").filter(Boolean);
    const ids: number[] = [this.bos];
    for (const w of words) {
      for (const id of this.word(SPACE + w)) {
        if (ids.length >= this.maxTokens - 1) break;
        ids.push(id);
      }
      if (ids.length >= this.maxTokens - 1) break;
    }
    ids.push(this.eos);
    return ids;
  }
}

// ---------------------------------------------------------------- pooling

/** The mean of the token vectors where the mask is 1, scaled to unit length. `hidden` is [batch, seq, dim], flat. */
export function meanPoolNormalize(hidden: Float32Array, mask: number[][], dim: number): Float32Array[] {
  const seq = mask[0]?.length ?? 0;
  return mask.map((row, b) => {
    const out = new Float32Array(dim);
    let count = 0;
    for (let t = 0; t < seq; t++) {
      if (!row[t]) continue;
      count++;
      const base = (b * seq + t) * dim;
      for (let d = 0; d < dim; d++) out[d] += hidden[base + d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) { out[d] /= Math.max(1, count); norm += out[d] * out[d]; }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) out[d] /= norm;
    return out;
  });
}

/** Cosine of two unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------------------------------------------------------------- the ONNX model

/** The smallest piece of onnxruntime-node this module uses (typed here so the dependency stays optional at compile time). */
interface OrtLike {
  InferenceSession: { create(path: string, opts?: Record<string, unknown>): Promise<{ inputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>> }> };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}

/**
 * Opens the embedder from an installed model folder (`model_quantized.onnx` and
 * `tokenizer.json`). The runtime is asked for two threads: the CPU is shared with
 * the router and the rest of the app, and an embedding of one question takes a few
 * milliseconds either way.
 */
export async function openOnnxEmbedder(dir: string, id: string, opts: { threads?: number; batch?: number } = {}): Promise<Embedder> {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const ort = (await import("onnxruntime-node" as string)) as unknown as OrtLike & { default?: OrtLike };
  const rt: OrtLike = (ort.InferenceSession ? ort : ort.default) as OrtLike;
  const tokenizer = new UnigramTokenizer(JSON.parse(readFileSync(path.join(dir, "tokenizer.json"), "utf8")) as TokenizerJson);
  const session = await rt.InferenceSession.create(path.join(dir, "model_quantized.onnx"), {
    intraOpNumThreads: opts.threads ?? 2, interOpNumThreads: 1, executionProviders: ["cpu"], graphOptimizationLevel: "all",
  });
  const batch = opts.batch ?? 8;
  let dim = 0;
  const run = async (texts: string[]): Promise<Float32Array[]> => {
    const ids = texts.map((t) => tokenizer.encode(t));
    const seq = Math.max(...ids.map((x) => x.length));
    const flat = (fill: (row: number[], t: number) => number) => BigInt64Array.from(ids.flatMap((row) => Array.from({ length: seq }, (_, t) => BigInt(fill(row, t)))));
    const mask = ids.map((row) => Array.from({ length: seq }, (_, t) => (t < row.length ? 1 : 0)));
    const feeds: Record<string, unknown> = {
      input_ids: new rt.Tensor("int64", flat((row, t) => (t < row.length ? row[t] : tokenizer.pad)), [ids.length, seq]),
      attention_mask: new rt.Tensor("int64", flat((row, t) => (t < row.length ? 1 : 0)), [ids.length, seq]),
    };
    if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new rt.Tensor("int64", flat(() => 0), [ids.length, seq]);
    const out = await session.run(feeds);
    const hidden = out.last_hidden_state ?? Object.values(out)[0];
    dim = hidden.dims[2];
    return meanPoolNormalize(hidden.data as Float32Array, mask, dim);
  };
  const first = await run(["warm up"]);
  dim = first[0].length;
  return {
    id,
    dim,
    async embed(texts: string[]) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batch) out.push(...(await run(texts.slice(i, i + batch))));
      return out;
    },
  };
}
