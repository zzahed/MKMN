import { describe, it, expect } from "vitest";
import { siteFileName, siteEntry, siteFiles, siteOpenRefusal } from "../src/core/site";
import { isWindows } from "./helpers/platform";

const f = (title: string, kind: string, language: string, content = "x") => ({ title, kind, language, content });

describe("a page is always written with an .html name", () => {
  it("drops an extension the system would run as a program", () => {
    for (const title of ["app.hta", "run.cmd", "x.js", "tool.vbs", "a.bat", "b.ps1", "c.lnk", "d.exe", "e.scr"]) {
      expect(siteFileName(f(title, "html", "html")).endsWith(".html")).toBe(true);
    }
  });

  it("keeps .html and .htm titles as they are", () => {
    expect(siteFileName(f("index.html", "html", "html"))).toBe("index.html");
    expect(siteFileName(f("index.htm", "html", "html"))).toBe("index.htm");
  });

  it("keeps a web asset's own extension and drops any other", () => {
    expect(siteFileName(f("style.css", "code", "css"))).toBe("style.css");
    expect(siteFileName(f("data.json", "code", "json"))).toBe("data.json");
    expect(siteFileName(f("evil.exe", "code", "css")).endsWith(".exe")).toBe(false);
    expect(siteFileName(f("evil.exe", "code", "css")).endsWith(".css")).toBe(true);
  });

  it("keeps a traversal title inside the folder", () => {
    expect(siteFileName(f("../../x.html", "html", "html"))).toBe("x.html");
    expect(siteFileName(f("C:\\x.html", "html", "html"))).toBe("x.html");
  });

  it("still names the entry page under its written name", () => {
    const files = [f("app.hta", "html", "html", "<p>a</p>"), f("index.html", "html", "html", "<p>home</p>")];
    expect(siteEntry(files[0], files)).toBe("app.html");
    expect(siteEntry(files[1], files)).toBe("index.html");
  });
});

describe("links between pages survive a renamed file", () => {
  it("rewrites a link that points at a page written under another name", () => {
    const files = [
      f("index.html", "html", "html", '<nav><a href="about.hta">about</a></nav>'),
      f("about.hta", "html", "html", "<p>about</p>"),
    ];
    const written = siteFiles(files);
    expect(written.map((x) => x.name)).toEqual(["index.html", "about.html"]);
    expect(written[0].content).toContain('href="about.html"');
    expect(written[0].content).not.toContain("about.hta");
  });

  it("keeps a link to a page whose name did not change", () => {
    const files = [
      f("index.html", "html", "html", '<nav><a href="game.html">game</a></nav>'),
      f("game.html", "html", "html", "<p>game</p>"),
    ];
    expect(siteFiles(files)[0].content).toContain('href="game.html"');
  });

  it("rewrites the entry the sidecar opens when the entry page was renamed", () => {
    const files = [
      f("index.html", "html", "html", '<link rel="stylesheet" href="style.css">'),
      f("style.css", "code", "css", "a{}"),
    ];
    const written = siteFiles(files);
    expect(written.map((x) => x.name)).toEqual(["index.html", "style.css"]);
    expect(written[0].content).toContain('href="style.css"');
  });
});

describe("what may be asked of the browser", () => {
  it("refuses a name with another extension or one that leaves the folder", () => {
    const dir = "C:\\temp\\site-1";
    expect(siteOpenRefusal("app.hta", dir)).toMatch(/HTML page/);
    expect(siteOpenRefusal("run.cmd", dir)).toMatch(/HTML page/);
    expect(siteOpenRefusal("x.js", dir)).toMatch(/HTML page/);
    expect(siteOpenRefusal("../other/index.html", dir)).toMatch(/HTML page/);
    expect(siteOpenRefusal("sub/index.html", dir)).toMatch(/HTML page/);
    // A backslash is a folder separator only on Windows; elsewhere it is part of a file name.
    if (isWindows) expect(siteOpenRefusal("sub\\index.html", dir)).toMatch(/HTML page/);
    expect(siteOpenRefusal("index.html", dir)).toBeNull();
    expect(siteOpenRefusal("about.htm", dir)).toBeNull();
  });

  it("opens the entry page under its written name and nothing else (launchSite)", async () => {
    const { launchSite } = await import("../src/sidecar/siteLaunch");
    const opened: string[] = [];
    const callHost = async (method: string, args: unknown[]) => {
      opened.push(`${method}:${args[0]}`);
      return true;
    };
    const good = await launchSite([f("app.hta", "html", "html", "<p>a</p>")], f("app.hta", "html", "html", "<p>a</p>"), callHost);
    expect(good.error).toBeUndefined();
    expect(good.path?.endsWith("app.html")).toBe(true);
    expect(opened).toEqual([expect.stringMatching(/^openPath:.+app\.html$/)]);
    // nothing written yet: an error, and the host is not asked
    const empty = await launchSite([], f("index.html", "html", "html", ""), callHost);
    expect(empty.error).toBe("There is no page to open yet.");
    expect(opened).toHaveLength(1);
  });
});
