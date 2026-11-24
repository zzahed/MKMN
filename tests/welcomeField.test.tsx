// @vitest-environment jsdom
// The welcome's decorative field is clipped by a layer of its own, never by the welcome: the composer's menus open inside the
// welcome, and a welcome that clips cut off their top rows and right-hand controls in a narrow column (the file pane open).
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { WelcomeField } from "../src/renderer/WelcomeField";

afterEach(cleanup);

const css = readFileSync(join(__dirname, "..", "src", "renderer", "strata.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the rules whose selector is exactly `selector`. */
const rulesFor = (selector: string) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(",").map((s) => s.trim()).includes(selector)).map((m) => m[2]);

describe("the welcome's decorative field", () => {
  it("is drawn in its own layer of the welcome, not inside the logo mark", () => {
    const { container } = render(<div className="welcome"><WelcomeField /><div className="greet"><span className="greet-mark" /></div></div>);
    const layer = container.querySelector(".welcome > .welcome-field")!;
    expect(layer.querySelector(".reservoir-field")).toBeTruthy();
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".greet-mark .reservoir-field")).toBeNull();
    // centred on the mark: the layer is told where the mark sits
    expect((layer as HTMLElement).style.getPropertyValue("--field-x")).toMatch(/^-?\d+px$/);
    expect((layer as HTMLElement).style.getPropertyValue("--field-y")).toMatch(/^-?\d+px$/);
  });
  it("is clipped by its layer, and the welcome itself never clips", () => {
    const welcome = rulesFor(".welcome");
    expect(welcome.length).toBeGreaterThan(0);
    for (const r of welcome) expect(r).not.toMatch(/overflow\s*:\s*(hidden|clip)/);
    expect(rulesFor(".welcome > div.welcome-field").join(";")).toMatch(/overflow\s*:\s*hidden/);
  });
});
