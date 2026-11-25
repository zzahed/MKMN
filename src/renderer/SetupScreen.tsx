import type { SetupState } from "../core/setupView";
import { setupOutcomeView } from "../core/setupView";
import { api } from "./api";
import { LogoMark } from "./Icons";
import { BRAND } from "./brand";

function StepMark({ state }: { state: SetupState["steps"][number]["state"] }) {
  const p = { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
  if (state === "done") return <svg {...p} className="mark-check"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} /></svg>;
  if (state === "running") return <svg {...p} className="mark-spin"><path d="M12 4a8 8 0 1 0 8 8" /></svg>;
  if (state === "error") return <svg {...p}><path d="M12 6v7M12 17.5v.5" /></svg>;
  if (state === "skipped") return <svg {...p}><path d="M7 12h10" /></svg>;
  return <svg {...p} className="mark-idle"><circle cx="12" cy="12" r="6" /></svg>;
}

/** First-launch screen: installs what the app needs, shows progress, never traps the user. */
export function SetupScreen({ state }: { state: SetupState }) {
  const pending = state.steps.filter((s) => s.state === "pending");
  // Copy always follows the real outcome (confirm / busy / failed / skipped / ready).
  const view = setupOutcomeView(state);
  return (
    <div className="setup">
      <div className="setup-card">
        <LogoMark className="logo-mark" />
        <h1>{view.heading}</h1>
        <p className="muted">{view.description}</p>
        {state.awaitingConfirm && (
          <p className="muted small">
            {BRAND.downloadNote}
          </p>
        )}
        <div className="steps">
          {state.steps.map((s, i) => (
            <div key={s.id} className={`step ${s.state}`} style={{ ["--i" as string]: i }}>
              <div className="step-icon"><StepMark key={s.state} state={s.state} /></div>
              <div className="grow">
                <div><strong>{s.label}</strong></div>
                <div className="muted small">{s.state === "running" ? s.message : s.state === "error" ? "" : s.state === "done" || s.state === "skipped" ? s.message : s.detail}</div>
                {(s.state === "pending" || s.state === "error" || s.state === "skipped") && (
                  <div className="small setup-why">
                    <span>For: {s.enables}{s.sizeMB ? ` · about ${s.sizeMB} MB` : ""}</span>
                    <span className="muted">{s.withoutIt}</span>
                  </div>
                )}
                {s.state === "running" && <div className="track smooth active"><div className={`fill ${s.percent === null ? "indet" : ""}`} style={{ ["--p" as string]: (s.percent ?? 40) / 100 }} /></div>}
                {s.error && <div className="error-box">{s.error}</div>}
              </div>
              <div className="step-actions">
                {s.state === "error" && <button className="primary" onClick={() => void api().setupRetry(s.id)}>Try again</button>}
                {s.state === "error" && s.unsigned && <button className="ghost" title={`Runs this exact file even though its maker did not sign it. Only do this if you trust where it came from. (SHA-256 ${s.unsigned})`} onClick={() => void api().setupRunUnsigned(s.id)}>Run it anyway</button>}
                {(s.state === "pending" || s.state === "error") && !state.awaitingConfirm && <button className="ghost" onClick={() => void api().setupSkip(s.id)}>Skip</button>}
              </div>
            </div>
          ))}
        </div>
        {state.awaitingConfirm && (
          <div className="row">
            <button className="primary" onClick={() => void api().setupConfirm()}>Install {pending.length === 1 ? "it" : `all ${pending.length}`}</button>
            <button className="ghost" onClick={() => void api().setupDecline()}>Skip local setup</button>
          </div>
        )}
        {!state.awaitingConfirm && view.outcome !== "busy" && <button className="primary" onClick={() => void api().setupDismiss()}>{view.outcome === "failed" ? "Continue anyway" : "Start"}</button>}
        <div className="muted small">For cloud chat, skip local setup and choose HUMAIN Fuse or HUMAIN Node under Cloud Intelligence in Settings.</div>
        <div className="muted small">You can change or reinstall any of this later in Settings.</div>
        <div className="muted small brand-tagline">{BRAND.tagline}</div>
        <div className="muted small brand-supporting">{BRAND.supporting}</div>
      </div>
    </div>
  );
}
