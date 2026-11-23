import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { LogoMark } from "./Icons";
import { setupTauriBridge } from "./tauriBridge";
import "./styles.css";
import "./motion.css";
import "./composer.css";
import "./polish.css";

// Attempt to wire Tauri v2 API bridge if running in WebView2/Tauri
setupTauriBridge();

function UnsupportedHost() {
  return <main className="runtime-required">
    <div className="runtime-card">
      <LogoMark className="runtime-logo" />
      <p className="runtime-kicker">MKMN AI · PRIVATE DESKTOP ASSISTANT</p>
      <h1>Windows desktop runtime required</h1>
      <p className="muted">MKMN AI runs as a Windows app. Open the installed app to reach your local models and saved work.</p>
      <div className="runtime-instructions">
        <strong>For developers: run it from source</strong>
        <code>pnpm --ignore-workspace install --frozen-lockfile</code>
        <code>pnpm start</code>
      </div>
    </div>
  </main>;
}

const root = createRoot(document.getElementById("root")!);
root.render("mkmn" in window && window.mkmn
  ? <ErrorBoundary><App /></ErrorBoundary>
  : <UnsupportedHost />);
