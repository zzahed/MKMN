// Spreadsheet side of Office files: cell addresses, the text form of a sheet (a table whose first line is row 1)
// and a formula evaluator, so the assistant can see the RESULT of a calculation and not only the formula.

import { mdCell } from "./escape";

export interface Sheet { name: string; rows: string[][] }
export type Value = number | string | boolean | null | SheetError;
export class SheetError { constructor(public code: string) {} toString() { return this.code; } }

export function colName(i: number): string { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }
export function colIndex(s: string): number { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
export const addr = (row: number, col: number) => `${colName(col)}${row + 1}`;
export function parseAddr(a: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(a.trim());
  return m ? { row: Number(m[2]) - 1, col: colIndex(m[1]) } : null;
}

const NUM = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
export const isNumeric = (s: string) => NUM.test(s.trim());
export const isFormula = (s: string) => s.startsWith("=") && s.length > 1;

// ---------------------------------------------------------------- text form

const escCell = (s: string) => mdCell(s).replace(/\r?\n/g, " ");
export const splitRow = (line: string): string[] => {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && (t[i + 1] === "|" || t[i + 1] === "\\")) { cur += t[i + 1]; i++; } else if (t[i] === "|") { out.push(cur.trim()); cur = ""; } else cur += t[i];
  }
  out.push(cur.trim());
  return out;
};

/** A number as people type it ("1 200,50 €", "3,5", "1,234.5") in the plain form a formula reads; any other text is left as it is. A percentage stays as written. */
export function plainNumber(cell: string): string {
  const s = cell.trim().replace(/[€$£]\s*$|^[€$£]\s*/g, "").replace(/[\u00a0\u202f ](?=\d{3}\b)/g, "");
  if (s === cell.trim() && !/,/.test(s)) return cell;
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, "");
  if (/^[-+]?\d+,\d+$/.test(s)) return s.replace(",", ".");
  return /^[-+]?\d+(\.\d+)?$/.test(s) && s !== cell.trim() ? s : cell;
}

/** "## Name" then a table; the first table line is row 1 and the first column is A. Without any "##", one sheet. */
export function parseSheets(src: string): Sheet[] {
  const sheets: Sheet[] = [];
  let cur: Sheet | null = null;
  for (const raw of src.replace(/\r/g, "").split("\n")) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(raw);
    if (h) { cur = { name: h[1].replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || `Sheet${sheets.length + 1}`, rows: [] }; sheets.push(cur); continue; }
    if (!raw.includes("|")) continue;
    const cells = splitRow(raw).map(plainNumber);
    if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // the markdown separator line
    if (!cur) { cur = { name: "Sheet1", rows: [] }; sheets.push(cur); }
    cur.rows.push(cells);
  }
  const kept = sheets.filter((s) => s.rows.length);
  for (const s of kept) s.rows = dropGridMarks(s.rows);
  for (const s of kept) nameRefs(s);
  return kept.filter((s) => s.rows.length);
}

