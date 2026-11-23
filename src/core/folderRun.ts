import * as fs from "fs";
import * as path from "path";
import type { FolderCall } from "../core/folderTools";
import { READABLE_DOC, documentText } from "../core/officeRead";

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv", "dist", "build", "out", ".next", "target", "$RECYCLE.BIN", "System Volume Information"]);
const MAX_ENTRIES = 200;
const MAX_SEARCH_FILES = 3000;
const MAX_SEARCH_BYTES = 1_000_000;
const MAX_HITS = 30;
const MAX_DEPTH = 8;

/** A path the model gave, resolved inside the folder. Anything that leaves it (.., another drive, a link pointing out) is refused. */
export function resolveInside(root: string, rel: string): string {
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel.trim() === "" || rel.trim() === "." ? "." : rel.trim());
  const inside = (p: string) => { const r = path.relative(realRoot, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  if (!inside(target)) throw new Error("That path is outside the project folder.");
  let real: string;
  try { real = fs.realpathSync(target); } catch { throw new Error("No such file or folder."); }
  if (!inside(real)) throw new Error("That path is outside the project folder.");
  return real;
}

const shown = (root: string, p: string) => path.relative(fs.realpathSync(root), p).split(path.sep).join("/") || ".";
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);

function isText(buf: Buffer): boolean {
  return !buf.subarray(0, 4096).includes(0);
}

export function listDir(root: string, rel: string): string {
  const dir = resolveInside(root, rel);
  if (!fs.statSync(dir).isDirectory()) throw new Error("That is a file, not a folder. Use readfile.");
  const all = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)));
  all.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const rows = all.slice(0, MAX_ENTRIES).map((e) => {
    if (e.isDirectory()) return `${e.name}/`;
    let size = "";
    try { size = `  (${kb(fs.statSync(path.join(dir, e.name)).size)})`; } catch { /* unreadable entry */ }
    return `${e.name}${size}`;
  });
  if (!rows.length) return `${shown(root, dir)}: empty.`;
  return `${shown(root, dir)}:\n${rows.join("\n")}${all.length > MAX_ENTRIES ? `\n[… ${all.length - MAX_ENTRIES} more entries not shown]` : ""}`;
}

/**
 * A file read through one open handle: what is checked (a folder, its size) is the file that is read, even if the path
 * is swapped or the file grows in between. A folder gives null; a file over `max` bytes throws `tooBig(size)`.
 */
export function readCapped(file: string, max: number, tooBig: (size: number) => Error): { buf: Buffer; st: fs.Stats } | null {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EISDIR") return null; throw e; }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return null;
    if (st.size > max) throw tooBig(st.size);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) { const n = fs.readSync(fd, buf, got, st.size - got, got); if (!n) break; got += n; }
    return { buf: got < st.size ? buf.subarray(0, got) : buf, st };
  } finally { fs.closeSync(fd); }
}

export function readFile(root: string, rel: string, maxChars: number): string {
  const file = resolveInside(root, rel);
  const read = readCapped(file, 20_000_000, (size) => new Error(`The file is ${kb(size)}, too big to read.`));
  if (!read) throw new Error("That is a folder, not a file. Use listdir.");
  const { buf } = read;
  if (!isText(buf)) throw new Error("This is not a text file (binary content), so it cannot be read.");
  const text = buf.toString("utf8");
  if (text.length <= maxChars) return text || "[empty file]";
  return `${text.slice(0, maxChars)}\n[… cut after ${maxChars} of ${text.length} characters to fit the model's context. Search for a word to find the part you need.]`;
}

export function searchFiles(root: string, needle: string): string {
  const top = resolveInside(root, ".");
  const q = needle.toLowerCase();
  const hits: string[] = [];
  let scanned = 0;
  let capped = false;
  const walk = (dir: string, depth: number) => {
    if (capped || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (capped) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (++scanned > MAX_SEARCH_FILES) { capped = true; return; }
      let buf: Buffer;
      try { const read = readCapped(full, MAX_SEARCH_BYTES, () => new Error("too big")); if (!read) continue; buf = read.buf; } catch { continue; }
      if (!isText(buf)) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(q)) continue;
        hits.push(`${shown(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
        if (hits.length >= MAX_HITS) { capped = true; return; }
      }
    }
  };
  walk(top, 0);
  if (!hits.length) return `No file contains “${needle}”${scanned > MAX_SEARCH_FILES ? " in the first files scanned" : ""}.`;
  return `${hits.join("\n")}${capped ? `\n[… more matches may exist, search for something more specific]` : ""}`;
}

const MAX_DOC_BYTES = 30 * 1024 ** 2;
const docCache = new Map<string, { mtime: number; text: string }>();
/** A Word, Excel, PowerPoint, OpenDocument or RTF file of the folder as text (kept until the file changes). */
async function documentOf(file: string): Promise<string> {
  const hit = docCache.get(file);
  if (hit && hit.mtime === fs.statSync(file).mtimeMs) return hit.text;
  const read = readCapped(file, MAX_DOC_BYTES, (size) => new Error(`The file is ${kb(size)}, too big to read.`));
  if (!read) throw new Error("That is a folder, not a file. Use listdir.");
  const { buf, st } = read;
  const { text } = await documentText(path.basename(file), new Uint8Array(buf));
  docCache.set(file, { mtime: st.mtimeMs, text });
  if (docCache.size > 30) docCache.delete(docCache.keys().next().value as string);
  return text;
}
async function readDocument(root: string, rel: string, maxChars: number): Promise<string> {
  const text = await documentOf(resolveInside(root, rel));
  return text.length <= maxChars ? text || "[empty file]" : `${text.slice(0, maxChars)}\n[… cut after ${maxChars} of ${text.length} characters to fit the model's context. Ask for a part of it or search for a word.]`;
}
/** Matches inside the documents of the folder (the text files are searched by searchFiles). */
async function searchDocuments(root: string, needle: string): Promise<string[]> {
  const q = needle.toLowerCase(), hits: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= MAX_HITS || depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (hits.length >= MAX_HITS) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1); continue; }
      if (!e.isFile() || !READABLE_DOC.test(e.name)) continue;
      let text: string;
      try { text = await documentOf(full); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) if (lines[i].toLowerCase().includes(q)) hits.push(`${shown(root, full)}: ${lines[i].trim().slice(0, 160)}`);
    }
  };
  await walk(resolveInside(root, "."), 0);
  return hits;
}

/** Runs one block of the model against the project folder. Throws a readable message on failure. */
export function runFolderCall(root: string, call: FolderCall, maxChars: number): string | Promise<string> {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("The project folder is no longer there. Choose it again in the project.");
  if (call.op === "list") return listDir(root, call.arg);
  if (call.op === "read") {
    if (READABLE_DOC.test(call.arg.trim())) { resolveInside(root, call.arg); return readDocument(root, call.arg, maxChars); }
    return readFile(root, call.arg, maxChars);
  }
  const plainHits = searchFiles(root, call.arg);
  return searchDocuments(root, call.arg).then((docs) => (docs.length ? `${/^No file contains/.test(plainHits) ? "" : `${plainHits}\n`}${docs.join("\n")}` : plainHits));
}
