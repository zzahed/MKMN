import { FigureProgress } from "./FigureProgress";
import { Fragment, memo, createContext, useContext, useMemo, useState } from "react";
import { Code, LiveCode } from "./Code";
import { ChartBlock } from "./ChartBlock";
import { DiagramBlock } from "./DiagramBlock";
import { CardsBlock, ChecklistBlock, KpiBlock, QuizBlock, SheetBlock } from "./Figures";
import { Foldable } from "./Foldable";
import { Tex } from "./Tex";
import { parseChartSpec } from "../core/chart";
import { diagramKind } from "../core/diagram";
import { MAX_IMAGES_SHOWN } from "../core/wikimedia";
import { parseMarkdown, type Block, type Inline } from "../core/markdown";

/** Words as separate nodes (keyed by position), so a word that has just arrived fades in and the ones before it stay still. */
function Words({ v }: { v: string }) {
  return <>{v.split(/(\s+)/).map((w, i) => (i % 2 || !w ? w : <span key={i} className="w">{w}</span>))}</>;
}

/** What each source number of a message names ("report.pdf (p. 150)") — read from the message's own Sources line. */
const SourcesContext = createContext<Map<number, string>>(new Map());

/** A citation marker as a chip; clicking it names the section it stands for (the viewer that opens the file at its place comes with the knowledge screen). */
function CiteChip({ n }: { n: number }) {
  const sources = useContext(SourcesContext);
  const [open, setOpen] = useState(false);
  const what = sources.get(n);
  return (
    <span className="cite-wrap">
      <button type="button" className="cite-chip" onClick={() => setOpen(!open)} aria-label={`Source ${n}${what ? `: ${what}` : ""}`}>{n}</button>
      {open && <span className="cite-pop" role="note">{what ? `Source ${n} — ${what}` : `Source ${n}`}</span>}
    </span>
  );
}

const SOURCE_SPLIT = /(\[source \d+\])/;

/** The app's Sources line ("Sources: [1] file (p. 3), …") as the chips' map, with the line cut off the body: it renders as its own row, not a paragraph. */
function splitSources(text: string): { body: string; sources: Map<number, string> } {
  const lines = text.split("\n");
  let at = lines.length - 1;
  while (at >= 0 && !lines[at].trim()) at--;
  const m = at >= 0 ? lines[at].trim().match(/^Sources: (.+)$/) : null;
  if (!m) return { body: text, sources: new Map() };
  const sources = new Map<number, string>();
  for (const item of m[1].split(/, (?=\[\d+\] )/)) {
    const s = item.match(/^\[(\d+)\] (.+)$/);
    if (s) sources.set(Number(s[1]), s[2]);
  }
  lines.length = at; // the Sources line and the blank line before it leave the body
  return { body: lines.join("\n").trimEnd(), sources };
}

function Inlines({ nodes, fade }: { nodes: Inline[]; fade?: boolean }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            if (!/\[source \d+\]/.test(n.v)) return fade ? <Words key={i} v={n.v} /> : <Fragment key={i}>{n.v}</Fragment>;
            return (
              <Fragment key={i}>
                {n.v.split(SOURCE_SPLIT).map((part, j) => {
                  const m = part.match(/^\[source (\d+)\]$/);
                  return m ? <CiteChip key={j} n={Number(m[1])} /> : part;
                })}
              </Fragment>
            );
          case "code": return <code key={i} className="inline-code">{n.v}</code>;
          case "math": return <Tex key={i} v={n.v} />;
          case "bold": return <strong key={i}><Inlines nodes={n.c} fade={fade} /></strong>;
          case "em": return <em key={i}><Inlines nodes={n.c} fade={fade} /></em>;
          case "link": return <a key={i} href={n.href} target="_blank" rel="noreferrer"><Inlines nodes={n.c} fade={fade} /></a>;
        }
      })}
    </>
  );
}

function CodeBlock({ lang, v, open }: { lang: string; v: string; open: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`codeblock ${open ? "writing" : ""}`}>
      <div className="codehead">
        <span>{lang || "code"}</span>
        <button className="linkbtn" onClick={async () => { try { await navigator.clipboard.writeText(v); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ } }}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code>{open ? <><LiveCode text={v} /><span className="caret-block" /></> : <Code text={v} lang={lang} />}</code></pre>
    </div>
  );
}

function chartTitle(raw: string): string {
  const spec = parseChartSpec(raw);
  return typeof spec === "string" ? "" : spec.title;
}