export const plainLabel = (s: string) => s.replace(/\*\*|__|`/g, "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");

/**
 * Small models write the letters of the columns as a first row (A | B | C...) and the numbers of the rows as a first column, as if the sheet had to show them. The app draws both itself, so they are taken out:
 * only when the letters row is there, which is the sign (a column of 1, 2, 3 can be real data), and only when the first column then counts the rows. A letters row that never ends is cut with the rest.
 */
export function dropGridMarks(rows: string[][]): string[][] {
  const first = rows[0];
  if (!first || first.length < 3) return rows;
  const mark = (c: string) => /^\*{0,2}[A-Z]{1,2}\*{0,2}$/.test(c.trim());
  const rest = first.slice(1).filter((c) => c.trim() !== "");
  const lead = first[0].trim();
  if (rest.length < 2 || rest.filter((c) => mark(c)).length < rest.length * 0.8 || !(lead === "" || mark(lead) || /^#$/.test(lead))) return rows;
  let body = rows.slice(1);
  const counts = body.length >= 2 && body.every((r, i) => r[0]?.replace(/\*/g, "").trim() === String(i + 1) || (r[0] ?? "").trim() === "");
  if (counts && body.filter((r) => r[0]?.trim()).length >= Math.min(2, body.length)) body = body.map((r) => r.slice(1));
  return body.map((r) => { let n = r.length; while (n > 0 && r[n - 1].trim() === "") n--; return r.slice(0, Math.max(n, 1)); });
}

/**
 * A formula may name a row by its label instead of counting rows: =[Production cost]+[Transport] or =SUM([Production cost]:[Indirect costs]).
 * The name is the label of a row (first text cell of the line); it means the cell of that row in the column of the formula, or in the first column that holds a figure when the formula sits elsewhere.
 * `[Label@Header]` takes the column whose first-row header is Header. A name that matches no row is left as it is (the formula then shows #NAME?).
 */
export function nameRefs(sheet: Sheet): void {
  const labels = new Map<string, number>();
  sheet.rows.forEach((r, y) => { const c = r.find((x) => x.trim() && !isNumeric(x) && !isFormula(x)); if (c) { const k = plainLabel(c); if (!labels.has(k)) labels.set(k, y); } });
  if (!labels.size) return;
  const heads = (sheet.rows[0] ?? []).map(plainLabel);
  sheet.rows.forEach((r, y) => r.forEach((cell, x) => {
    if (!isFormula(cell) || !cell.includes("[")) return;
    sheet.rows[y][x] = cell.replace(/\[([^\][]+)\]/g, (all, inner: string) => {
      const [name, head] = inner.split("@");
      const row = labels.get(plainLabel(name));
      if (row === undefined) return all;
      let col = x;
      if (head !== undefined) { col = heads.indexOf(plainLabel(head)); if (col < 0) return all; }
      else if (!(sheet.rows[row][col] ?? "").trim() || col === sheet.rows[row].findIndex((c) => c.trim() && !isNumeric(c) && !isFormula(c))) col = sheet.rows[row].findIndex((c, i) => i > 0 && c.trim() && (isNumeric(c) || isFormula(c)));
      return col < 0 ? all : `${colName(col)}${row + 1}`;
    });
  }));
}

export function sheetsText(sheets: Sheet[]): string {
  return sheets.map((s) => {
    const width = Math.max(1, ...s.rows.map((r) => r.length));
    const lines = s.rows.map((r) => `| ${Array.from({ length: width }, (_, i) => escCell(r[i] ?? "")).join(" | ")} |`);
    lines.splice(1, 0, `|${Array(width).fill("---").join("|")}|`);
    return `## ${s.name}\n${lines.join("\n")}`;
  }).join("\n\n");
}

/**
 * One cell changed by the person: the sheet is read, the cell set (a row or a column past the end is added), and the workbook written again in the text form.
 * What starts with = stays a formula; the other cells keep what they hold.
 */
export function setCell(src: string, sheet: number, row: number, col: number, value: string): string {
  const sheets = parseSheets(src);
  const s = sheets[sheet];
  if (!s || row < 0 || col < 0 || row > 2000 || col > 200) return src;
  while (s.rows.length <= row) s.rows.push([]);
  const r = s.rows[row];
  while (r.length <= col) r.push("");
  r[col] = value.trim();
  while (s.rows.length > 1 && s.rows[s.rows.length - 1].every((c) => !c.trim())) s.rows.pop();
  return sheetsText(sheets);
}

// ---------------------------------------------------------------- formulas

type Tok = { t: "num" | "str" | "ref" | "name" | "op"; v: string };

