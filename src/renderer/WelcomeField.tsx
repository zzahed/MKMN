import { useLayoutEffect, useRef } from "react";
import { ReservoirField } from "./Icons";

/**
 * The welcome's decorative field, in a layer of its own that fills the welcome and clips only itself. The welcome cannot clip:
 * the composer's menus open inside it, and in a narrow column (the file pane open) a menu wider or taller than what is left
 * of the column would lose its right-hand controls or its top rows. The field stays centred on the logo mark: the layer reads
 * where the mark sits in the welcome, and again whenever the welcome changes size.
 */
export function WelcomeField() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = ref.current, home = layer?.parentElement;
    if (!layer || !home) return;
    const place = () => {
      const mark = home.querySelector(".greet-mark");
      if (!mark) return;
      const a = home.getBoundingClientRect(), b = mark.getBoundingClientRect();
      layer.style.setProperty("--field-x", `${Math.round(b.left - a.left + b.width / 2)}px`);
      layer.style.setProperty("--field-y", `${Math.round(b.top - a.top + b.height / 2)}px`);
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(place);
    watch.observe(home);
    return () => watch.disconnect();
  }, []);
  return <div ref={ref} className="welcome-field" aria-hidden="true"><ReservoirField /></div>;
}