function BlockView({ b, fade, over }: { b: Block; sig: string; fade: boolean; over?: boolean }) {
  switch (b.t) {
    case "p": return <p><Inlines nodes={b.c} fade={fade} /></p>;
    case "h": { const H = (`h${Math.min(6, b.level + 1)}`) as "h2"; return <H className="md-h"><Inlines nodes={b.c} fade={fade} /></H>; }
    case "image": return over ? <p className="muted small">More pictures than shown: {b.alt || b.file} (Wikimedia Commons, {b.file})</p> : <Foldable title={b.alt || b.file.replace(/^File:/i, "")} kind="Picture"><p className="muted small">{b.alt || b.file}</p></Foldable>;
    case "code": {
      const lang = b.lang.toLowerCase();
      if (lang === "chart") return <Foldable title={(!b.open && chartTitle(b.v)) || "Chart"} kind="Chart" disabled={b.open}><ChartBlock raw={b.v} live={b.open && fade} /></Foldable>;
      if (lang === "mermaid" || lang === "diagram") {
        const kind = diagramKind(b.v);
        const name = kind ? kind.replace(/-v2|-beta/, "").replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim() : "Diagram";
        return <Foldable title={name} kind="Diagram" disabled={b.open}><DiagramBlock raw={b.v} live={b.open} /></Foldable>;
      }
      if (lang === "kpi" || lang === "figures") return b.open ? <div className="chart-block"><FigureProgress kind="figures" /></div> : <Foldable title="Key figures" kind="Figures"><KpiBlock raw={b.v} /></Foldable>;
      if (lang === "cards" || lang === "flashcards") return b.open ? <div className="chart-block"><FigureProgress kind="cards" /></div> : <Foldable title="Cards" kind="Cards"><CardsBlock raw={b.v} /></Foldable>;
      if (lang === "quiz" || lang === "qcm" || lang === "mcq") return b.open ? <div className="chart-block"><FigureProgress kind="quiz" /></div> : <Foldable title="Quiz" kind="Quiz"><QuizBlock raw={b.v} /></Foldable>;
      if (lang === "checklist" || lang === "todo") return b.open ? <div className="chart-block"><FigureProgress kind="checklist" /></div> : <Foldable title="Checklist" kind="Checklist"><ChecklistBlock raw={b.v} /></Foldable>;
      if (lang === "sheet" || lang === "spreadsheet") return b.open ? <div className="chart-block"><FigureProgress kind="sheet" /></div> : <Foldable title="Sheet" kind="Sheet"><SheetBlock raw={b.v} /></Foldable>;
      return <CodeBlock lang={b.lang} v={b.v} open={b.open && fade} />;
    }
    case "table": return (
      <div className="md-table"><table>
        <thead><tr>{b.head.map((h, k) => <th key={k} style={{ textAlign: ({ l: "left", r: "right", c: "center" } as const)[b.align[k] ?? "l"] }}><Inlines nodes={h} /></th>)}</tr></thead>
        <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} style={{ textAlign: ({ l: "left", r: "right", c: "center" } as const)[b.align[k] ?? "l"] }}><Inlines nodes={c} /></td>)}</tr>)}</tbody>
      </table></div>
    );
    case "ul": return <ul>{b.items.map((it, i) => <li key={i}><Inlines nodes={it} fade={fade && i === b.items.length - 1} /></li>)}</ul>;
    case "ol": return <ol>{b.items.map((it, i) => <li key={i}><Inlines nodes={it} fade={fade && i === b.items.length - 1} /></li>)}</ol>;
    case "quote": return <blockquote><Inlines nodes={b.c} fade={fade} /></blockquote>;
    case "math": return <Tex v={b.v} display />;
    case "hr": return <hr />;
  }
}

/** Blocks that did not change are not rendered again: while an answer streams only its last block does any work. */
const Memo = memo(BlockView, (a, b) => a.sig === b.sig && a.fade === b.fade && a.over === b.over);

/** FNV-style rolling hash over a string, without building a big string on the way. */
function hashMore(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

function hashInline(h: number, n: Inline): number {
  h = hashMore(h, n.t);
  if (n.t === "text" || n.t === "code" || n.t === "math") return hashMore(h, n.v);
  if (n.t === "link") { h = hashMore(h, n.href); for (const c of n.c) h = hashInline(h, c); return h; }
  for (const c of n.c) h = hashInline(h, c); // bold, em
  return h;
}

/**
 * A cheap signature of a block's own content: its kind plus a rolling hash of the text
 * it carries. Same blocks give the same signature, a block whose content changed gives
 * a different one — the equality meaning of the old memo key (JSON.stringify of the
 * whole block) without paying O(the whole answer) per block on every animation frame.
 */
export function blockSignature(b: Block): string {
  let h = 0x811c9dc5;
  h = hashMore(h, b.t);
  switch (b.t) {
    case "p": case "quote": for (const n of b.c) h = hashInline(h, n); break;
    case "h": h = hashMore(h, String(b.level)); for (const n of b.c) h = hashInline(h, n); break;
    case "code": h = hashMore(h, b.lang); h = hashMore(h, b.v); h = (Math.imul(h, 33) + (b.open ? 1 : 0)) | 0; break;
    case "image": h = hashMore(h, b.file); h = hashMore(h, b.alt ?? ""); break;
    case "table":
      for (const r of b.head) for (const n of r) h = hashInline(h, n);
      for (const row of b.rows) for (const c of row) for (const n of c) h = hashInline(h, n);
      for (const a of b.align) h = hashMore(h, a);
      break;
    case "ul": case "ol": for (const it of b.items) for (const n of it) h = hashInline(h, n); break;
    case "math": h = hashMore(h, b.v); break;
    case "hr": break;
  }
  return `${b.t}:${(h >>> 0).toString(36)}`;
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  // the parse (and the signatures) run once per distinct text, not on every animation
  // frame of the smooth reveal
  const { blocks, sigs, sources } = useMemo(() => {
    const { body, sources } = splitSources(text);
    const blocks = parseMarkdown(body);
    return { blocks, sigs: blocks.map(blockSignature), sources };
  }, [text]);
  // a model that asks for pictures must not fill an answer with them: only the first few are shown
  let seen = 0;
  return (
    <div className={`md ${streaming ? "streaming" : ""}`}>
      <SourcesContext.Provider value={sources}>
        {blocks.map((b, i) => <Memo key={i} b={b} sig={sigs[i]} fade={!!streaming && i === blocks.length - 1} over={b.t === "image" ? ++seen > MAX_IMAGES_SHOWN : undefined} />)}
        {sources.size > 0 && (
          <div className="sources-row">
            {[...sources.entries()].map(([n, what]) => <span key={n} className="source-item"><CiteChip n={n} /> {what}</span>)}
          </div>
        )}
      </SourcesContext.Provider>
    </div>
  );
}
