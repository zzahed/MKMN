import { useEffect, useState } from "react";
import type { Settings } from "../shared/types";
import { Skills } from "./Skills";
import { FILL_TO_UNFOLD, INSTRUCTION_LIMITS, instructionTiers } from "../core/instructions";

type Keys = "customInstructions" | "customInstructions2" | "customInstructions3";
const KEYS: Keys[] = ["customInstructions", "customInstructions2", "customInstructions3"];
const TITLES = [
  "Essentials",
  "More details",
  "Everything else"
];
const HINTS = [
  "Always read, whatever the model and setting. Put what matters most: your name, your language, how you like answers.",
  "Read when the conversation length is Long (about 6,000 words) or more. Preferences that help but are not vital.",
  "Read only when the model is set up for very long conversations (about 12,000 words or more). Background, habits, and examples of answers you liked."
];
const PLACEHOLDERS = [
  "I'm Fabien, a developer on Windows. Reply in Arabic unless I write in English. Be concise.",
  "I like code before explanations. Use metric units. When unsure, ask one short question.",
  "Background about my work, the tools I use, the tone I like, examples of answers I found good."
];

/** Whether the model in use receives part i of the personal instructions, said on that part. */
export function partNote(i: number, model: { name: string; contextTokens: number } | null): { included: boolean; text: string } | null {
  if (!model) return null;
  const included = i < instructionTiers(model.contextTokens);
  return { included, text: included ? `Read by your current model (${model.name})` : `Not read by your current model (${model.name}): it is set up for shorter conversations` };
}

export function Customize({ settings, onSave, onOpenDocs, model = null }: { settings: Settings; onSave: (patch: Partial<Settings>) => Promise<void>; onOpenDocs: () => void; model?: { name: string; contextTokens: number } | null }) {
  const [tab, setTab] = useState<"instructions" | "skills">("skills");
  const [texts, setTexts] = useState<string[]>(() => KEYS.map((k) => settings[k] ?? ""));
  const [saved, setSaved] = useState(true);
  // a part opens by hand, or by itself when the one before it is nearly full
  const [opened, setOpened] = useState<boolean[]>(() => KEYS.map((k, i) => i === 0 || !!(settings[k] ?? "").trim()));
  const saved0 = KEYS.map((k) => settings[k] ?? "");
  const changed = texts.some((t, i) => t !== saved0[i]);
  useEffect(() => {
    if (!changed) return;
    setSaved(false);
    onSave(Object.fromEntries(KEYS.map((k, i) => [k, texts[i]]))).then(() => setSaved(true));
    return () => {
      setSaved(false);
      onSave(Object.fromEntries(KEYS.map((k, i) => [k, texts[i]]))).then(() => setSaved(true));
    };
  }, [texts]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i: number, v: string) => {
    const next = texts.slice(); next[i] = v.slice(0, INSTRUCTION_LIMITS[i]); setTexts(next);
    if (i < 2 && next[i].length >= INSTRUCTION_LIMITS[i] * FILL_TO_UNFOLD && !opened[i + 1]) setOpened(opened.map((o, k) => o || k === i + 1));
  };
  const tabs = (
    <div className="seg" role="tablist">
      <button role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "on" : ""} onClick={() => setTab("skills")}>Skills</button>
      <button role="tab" aria-selected={tab === "instructions"} className={tab === "instructions" ? "on" : ""} onClick={() => setTab("instructions")}>About me</button>
    </div>
  );
  return (
    <div className="page" style={{ maxWidth: tab === "skills" ? 1180 : 780 }}>
      <h1>{tab === "skills" ? "Skills" : "About me"}</h1>
      {tab === "skills" ? <Skills settings={settings} onSave={onSave} onOpenDocs={onOpenDocs} tabs={tabs} /> : <>
      <div style={{ margin: "8px 0 14px" }}>{tabs}</div>
      <p className="muted">Instructions the assistant follows in every chat and scheduled task, in all projects. Part 1 is always read, so put what matters most there. Parts 2 and 3 are read only when the model is set up for longer conversations (Settings › Speed & memory › Advanced).</p>
      {KEYS.map((_k, i) => (
        <section key={i}>
          <h2>
            {i === 0 ? <>{i + 1}. {TITLES[i]}</> : (
              <button type="button" className="section-toggle" aria-expanded={opened[i]} onClick={() => setOpened(opened.map((o, k) => (k === i ? !o : o)))}>
                <span className="muted" aria-hidden="true">{opened[i] ? "▾ " : "▸ "}</span>{i + 1}. {TITLES[i]}
                {!opened[i] && <span className="muted small"> · {INSTRUCTION_LIMITS[i]} characters</span>}
              </button>
            )}
          </h2>
          {(() => { const n = partNote(i, model); return n ? <div className={`small ${n.included ? "ok" : "muted"}`}>{n.text}</div> : null; })()}
          {opened[i] && (
            <>
              <p className="muted small">{HINTS[i]}</p>
              <textarea className="instr-box" rows={i === 0 ? 6 : 8} maxLength={INSTRUCTION_LIMITS[i]} value={texts[i]} onChange={(e) => set(i, e.target.value)} placeholder={PLACEHOLDERS[i]} aria-label={`About me, part ${i + 1}: ${TITLES[i]}`} />
              <div className="muted small" style={{ marginTop: 6 }}>{texts[i].length} of {INSTRUCTION_LIMITS[i]} characters</div>
            </>
          )}
        </section>
      ))}
      <div className="muted small">{saved ? "Saved" : "Saving…"}</div>
      </>}
    </div>
  );
}
