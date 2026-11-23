// One guard for the language of the app: English and Arabic only, with a short,
// named allowlist for symbols, third-party text and the Arabic brand.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Files and folders whose non-English text is the feature or the record, never interface copy. */
export const ALLOWED = [
  { path: "scripts/check-language.mjs", why: "the guard's own patterns for the accents it refuses" },
  { path: "src/core/math.ts", why: "mathematical Greek letters and symbols" },
  { path: "src/core/page/html.ts", why: "third-party author names in licence banners" },
  { path: "src/core/page/vendor.generated.ts", why: "third-party licences" },
  { path: "src/core/page/icons.generated.ts", why: "third-party icon names" },
  { path: "docs/design/BRAND.md", why: "the brand explains its Arabic name and approved Arabic copy" },
  { path: "README.md", why: "the public readme explains the Arabic name" },
  { path: "installer.nsi", why: "the installer keeps the Arabic product name" },
];

/** Folders and files that are evidence, third-party code or test fixtures, not shipped copy. */
const EXCLUDED = [
  "tests/",
  "crates/",
  "build/",
  "docs/evidence/",
  "src-tauri/gen/",
  "scripts/xblocks-smoke/",
  "THIRD_PARTY_LICENSES.txt",
  "node_modules/",
  "dist/",
  "target/",
];

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".ps1", ".psm1", ".nsi", ".md",
  ".json", ".html", ".css", ".txt", ".yml", ".yaml", ".toml",
]);

/** English words that carry an accent, and proper names, are not another language. */
const ACCENTED_ENGLISH = /(?<![\p{L}])(café|cafés|naïve|naïvely|résumé|résumés|façade|façades|élite|élites|cliché|clichés|décor|décors|über|Pokémon|Michał|Sajnóg)(?![\p{L}])/giu;

const FRENCH_STOP = new Set(("le la les des une un est pour que qui dans avec sur pas plus mais ou et je tu il elle nous vous ils elles mon ma mes ton ta tes son sa ses ce cette ces comment pourquoi quand fais fait peux peut veux voudrais tres aussi donc alors bonjour merci au aux du de d l c j n qu ne se sont etait ete comme tout tous toute toutes leur leurs notre votre nos vos cet autre meme sans sous entre encore bien deux trois chaque celui celle ceux celles quoi dont y en").split(" "));
const FRENCH_STRONG = new Set("le les des une est pour que qui dans avec sur pas plus mais je nous vous ce cette ces au aux du de un ne se sont etre fait fais tout tous comme".split(" "));

const OTHER_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Sinhala}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Lao}\p{Script=Georgian}\p{Script=Armenian}]/u;

const CODE_LINE = /^\s*(?:```|~~~|\/\/|\/\*|\*|#|<!--|import |export |const |let |var |function |class |interface |type |return |if \(|for \(|while \(|switch \(|case |default:|[{}[\]();,]+$)/;

export function allowlistReason(path) {
  for (const entry of ALLOWED) if (path === entry.path || path.startsWith(entry.path)) return entry.why;
  return null;
}

function excluded(path) {
  return EXCLUDED.some((prefix) => path.startsWith(prefix));
}

function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  // a path still in the index but deleted in the working tree (a release's old matrix, removed on purpose) has no text to scan
  return out.split("\0").filter((p) => p && existsSync(join(root, p)));
}

function isFrenchLine(line) {
  const clean = line.replace(ACCENTED_ENGLISH, " ");
  const tokens = clean.toLowerCase().replace(/[’']/g, "'").match(/[a-zà-ÿ']+/g) ?? [];
  if (tokens.length < 8) return false;
  let hits = 0, strong = 0;
  for (const token of tokens) {
    const word = token.replace(/'/g, "");
    if (FRENCH_STOP.has(word)) hits += 1;
    if (FRENCH_STRONG.has(word)) strong += 1;
  }
  return hits >= 4 && strong >= 2 && hits / tokens.length >= 0.28;
}

/** Check one text without touching the disk. Returns one line per fault. */
export function scanText(text, path = "text") {
  const faults = [];
  const lines = text.split(/\r?\n/);
  const reason = allowlistReason(path);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (reason) continue;
    if (OTHER_SCRIPTS.test(line)) {
      faults.push(`${path}:${i + 1}: another script is not allowed: ${line.trim().slice(0, 120)}`);
      continue;
    }
    if (!CODE_LINE.test(line) && isFrenchLine(line)) {
      faults.push(`${path}:${i + 1}: text in another language outside the allowlist: ${line.trim().slice(0, 120)}`);
      continue;
    }
    // an accent is a fault in code lines too: the app reads and writes English and Arabic only
    const withoutNames = line.replace(ACCENTED_ENGLISH, " ");
    const accented = withoutNames.match(/[^\p{ASCII}]/gu) ?? [];
    const latinAccent = accented.filter((ch) => /\p{Script=Latin}/u.test(ch));
    if (latinAccent.length) {
      faults.push(`${path}:${i + 1}: accent outside the English/Arabic allowlist (${[...new Set(latinAccent)].join("")}): ${line.trim().slice(0, 120)}`);
    }
  }
  return faults;
}

/** Scan the tracked files of a checkout. Throws on invalid UTF-8. */
export function scanLanguage(root = process.cwd()) {
  const faults = [];
  for (const path of trackedFiles(root)) {
    if (excluded(path)) continue;
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const bytes = readFileSync(join(root, path));
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      faults.push(`${path}: not valid UTF-8`);
      continue;
    }
    if (text.includes("\uFFFD")) faults.push(`${path}: contains a replacement character`);
    faults.push(...scanText(text, path));
  }
  return faults;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const faults = scanLanguage(process.cwd());
  if (faults.length) {
    console.error(faults.join("\n"));
    console.error(`\n${faults.length} language fault(s).`);
    process.exit(1);
  }
  console.log("Language scan: English and Arabic only, no fault outside the allowlist.");
}
