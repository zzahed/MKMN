/*
 * Edit a copy: a surgical string-level edit of `word/document.xml`, on a COPY
 * beside the source (docs/design/doc-edit-copy.md). Pure core: bytes in, bytes
 * out — no fs, no model, no sidecar imports.
 *
 * Why not parse → mutate → serialize: there is no XML serializer in this app,
 * and re-emitting a document risks shifting every byte the person did not ask
 * to change. Why not buildDocx: it rebuilds the WHOLE file from the markdown
 * form and loses formatting everywhere by construction. The chosen path
 * guarantees its central claim by construction: the copy equals the source
 * except inside the edited ranges — the rewrite touches only the matched
 * `w:t` spans, and every other zip part rides along byte for byte.
 */
import { readZip, writeZip, toBytes, fromBytes, type ZipFiles } from "./zip";
import { unesc, escText } from "./xml";

/** The only part an edit may touch. */
export const DOC_EDIT_PART = "word/document.xml";
export const DOC_EDIT_MAX_OPS = 8;
export const DOC_EDIT_MAX_FIND = 600;
/** The model view's character cap, with a visible marker when it cuts. */
export const DOC_EDIT_VIEW_CAP = 12_000;

/** One proposed edit: exact text in one paragraph, and its replacement ("" deletes). */
export type DocEditOp = { find: string; replace: string };

/** A validation fault with a message meant for the person (and the model's re-ask). */
export class DocEditFault extends Error {}

// ---------------------------------------------------------------- the tokenizer

/** One `w:t` element's spans in the decoded document string. */
export type SegToken = {
  /** The opening `<w:t …>` tag, so `xml:space="preserve"` can be added in place. */
  openStart: number;
  openEnd: number;
  /** The raw text content span (escaped bytes; rewrite splices here). */
  textStart: number;
  textEnd: number;
  /** The UNESCAPED text, as the projection shows it. */
  text: string;
  /** The text's first character's offset in the paragraph's projection line. */
  projStart: number;
};

/** One `w:p` element and its projection line: the paragraph the model sees. */
export type ParaToken = {
  start: number;
  end: number;
  /** The projection line: the `w:t` texts (unescaped), plus one tab for a
   *  `w:tab` and one space for a `w:br`/`w:cr` — mirroring wordRuns in
   *  office.ts. A tab or break is a GAP: it can sit between two segments but
   *  a find that crosses one is refused, because the rewrite only splices
   *  `w:t` spans. */
  text: string;
  segs: SegToken[];
};

const PARA_OPEN_RE = /<w:p(?=[\s/>])[^>]*>/g;
const SEG_RE = /<w:t(?=[\s/>])[^>]*>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;

/**
 * Tokenizes the decoded `word/document.xml` into paragraph spans and their
 * `w:t` segments. Plain string scanning, not parseXml: the positions ARE the
 * product, because the rewrite splices the raw string so untouched bytes stay
 * untouched. `w:p` does not nest in a document body, but a text box holds
 * `w:p` elements inside a run of an outer one; those inner paragraphs are
 * tokenized on their own and edit exactly the same way.
 */
export function tokenizeDocx(doc: string): ParaToken[] {
  const paras: ParaToken[] = [];
  PARA_OPEN_RE.lastIndex = 0;
  for (let m; (m = PARA_OPEN_RE.exec(doc)); ) {
    const openStart = m.index;
    const openEnd = openStart + m[0].length;
    if (m[0].endsWith("/>")) {
      paras.push({ start: openStart, end: openEnd, text: "", segs: [] });
      continue;
    }
    const close = doc.indexOf("</w:p>", openEnd);
    if (close < 0) break; // damaged part: read what came before, never guess past it
    const end = close + "</w:p>".length;
    paras.push(buildPara(doc, openStart, openEnd, end));
    PARA_OPEN_RE.lastIndex = end;
  }
  return paras;
}

function buildPara(doc: string, start: number, openEnd: number, end: number): ParaToken {
  const inner = doc.slice(openEnd, end - "</w:p>".length);
  const segs: SegToken[] = [];
  let text = "";
  SEG_RE.lastIndex = 0;
  for (let m; (m = SEG_RE.exec(inner)); ) {
    if (m[1] !== undefined) {
      // The open tag is everything before the text content, computed from the
      // match's END (an attribute value may legally contain a raw ">").
      const closeLen = "</w:t>".length;
      const openTag = m[0].slice(0, m[0].length - closeLen - m[1].length);
      const openStart = openEnd + m.index;
      const openStop = openStart + openTag.length;
      const textStart = openStop;
      const textEnd = textStart + m[1].length;
      segs.push({ openStart, openEnd: openStop, textStart, textEnd, text: unesc(m[1]), projStart: text.length });
      text += unesc(m[1]);
    } else {
      // A tab or a line break: a gap char in the projection (see ParaToken).
      text += m[0].startsWith("<w:tab") ? "\t" : " ";
    }
  }
  return { start, end, text, segs };
}

