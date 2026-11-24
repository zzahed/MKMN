// Dev-only entry for the in-app browser preview and screenshots: installs the
// browser stand-in bridge (mock.ts) BEFORE App's first render, then mounts the
// same App component the production entry mounts. The production entry
// (index.html → main.tsx) is untouched and must never import the mock
// (tests/mkmn.test.ts guards that). An external file, not an inline script,
// so the preview page runs under the same CSP as the app.
import { installMockIfNeeded } from "./mock";
installMockIfNeeded();
const [{ App }, { ErrorBoundary }, React, { createRoot }] = await Promise.all([
  import("./App"),
  import("./ErrorBoundary"),
  import("react"),
  import("react-dom/client"),
]);
await import("./styles.css");
await import("./motion.css");
await import("./composer.css");
await import("./polish.css");
await import("./strata.css");
createRoot(document.getElementById("root")!).render(
  React.createElement(ErrorBoundary, null, React.createElement(App)),
);
