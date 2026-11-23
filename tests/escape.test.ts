import { describe, expect, it } from "vitest";
import { escapeRe, mdCell, scriptJson, stripActive } from "../src/core/escape";
import { parseSheets, setCell } from "../src/core/sheet";
import { takeParts } from "../src/core/slidePicks";
import { parseModelInput } from "../src/core/source";

describe("escape", () => {
  it("escapeRe matches the text literally, backslash included", () => {
    for (const s of ["a$b", "a\\b", "x.y*", "(z)|[w]"]) expect(new RegExp(`^${escapeRe(s)}$`).test(s)).toBe(true);
  });

  it("mdCell keeps a trailing backslash from escaping the border", () => {
    expect(mdCell("a\\")).toBe("a\\\\");
    expect(mdCell("a|b")).toBe("a\\|b");
  });

  it("a sheet cell with a backslash or a pipe survives the text form", () => {
    const src = "## S\n| A | B |\n|---|---|\n| 1 | 2 |";
    const out = setCell(src, 0, 1, 0, "C:\\dir\\");
    expect(parseSheets(setCell(out, 0, 1, 1, "x|y"))[0].rows[1]).toEqual(["C:\\dir\\", "x|y"]);
  });

  it("scriptJson cannot close a script element", () => {
    const s = scriptJson({ k: "</script><img src=x onerror=alert(1)>" });
    expect(s).not.toMatch(/<\/script/i);
    expect(JSON.parse(s)).toEqual({ k: "</script><img src=x onerror=alert(1)>" });
  });

  it("stripActive removes scripts and handlers, also when nested to reassemble", () => {
    const out = stripActive(`<svg><scr<script></script>ipt>alert(1)</script><rect onclick="x" /><g/onload=y></g></svg>`);
    expect(out).not.toMatch(/<script|onclick|onload/i);
    expect(stripActive(`<svg><script>a</script foo><rect/></svg>`)).toBe("<svg><rect/></svg>");
  });
});

describe("hardened parsers", () => {
  it("takeParts reads the note and stays fast on a hostile message", () => {
    const note = `[The user pointed at these parts of "a.html" in the preview:\n1. Title | {"part":"x"}\n]\n\nmake it red`;
    expect(takeParts(note).parts).toHaveLength(1);
    const t = Date.now();
    takeParts(`[The user pointed at these parts of ""\n9. ${" | {}0. ".repeat(5000)}`);
    takeParts(`[The user pointed at these parts of ""\n9. ${" | { | {}}\n9. ".repeat(40)}`);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("only Qualcomm's own host is read as AI Hub", () => {
    expect(parseModelInput("https://evilaihub.qualcomm.com.example/x").note ?? "").not.toMatch(/Qualcomm/);
    expect(parseModelInput("https://evilaihub.qualcomm.com/models/x").note ?? "").not.toMatch(/Qualcomm/);
    expect(parseModelInput("https://aihub.qualcomm.com/models/whisper_tiny").note ?? "").toMatch(/Qualcomm/);
  });
});
