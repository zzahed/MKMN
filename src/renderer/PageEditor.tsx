import { useEffect, useMemo, useState } from "react";
import { legacySideBarPlugin, Puck, type Data, type Viewports } from "@puckeditor/core";
import "@puckeditor/core/no-external.css";
import { fromPuckData, toPuckData, type PageSpec } from "../core/page/catalog";
import { pageConfig } from "../core/page/blocks";
import { pageToHtml } from "../core/page/html";
import { isLoaded as iconsLoaded, loadIcons } from "../core/page/iconTable";

const plugins = [legacySideBarPlugin()];
const viewports: Viewports = [
  { width: 360, height: "auto", icon: "Smartphone", label: "Small" },
  { width: 768, height: "auto", icon: "Tablet", label: "Medium" },
  { width: 1280, height: "auto", icon: "Monitor", label: "Large" },
];

/**
 * The visual editor of a page made from blocks (Puck, MIT): drag blocks, change their fields, add or remove sections, with the
 * page drawn live. The page is the same description the model wrote, so what is saved here can be changed by the model again.
 */
export default function PageEditor({ spec, onSave, onClose }: { spec: PageSpec; onSave: (html: string) => void; onClose: () => void }) {
  // the blocks draw their icons from the Lucide table, which lands out of the startup
  // bundle: the editor waits for it before its first draw (the same muted note the lazy
  // editor's frame shows), else the icons are missing and nothing redraws them
  const [iconsReady, setIconsReady] = useState(iconsLoaded());
  useEffect(() => {
    if (iconsReady) return;
    let off = false;
    void loadIcons().then(() => { if (!off) setIconsReady(true); });
    return () => { off = true; };
  }, [iconsReady]);
  const config = useMemo(() => pageConfig(spec), [spec]);
  const data = useMemo(() => toPuckData(spec) as unknown as Data, [spec]);
  if (!iconsReady) {
    return <div className="page-editor muted" style={{ display: "grid", placeItems: "center" }} role="dialog" aria-label="Edit the page's blocks">Loading the editor…</div>;
  }
  return (
    <div className="page-editor" role="dialog" aria-label="Edit the page's blocks">
      <Puck
        config={config}
        data={data}
        plugins={plugins}
        viewports={viewports}
        dnd={{ behavior: "fluid", disableOutlineDrag: true }}
        headerTitle={spec.title || "Page"}
        headerPath="blocks"
        onPublish={async (d) => {
          await loadIcons();
          onSave(pageToHtml({ ...fromPuckData(d as never), nav: spec.nav, current: spec.current }));
          onClose();
        }}
        overrides={{ headerActions: ({ children }) => <><button type="button" className="linkbtn" onClick={onClose}>Cancel</button>{children}</> }}
      />
    </div>
  );
}