/** The whole document's projection: one line per paragraph, in document order. */
export function projectionLines(paras: ParaToken[]): string[] {
  return paras.map((p) => p.text);
}

/** What the model receives: the projection, capped with a visible marker when it cuts. */
export function docxModelView(doc: string, cap = DOC_EDIT_VIEW_CAP): string {
  const text = projectionLines(tokenizeDocx(doc)).join("\n");
  if (text.length <= cap) return text;
  const cut = text.length - cap;
  return `${text.slice(0, cap)}\n…(+${cut} characters not shown)`;
}

// ---------------------------------------------------------------- matching and applying

/**
 * Which segment owns each character of a paragraph's projection line: a
 * segment index, or -1 for a gap (tab or break). Built only for the paragraph
 * that matched, so a large document never pays for it.
 */
function ownersOf(para: ParaToken): Int32Array {
  const owners = new Int32Array(para.text.length).fill(-1);
  for (let i = 0; i < para.segs.length; i++) {
    const seg = para.segs[i];
    for (let o = seg.projStart; o < seg.projStart + seg.text.length; o++) owners[o] = i;
  }
  return owners;
}

/** The string escapes and control rules both sides (engine and re-check) share. */
function checkOp(op: DocEditOp): void {
  const q = JSON.stringify(op.find);
  if (typeof op.find !== "string" || op.find.length === 0) throw new DocEditFault("an edit has an empty find text.");
  if (op.find.length > DOC_EDIT_MAX_FIND) throw new DocEditFault(`the find text is longer than ${DOC_EDIT_MAX_FIND} characters.`);
  if (/[\n\r]/.test(op.find)) throw new DocEditFault(`the find text ${q} has a line break in it; quote the text of a single paragraph line.`);
  if (typeof op.replace !== "string") throw new DocEditFault(`the replacement for ${q} is missing.`);
  if (/[\n\r]/.test(op.replace)) throw new DocEditFault(`the replacement for ${q} has a line break in it; Edit a copy changes text inside one paragraph at a time.`);
  // eslint-disable-next-line no-control-regex -- a replacement must not carry a control character
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(op.replace)) throw new DocEditFault(`the replacement for ${q} has a control character in it.`);
}

/**
 * Applies the ops to the decoded document string, validating EVERY op before
 * returning: each find must occur exactly once in the whole projection (in one
 * paragraph), and must not cross a tab or line break. The ops compose — each
 * is matched against the projection as the earlier ops left it. Throws
 * DocEditFault with the exact fault; nothing is ever half-applied (the caller
 * writes the result only after this returns).
 */
export function applyDocEdits(docXml: string, ops: readonly DocEditOp[]): string {
  if (ops.length > DOC_EDIT_MAX_OPS) throw new DocEditFault(`the proposal has ${ops.length} edits; at most ${DOC_EDIT_MAX_OPS} are accepted.`);
  let cur = docXml;
  for (const op of ops) {
    checkOp(op);
    const paras = tokenizeDocx(cur);
    let hit: { para: ParaToken; at: number } | null = null;
    let total = 0;
    for (const para of paras) {
      let at = para.text.indexOf(op.find);
      for (; at >= 0; at = para.text.indexOf(op.find, at + 1)) {
        total++;
        if (!hit) hit = { para, at };
      }
    }
    const q = JSON.stringify(op.find);
    if (total === 0) throw new DocEditFault(`the find text ${q} was not found in the document.`);
    if (total > 1) throw new DocEditFault(`the find text ${q} appears ${total} times in the document; quote enough of the surrounding text to make it unique.`);
    const { para, at } = hit!;
    const end = at + op.find.length;
    const owners = ownersOf(para);
    for (let o = at; o < end; o++) {
      if (owners[o] < 0) throw new DocEditFault(`the find text ${q} crosses a tab or line break in the document; quote text that sits inside one line without tabs.`);
    }
    cur = rewriteSpan(cur, para, at, end, op.replace, owners);
  }
  return cur;
}

/**
 * Splices the replacement into the raw string: the FIRST affected `w:t` keeps
 * its formatting (its `rPr` is not touched) and receives prefix + replacement;
 * every middle segment of a multi-segment match is emptied; the LAST segment
 * keeps its suffix. `xml:space="preserve"` is added when the new text starts
 * or ends with a space. Everything outside the matched spans is untouched.
 */
type SegEdit = { start: number; end: number; content: string; preserve: boolean; openStart: number };

