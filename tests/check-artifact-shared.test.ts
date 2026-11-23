import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatEvent } from "../src/shared/types";
import { stepwise, type Session } from "../src/core/build";
import { checkArtifact } from "../src/core/construct/checkArtifact";

/**
 * The windowless artifact check: the sidecar's Test run runs the page in a
 * VM sandbox, and the check IS importable, so the tests drive the exact check a real
 * build consumes. Two things are pinned here, from the SAVED 4b snake page
 * (the build whose acceptance misattributed the failing gate to "no page-check host
 * handler — the check could not run"): the check runs (and has always run) on such a
 * page, and what holds the build back is the HONEST report — unfinished stub units,
 * nothing wired — never a missing check.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SNAKE_PAGE = path.join(HERE, "fixtures", "snake-page.html");
const PAGE_CONTENT = readFileSync(SNAKE_PAGE, "utf8");

describe("the shared checkArtifact on a construction-engine page", () => {
  it("RUNS the saved snake page and reports it honestly: played, nothing wired, stub units named", async () => {
    const r = await checkArtifact(
      { title: "Program", kind: "html", language: "English", content: PAGE_CONTENT },
      [],
      undefined
    );
    expect(r.ran).toBe("page"); // the page RAN — the check exists and works
    expect(r.wired).toBe(0); // and this is what actually held the build back
    expect(r.errors).toEqual([]);
  });

  it("a build's Test run step RUNS on a page whose handlers are never wired — the honest gate, not a missing check", async () => {
    // a page like the engine's assembled output: handlers defined, NOTHING wires them
    const page = `<!doctype html><html><body><canvas id="c" width="300" height="300"></canvas><script>
/* unit:onTick */ function onTick() { S.x = (S.x + 1) % 300; }
/* unit:onKey */ function onKey(e) { if (e.key === "ArrowLeft") S.x -= 10; }
const S = { x: 0 };
</script></body></html>`;
    const stats = { ttftSec: 0.1, tokPerSec: 10, tokens: 5, totalSec: 0.5 };
    const file = (title: string, body: string) => `<artifact type="html" title="${title}">\n${body}\n</artifact>`;
    const stream: Session = async function* (sid, _msgs) {
      const text = sid.replace(/^[^:]*:/, "") === "plan"
        ? "Mode: build\nFile: index.html | new | the page"
        : sid.includes(":write") ? file("index.html", page)
        : "Done.";
      for (let i = 0; i < text.length; i += 17) yield { id: sid, type: "answer", text: text.slice(i, i + 17) };
      yield { id: sid, type: "done", stats };
    };
    const events: ChatEvent[] = [];
    const g = stepwise({
      id: "t-check-runs",
      // "no engine": the plain write path, so the fake needs no engine sessions
      messages: [{ role: "user", content: "make a small animated page in raw code, no engine" }],
      stream,
      maxChars: 8000,
      // THE REAL CHECK — the same function the sidecar's ChatHost serves
      check: (a, all) => checkArtifact(a, all),
    });
    let r = await g.next();
    while (!r.done) { events.push(r.value); r = await g.next(); }
    const builds = events.filter((e): e is Extract<ChatEvent, { type: "build" }> => e.type === "build");
    const last = builds.at(-1)!.build;
    const notes = [
      ...last.steps.flatMap((s) => (s.stages ?? []).map((x) => x.note ?? "")),
      ...(last.verify ?? []).map((x) => x.note ?? ""),
    ];
    expect(notes.join(" | ")).toContain("nothing on the page is wired to keys, clicks or ticks");
    expect(notes.join(" | ")).not.toContain("could not run the page");
    expect(last.status).toBe("unresolved"); // held back honestly: nothing was seen to work
  });
});