function tokenize(f: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|"((?:[^"]|"")*)"|((?:'[^']+'|[A-Za-z_][\w.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)(?![\w(])|([A-Za-z_][\w.]*)|(<>|<=|>=|[-+*/^&=<>(),%:]))/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < f.length && (m = re.exec(f))) {
    at = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "str", v: m[2].replace(/""/g, '"') });
    else if (m[4] !== undefined) out.push({ t: "ref", v: `${m[3] ? m[3].slice(0, -1).replace(/^'|'$/g, "") : ""}!${m[4].replace(/\$/g, "")}` });
    else if (m[5] !== undefined) out.push({ t: "name", v: m[5] });
    else out.push({ t: "op", v: m[6] });
  }
  if (f.slice(at).trim()) throw new SheetError("#NAME?");
  return out;
}

const num = (v: Value): number => {
  if (v instanceof SheetError) throw v;
  if (v === null || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (isNumeric(v)) return Number(v);
  throw new SheetError("#VALUE!");
};
const str = (v: Value): string => (v instanceof SheetError ? (() => { throw v; })() : v === null ? "" : typeof v === "number" ? String(round(v)) : String(v));
const round = (n: number) => Math.round(n * 1e10) / 1e10;
const truthy = (v: Value) => (typeof v === "string" ? v.toUpperCase() === "TRUE" : !!num(v));

/** Evaluates one formula against a workbook. Cycles and unknown names give Excel's own error codes. */
export class Workbook {
  private cache = new Map<string, Value>();
  private busy = new Set<string>();
  constructor(public sheets: Sheet[]) {}

  sheet(name: string): Sheet | undefined { return name ? this.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase()) : this.sheets[0]; }

  /** The value of one cell: a number, text or an error. Formulas are calculated. */
  cell(sheetName: string, row: number, col: number): Value {
    const s = this.sheet(sheetName);
    if (!s) return new SheetError("#REF!");
    const raw = s.rows[row]?.[col] ?? "";
    if (!isFormula(raw)) return raw === "" ? null : isNumeric(raw) ? Number(raw) : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === "true" : raw;
    const key = `${s.name}!${row},${col}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    if (this.busy.has(key)) return new SheetError("#CIRC!");
    this.busy.add(key);
    let v: Value;
    try { v = this.run(raw.slice(1), s.name); } catch (e) { v = e instanceof SheetError ? e : new SheetError("#VALUE!"); }
    this.busy.delete(key);
    this.cache.set(key, v);
    return v;
  }

  /** Text of a value as the sheet would show it. */
  show(v: Value): string { return v instanceof SheetError ? v.code : v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? String(round(v)) : v; }

  /** One formula (without the =) as a value; an error becomes its Excel code. */
  formula(f: string, home: string): Value { try { return this.run(f, home); } catch (e) { return e instanceof SheetError ? e : new SheetError("#VALUE!"); } }

  private run(f: string, home: string): Value {
    const toks = tokenize(f);
    let i = 0;
    const peek = () => toks[i];
    const eat = (v?: string) => { const t = toks[i]; if (v && t?.v !== v) throw new SheetError("#NAME?"); i++; return t; };
    const range = (ref: string): Value[][] => {
      const [sn, r] = ref.split("!");
      const [a, b] = r.split(":");
      const p = parseAddr(a), q = parseAddr(b ?? a);
      if (!p || !q) throw new SheetError("#REF!");
      /* the range is read within the sheet it names: a whole-column range (A1:A1048576) must not build a million
       * cells of nothing, and a hostile file must not name a range the memory cannot hold */
      const s = this.sheet(sn || home);
      const rowsN = s ? s.rows.length : 0, width = s ? s.rows.reduce((n, row) => Math.max(n, row.length), 0) : 0;
      let y1 = Math.max(p.row, q.row), y0 = Math.min(p.row, q.row), x1 = Math.max(p.col, q.col), x0 = Math.min(p.col, q.col);
      if (s) { y1 = Math.min(y1, rowsN - 1); y0 = Math.min(y0, y1); x1 = Math.min(x1, Math.max(0, width - 1)); x0 = Math.min(x0, x1); }
      if ((y1 - y0 + 1) * (x1 - x0 + 1) > 1_000_000) throw new SheetError("#REF!");
      const rows: Value[][] = [];
      for (let y = y0; y <= y1; y++) {
        const line: Value[] = [];
        for (let x = x0; x <= x1; x++) line.push(this.cell(sn || home, y, x));
        rows.push(line);
      }
      return rows;
    };
    const flat = (args: (Value | Value[][])[]): Value[] => args.flatMap((a) => (Array.isArray(a) ? a.flat() : [a]));
    const nums = (args: (Value | Value[][])[]) => flat(args).filter((v) => { if (v instanceof SheetError) throw v; return typeof v === "number"; }) as number[];
    const crit = (c: Value): ((v: Value) => boolean) => {
      const s = str(c);
      const m = /^(<>|<=|>=|=|<|>)?(.*)$/.exec(s)!;
      const op = m[1] ?? "=", rhs = m[2];
      return (v) => {
        const nv = typeof v === "number" ? v : v !== null && isNumeric(String(v)) ? Number(v) : null;
        if (isNumeric(rhs) && nv !== null) { const r = Number(rhs); return op === "=" ? nv === r : op === "<>" ? nv !== r : op === "<" ? nv < r : op === ">" ? nv > r : op === "<=" ? nv <= r : nv >= r; }
        const a = this.show(v).toLowerCase(), b = rhs.toLowerCase();
        return op === "<>" ? a !== b : op === "=" ? a === b : false;
      };
    };
    const call = (name: string, args: (Value | Value[][])[]): Value => {
      const n = name.toUpperCase();
      const one = (k: number) => { const a = args[k]; return Array.isArray(a) ? a[0]?.[0] ?? null : a ?? null; };
      switch (n) {
        case "SUM": return nums(args).reduce((a, b) => a + b, 0);
        case "AVERAGE": case "AVG": { const v = nums(args); if (!v.length) throw new SheetError("#DIV/0!"); return v.reduce((a, b) => a + b, 0) / v.length; }
        case "MIN": { const v = nums(args); return v.length ? Math.min(...v) : 0; }
        case "MAX": { const v = nums(args); return v.length ? Math.max(...v) : 0; }
        case "COUNT": return nums(args).length;
        case "COUNTA": return flat(args).filter((v) => v !== null && v !== "").length;
        case "ROUND": return Math.round(num(one(0)) * 10 ** num(one(1) ?? 0)) / 10 ** num(one(1) ?? 0);
        case "PMT": { const r = num(one(0)), n = num(one(1)), pv = num(one(2)); if (!n) throw new SheetError("#NUM!"); return r === 0 ? -pv / n : (-pv * r) / (1 - (1 + r) ** -n); }
        case "SUMPRODUCT": { const cols = args.map((a) => flat([a])); const len = Math.min(...cols.map((c) => c.length)); let t = 0; for (let i = 0; i < len; i++) t += cols.reduce((m, c) => m * (typeof c[i] === "number" ? (c[i] as number) : 0), 1); return t; }
        case "ABS": return Math.abs(num(one(0)));
        case "SQRT": { const x = num(one(0)); if (x < 0) throw new SheetError("#NUM!"); return Math.sqrt(x); }
        case "POWER": return num(one(0)) ** num(one(1));
        case "MOD": { const d = num(one(1)); if (!d) throw new SheetError("#DIV/0!"); return ((num(one(0)) % d) + d) % d; }
        case "IF": return truthy(one(0)) ? (args.length > 1 ? one(1) : true) : args.length > 2 ? one(2) : false;
        case "IFERROR": return one(0) instanceof SheetError ? one(1) : one(0);
        case "AND": return flat(args).every(truthy);
        case "OR": return flat(args).some(truthy);
        case "NOT": return !truthy(one(0));
        case "LEN": return str(one(0)).length;
        case "UPPER": return str(one(0)).toUpperCase();
        case "LOWER": return str(one(0)).toLowerCase();
        case "CONCATENATE": case "CONCAT": return flat(args).map(str).join("");
        case "COUNTIF": { const t = crit(one(1)); return flat([args[0]]).filter(t).length; }
        case "SUMIF": { const t = crit(one(1)); const a = flat([args[0]]), b = args[2] ? flat([args[2]]) : a; return a.reduce<number>((s, v, k) => s + (t(v) && typeof b[k] === "number" ? (b[k] as number) : 0), 0); }
        default: throw new SheetError("#NAME?");
      }
    };
    type AstNode =
      | { t: "num"; v: number }
      | { t: "str"; v: string }
      | { t: "bool"; v: boolean }
      | { t: "ref"; v: string }
      | { t: "call"; fn: string; args: AstNode[] }
      | { t: "unary"; op: string; expr: AstNode }
      | { t: "pct"; expr: AstNode }
      | { t: "bin"; op: string; left: AstNode; right: AstNode };

    // AST parser
    const parseExpr = (): AstNode => {
      let l = parseConcat();
      while (peek() && ["=", "<>", "<", ">", "<=", ">="].includes(peek().v) && peek().t === "op") {
        const op = eat().v;
        const r = parseConcat();
        l = { t: "bin", op, left: l, right: r };
      }
      return l;
    };
    const parseConcat = (): AstNode => {
      let l = parseAdd();
      while (peek()?.v === "&" && peek().t === "op") {
        eat();
        l = { t: "bin", op: "&", left: l, right: parseAdd() };
      }
      return l;
    };
    const parseAdd = (): AstNode => {
      let l = parseMul();
      while (peek() && (peek().v === "+" || peek().v === "-") && peek().t === "op") {
        const op = eat().v;
        l = { t: "bin", op, left: l, right: parseMul() };
      }
      return l;
    };
    const parseMul = (): AstNode => {
      let l = parsePow();
      while (peek() && (peek().v === "*" || peek().v === "/") && peek().t === "op") {
        const op = eat().v;
        l = { t: "bin", op, left: l, right: parsePow() };
      }
      return l;
    };
    const parsePow = (): AstNode => {
      let l = parseUnary();
      while (peek()?.v === "^" && peek().t === "op") {
        eat();
        l = { t: "bin", op: "^", left: l, right: parseUnary() };
      }
      return l;
    };
    const parseUnary = (): AstNode => {
      if (peek()?.t === "op" && (peek().v === "-" || peek().v === "+")) {
        const op = eat().v;
        return { t: "unary", op, expr: parseUnary() };
      }
      let v = parsePrimary();
      while (peek()?.v === "%" && peek().t === "op") {
        eat();
        v = { t: "pct", expr: v };
      }
      return v;
    };
    const parsePrimary = (): AstNode => {
      const t = eat();
      if (!t) throw new SheetError("#VALUE!");
      if (t.t === "num") return { t: "num", v: Number(t.v) };
      if (t.t === "str") return { t: "str", v: t.v };
      if (t.t === "ref") return { t: "ref", v: t.v };
      if (t.t === "name") {
        if (/^(true|false)$/i.test(t.v) && peek()?.v !== "(") return { t: "bool", v: t.v.toLowerCase() === "true" };
        eat("(");
        const args: AstNode[] = [];
        if (peek()?.v !== ")") {
          for (;;) {
            args.push(parseExpr());
            if (peek()?.v === ",") { eat(); continue; }
            break;
          }
        }
        eat(")");
        return { t: "call", fn: t.v.toUpperCase(), args };
      }
      if (t.v === "(") {
        const v = parseExpr();
        eat(")");
        return v;
      }
      throw new SheetError("#VALUE!");
    };

    const ast = parseExpr();
    if (i < toks.length) throw new SheetError("#NAME?");

    // AST evaluator with short-circuiting for IF and IFERROR
    const scalar = (v: Value | Value[][]): Value => { const s = Array.isArray(v) ? v[0]?.[0] ?? null : v; if (s instanceof SheetError) throw s; return s; };
    const evalAst = (node: AstNode): Value | Value[][] => {
      switch (node.t) {
        case "num": return node.v;
        case "str": return node.v;
        case "bool": return node.v;
        case "ref": { const r = range(node.v); return node.v.includes(":") ? r : r[0][0]; }
        case "pct": return num(scalar(evalAst(node.expr))) / 100;
        case "unary": {
          const v = num(scalar(evalAst(node.expr)));
          return node.op === "-" ? -v : v;
        }
        case "bin": {
          if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
            const l = evalAst(node.left), r = evalAst(node.right);
            let a = scalar(l), b = scalar(r);
            if (a === null && typeof b === "number") a = 0; else if (b === null && typeof a === "number") b = 0;
            const x = typeof a === "number" && typeof b === "number" ? a : this.show(a).toLowerCase();
            const y = typeof a === "number" && typeof b === "number" ? b : this.show(b).toLowerCase();
            return node.op === "=" ? x === y : node.op === "<>" ? x !== y : node.op === "<" ? x < y : node.op === ">" ? x > y : node.op === "<=" ? x <= y : x >= y;
          }
          if (node.op === "&") return str(scalar(evalAst(node.left))) + str(scalar(evalAst(node.right)));
          if (node.op === "+") return num(scalar(evalAst(node.left))) + num(scalar(evalAst(node.right)));
          if (node.op === "-") return num(scalar(evalAst(node.left))) - num(scalar(evalAst(node.right)));
          if (node.op === "*") return num(scalar(evalAst(node.left))) * num(scalar(evalAst(node.right)));
          if (node.op === "/") {
            const denom = num(scalar(evalAst(node.right)));
            if (denom === 0) throw new SheetError("#DIV/0!");
            return num(scalar(evalAst(node.left))) / denom;
          }
          if (node.op === "^") return num(scalar(evalAst(node.left))) ** num(scalar(evalAst(node.right)));
          throw new SheetError("#VALUE!");
        }
        case "call": {
          if (node.fn === "IF") {
            if (node.args.length === 0) throw new SheetError("#VALUE!");
            const cond = truthy(scalar(evalAst(node.args[0])));
            if (cond) return node.args.length > 1 ? evalAst(node.args[1]) : true;
            return node.args.length > 2 ? evalAst(node.args[2]) : false;
          }
          if (node.fn === "IFERROR") {
            if (node.args.length === 0) throw new SheetError("#VALUE!");
            try {
              const res = evalAst(node.args[0]);
              if (res instanceof SheetError) {
                return node.args.length > 1 ? evalAst(node.args[1]) : "";
              }
              return res;
            } catch (e) {
              if (e instanceof SheetError) {
                return node.args.length > 1 ? evalAst(node.args[1]) : "";
              }
              throw e;
            }
          }
          const evaluatedArgs = node.args.map((arg) => {
            try {
              return evalAst(arg);
            } catch (e) {
              if (e instanceof SheetError) return e;
              throw e;
            }
          });
          return call(node.fn, evaluatedArgs);
        }
      }
    };

    const out = evalAst(ast);
    const v = scalar(out);
    return typeof v === "number" && !Number.isFinite(v) ? new SheetError("#NUM!") : v;
  }
}

/** Every formula cell with its calculated result, "D2 = 1250" per line, for the model to read. */
export function formulaResults(sheets: Sheet[], limit = 400): string {
  const wb = new Workbook(sheets);
  const lines: string[] = [];
  for (const s of sheets) s.rows.forEach((r, y) => r.forEach((c, x) => { if (isFormula(c) && lines.length < limit) lines.push(`${sheets.length > 1 ? `${s.name}!` : ""}${addr(y, x)} ${c} = ${wb.show(wb.cell(s.name, y, x)) || "(empty)"}`); }));
  return lines.join("\n");
}