function rewriteSpan(cur: string, para: ParaToken, at: number, end: number, replace: string, owners: Int32Array): string {
  const first = para.segs[owners[at]]!;
  const last = para.segs[owners[end - 1]]!;
  const prefix = first.text.slice(0, at - first.projStart);
  const suffix = first.text.slice(end - first.projStart);
  const edits: SegEdit[] = [];
  // The first affected segment keeps its formatting and takes prefix + replacement
  // (+ its own suffix when the whole match sits inside it).
  edits.push(segEdit(first, prefix + replace + (first === last ? suffix : "")));
  for (let i = owners[at] + 1; last !== first && i < owners[end - 1]; i++) {
    const mid = para.segs[i]!;
    edits.push({ start: mid.textStart, end: mid.textEnd, content: "", preserve: false, openStart: mid.openStart });
  }
  if (last !== first) edits.push(segEdit(last, last.text.slice(end - last.projStart)));
  edits.sort((a, b) => b.start - a.start); // descending: earlier offsets stay valid
  let out = cur;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.content + out.slice(e.end);
    if (e.preserve) {
      const open = out.slice(e.openStart, e.start);
      if (!/xml:space\s*=\s*"preserve"/.test(open)) {
        // Add the attribute to the opening tag, before its closing ">".
        const gt = out.indexOf(">", e.openStart);
        out = out.slice(0, gt) + ' xml:space="preserve"' + out.slice(gt);
      }
    }
  }
  return out;
}

function segEdit(seg: SegToken, newText: string): SegEdit {
  return {
    start: seg.textStart,
    end: seg.textEnd,
    content: escText(newText),
    preserve: newText.length > 0 && (/^ /.test(newText) || / $/.test(newText)),
    openStart: seg.openStart,
  };
}

// ---------------------------------------------------------------- the copy and its verification

/**
 * Builds the edited copy: the source's zip with `word/document.xml` replaced
 * by the edited string. Every other part rides along byte for byte, and the
 * parts keep their original order.
 */
export async function buildEditedCopy(source: Uint8Array, ops: readonly DocEditOp[]): Promise<Uint8Array> {
  const files = await readZip(source);
  const part = files[DOC_EDIT_PART];
  if (!part) throw new DocEditFault("This Word file has no document part; it may be damaged.");
  const edited = applyDocEdits(fromBytes(part), ops);
  const out: ZipFiles = { ...files, [DOC_EDIT_PART]: toBytes(edited) };
  return writeZip(out);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Applies the ops to plain projection lines — the re-check's independent path. */
function applyLines(lines: string[], ops: readonly DocEditOp[]): string[] {
  const out = [...lines];
  for (const op of ops) {
    let total = 0;
    let row = -1;
    let col = -1;
    out.forEach((line, i) => {
      for (let at = line.indexOf(op.find); at >= 0; at = line.indexOf(op.find, at + 1)) {
        total++;
        if (row < 0) { row = i; col = at; }
      }
    });
    if (total !== 1) throw new DocEditFault(`the find text ${JSON.stringify(op.find)} matches ${total} times in the re-check, not exactly once.`);
    out[row] = out[row].slice(0, col) + op.replace + out[row].slice(col + op.find.length);
  }
  return out;
}

/**
 * Verifies the edited copy, REOPENED FROM DISK, against the source:
 * every part except document.xml byte-equal, document.xml exactly the
 * proposed edit, the copy's projection equal to the source's projection with
 * the ops applied textually, and the paragraph count unchanged. Returns null
 * when all hold, else the fault — never a guess, and the copy is never
 * deleted here (the person decides).
 */
export async function verifyEdit(source: Uint8Array, copy: Uint8Array, ops: readonly DocEditOp[]): Promise<string | null> {
  let src: ZipFiles;
  let dst: ZipFiles;
  try {
    src = await readZip(source);
  } catch (e) {
    return `the source file could not be re-read: ${(e as Error).message}`;
  }
  try {
    dst = await readZip(copy);
  } catch (e) {
    return `the edited copy could not be re-opened: ${(e as Error).message}`;
  }
  for (const [name, part] of Object.entries(src)) {
    if (name === DOC_EDIT_PART) continue;
    const got = dst[name];
    if (!got) return `the copy is missing the part ${name}.`;
    if (!bytesEqual(got, part)) return `the part ${name} changed, but only ${DOC_EDIT_PART} may change.`;
  }
  if (!dst[DOC_EDIT_PART]) return "the copy has no document part.";
  const srcDoc = fromBytes(src[DOC_EDIT_PART]!);
  let expected: string;
  try {
    expected = applyDocEdits(srcDoc, ops);
  } catch (e) {
    return `the proposed edit no longer validates: ${(e as Error).message}`;
  }
  const dstDoc = fromBytes(dst[DOC_EDIT_PART]!);
  if (dstDoc !== expected) return "the copy's document does not equal the proposed edit.";
  const srcLines = projectionLines(tokenizeDocx(srcDoc));
  const dstLines = projectionLines(tokenizeDocx(dstDoc));
  if (dstLines.length !== srcLines.length) return "the paragraph count changed; Edit a copy keeps the paragraphs as they are.";
  try {
    const expectedLines = applyLines(srcLines, ops);
    if (dstLines.join("\n") !== expectedLines.join("\n")) return "the copy's text does not equal the source text with the proposed edits applied.";
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}
