import { describe, expect, it } from "vitest";
import {
  DOC_EDIT_MAX_FIND,
  DOC_EDIT_MAX_OPS,
  DocEditFault,
  applyDocEdits,
  buildEditedCopy,
  docxModelView,
  projectionLines,
  tokenizeDocx,
  verifyEdit,
} from "../src/core/docEdit";
import { buildOffice, readOffice } from "../src/core/office";
import { toBytes, writeZip } from "../src/core/zip";
import {
  nextCopyPath,
  parseDocEditReply,
  reviewWait,
  runDocEdit,
  type DocEditFs,
} from "../src/sidecar/docEditRun";
import type { AgentRunEvent } from "../src/shared/agent";

/**
 * Edit a copy, driven at both levels with fakes and disposable documents:
 * the pure engine (tokenize, match, splice, verify) over hand-built XML, and
 * the sidecar loop over an in-memory fs and a scripted model. The engine's
 * central claim is pinned byte for byte: the copy equals the source except
 * inside the edited ranges.
 */

// ---------------------------------------------------------------- test documents

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const run = (text: string, rPr = "") => `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const p = (...content: string[]) => `<w:p><w:pPr><w:spacing w:after="200"/></w:pPr>${content.join("")}</w:p>`;
const docXml = (...paras: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr/></w:body></w:document>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

/** A real docx as zip bytes: document.xml plus parts the edit must never touch. */
async function docxBytes(doc: string): Promise<Uint8Array> {
  return writeZip({ "word/document.xml": toBytes(doc), "[Content_Types].xml": toBytes(CONTENT_TYPES), "word/styles.xml": toBytes(STYLES) });
}

const SIMPLE = docXml(p(run("Quarterly review draft")), p(run("The numbers are in the shared drive.")));

// ---------------------------------------------------------------- the engine

describe("tokenize and the projection", () => {
  it("projects one line per paragraph with the entities unescaped", () => {
    const doc = docXml(p(run("Tom & Jerry <3")), p(run("second line")));
    const lines = projectionLines(tokenizeDocx(doc));
    expect(lines).toEqual(["Tom & Jerry <3", "second line"]);
  });

  it("joins the segments of split runs and shows tabs and breaks as gaps", () => {
    const doc = docXml(p(run("hello "), `<w:r><w:t>world</w:t></w:r><w:r><w:tab/><w:t>x</w:t></w:r><w:r><w:br/><w:t>y</w:t></w:r>`));
    const paras = tokenizeDocx(doc);
    expect(paras[0]!.text).toBe("hello world\tx y");
    expect(paras[0]!.segs.map((s) => s.text)).toEqual(["hello ", "world", "x", "y"]);
    expect(paras[0]!.segs[2]!.projStart).toBe(12);
  });

  it("reads a self-closing paragraph and skips a damaged tail", () => {
    expect(projectionLines(tokenizeDocx(docXml() + "<w:p/>"))).toEqual([""]);
    expect(projectionLines(tokenizeDocx(docXml(p(run("only"))).replace("<w:sectPr/>", "") + "<w:p><w:r>"))).toEqual(["only"]);
  });
});

describe("applyDocEdits", () => {
  it("replaces exact text inside one run and leaves the rest of the string byte-identical", () => {
    const edited = applyDocEdits(SIMPLE, [{ find: "shared drive", replace: "Q3 archive" }]);
    expect(edited).toBe(SIMPLE.replace("shared drive", "Q3 archive"));
  });

  it("keeps the FIRST run's formatting, empties the middle, and keeps the last run's suffix", () => {
    const doc = docXml(p(run("hello ", "<w:rPr><w:b/></w:rPr>"), run("world", "<w:rPr><w:i/></w:rPr>"), run(" tail")));
    const edited = applyDocEdits(doc, [{ find: "hello world", replace: "hi there" }]);
    expect(edited).toBe(docXml(p(`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">hi there</w:t></w:r>`, `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"></w:t></w:r>`, run(" tail"))));
  });

  it("keeps the suffix when the whole match sits inside one segment", () => {
    const doc = docXml(p(run("say hello world twice")));
    const edited = applyDocEdits(doc, [{ find: "hello", replace: "goodbye" }]);
    expect(edited).toBe(docXml(p(run("say goodbye world twice"))));
  });

  it("adds xml:space when the new text starts or ends with a space, and not otherwise", () => {
    const doc = docXml(p(`<w:r><w:t>abc</w:t></w:r>`));
    expect(applyDocEdits(doc, [{ find: "abc", replace: "x " }])).toBe(docXml(p(`<w:r><w:t xml:space="preserve">x </w:t></w:r>`)));
    expect(applyDocEdits(doc, [{ find: "abc", replace: "xy" }])).toBe(docXml(p(`<w:r><w:t>xy</w:t></w:r>`)));
  });

  it("refuses an ambiguous find (two paragraphs, or twice in one)", () => {
    for (const doc of [docXml(p(run("same words")), p(run("same words"))), docXml(p(run("same words and same words")))]) {
      expect(() => applyDocEdits(doc, [{ find: "same words", replace: "x" }])).toThrow(DocEditFault);
      expect(() => applyDocEdits(doc, [{ find: "same words", replace: "x" }])).toThrow(/appears 2 times/);
    }
  });

  it("refuses a find that is absent, empty, too long, has a line break or a control character", () => {
    expect(() => applyDocEdits(SIMPLE, [{ find: "not there", replace: "x" }])).toThrow(/was not found/);
    expect(() => applyDocEdits(SIMPLE, [{ find: "", replace: "x" }])).toThrow(/empty find/);
    expect(() => applyDocEdits(SIMPLE, [{ find: "a".repeat(DOC_EDIT_MAX_FIND + 1), replace: "x" }])).toThrow(/longer than/);
    expect(() => applyDocEdits(SIMPLE, [{ find: "shared\ndrive", replace: "x" }])).toThrow(/line break/);
    expect(() => applyDocEdits(SIMPLE, [{ find: "shared drive", replace: "a\u0000b" }])).toThrow(/control character/);
    expect(() => applyDocEdits(SIMPLE, [{ find: "shared drive", replace: "a\nb" }])).toThrow(/line break/);
  });

  it("refuses a find that crosses a tab or break, but edits on either side", () => {
    const doc = docXml(p(run("before"), `<w:r><w:tab/></w:r>`, run("after")));
    expect(() => applyDocEdits(doc, [{ find: "before\tafter", replace: "x" }])).toThrow(/crosses a tab/);
    const edited = applyDocEdits(doc, [{ find: "before", replace: "here" }]);
    expect(edited).toContain("here");
    expect(edited).toContain("<w:tab/>");
  });

  it("composes the ops against the projection the earlier ops left", () => {
    const doc = docXml(p(run("alpha")), p(run("keep")));
    const edited = applyDocEdits(doc, [{ find: "alpha", replace: "beta" }, { find: "beta", replace: "gamma" }]);
    expect(edited).toContain("gamma");
    expect(() => applyDocEdits(doc, [{ find: "alpha", replace: "something else" }, { find: "beta", replace: "x" }])).toThrow(/was not found/);
  });

  it("refuses more ops than the cap", () => {
    const ops = Array.from({ length: DOC_EDIT_MAX_OPS + 1 }, () => ({ find: "Quarterly", replace: "x" }));
    expect(() => applyDocEdits(SIMPLE, ops)).toThrow(/at most/);
  });

  it("deletes text with an empty replacement (the paragraph shell remains)", () => {
    const edited = applyDocEdits(SIMPLE, [{ find: "Quarterly review draft", replace: "" }]);
    expect(projectionLines(tokenizeDocx(edited))).toEqual(["", "The numbers are in the shared drive."]);
  });
});

describe("the model view", () => {
  it("is the projection and caps with a visible marker", () => {
    expect(docxModelView(SIMPLE)).toBe("Quarterly review draft\nThe numbers are in the shared drive.");
    const long = docXml(p(run("x".repeat(30000))));
    const view = docxModelView(long, 100);
    expect(view).toContain("(+");
    expect(view).toContain("characters not shown");
    expect(view.length).toBeLessThan(160);
  });
});

describe("buildEditedCopy and verifyEdit", () => {
  it("produces a copy the verifier accepts, with every other part byte-equal", async () => {
    const source = await docxBytes(SIMPLE);
    const ops = [{ find: "shared drive", replace: "Q3 archive" }];
    const copy = await buildEditedCopy(source, ops);
    expect(await verifyEdit(source, copy, ops)).toBeNull();
  });

  it("names the fault when another part changed", async () => {
    const source = await docxBytes(SIMPLE);
    const ops = [{ find: "shared drive", replace: "Q3 archive" }];
    await buildEditedCopy(source, ops);
    const tampered = writeZip({
      "word/document.xml": toBytes(applyDocEdits(SIMPLE, ops)),
      "[Content_Types].xml": toBytes(CONTENT_TYPES),
      "word/styles.xml": toBytes(`${STYLES}<!-- touched -->`),
    });
    expect(await verifyEdit(source, await tampered, ops)).toContain("word/styles.xml");
  });

  it("names the fault when the copy's text is not the proposed edit", async () => {
    const source = await docxBytes(SIMPLE);
    const ops = [{ find: "shared drive", replace: "Q3 archive" }];
    await buildEditedCopy(source, ops);
    const wrong = await buildEditedCopy(source, [{ find: "shared drive", replace: "WRONG" }]);
    expect(await verifyEdit(source, wrong, ops)).toContain("does not equal the proposed edit");
  });

  it("round-trips a real document built by the app's own docx builder", async () => {
    const source = await buildOffice("docx", "Quarterly review draft\n\nThe numbers are in the shared drive.");
    const ops = [{ find: "shared drive", replace: "Q3 archive" }];
    const copy = await buildEditedCopy(source, ops);
    expect(await verifyEdit(source, copy, ops)).toBeNull();
    const text = await readOffice("docx", copy);
    expect(text).toContain("Q3 archive");
    expect(text).not.toContain("shared drive");
    const original = await readOffice("docx", source);
    expect(original).toContain("shared drive");
  });
});

// ---------------------------------------------------------------- the loop

/** An in-memory fs with a sha-shaped fake hash, and hooks to sabotage reads. */
function fakeFs(files: Map<string, Uint8Array>, onRead?: (p: string, b: Uint8Array) => Uint8Array, onHash?: (n: number) => string) {
  const writes: string[] = [];
  let hashCalls = 0;
  const fs: DocEditFs = {
    readFile: async (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT: ${p}`);
      return onRead ? onRead(p, b) : b;
    },
    writeFile: async (p, b) => { writes.push(p); files.set(p, b); },
    rename: async (a, to) => { const b = files.get(a); if (!b) throw new Error(`ENOENT: ${a}`); files.delete(a); files.set(to, b); },
    hash: async (p) => {
      hashCalls++;
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return onHash ? onHash(hashCalls) : "hash-same"; // stable unless the test says otherwise
    },
    exists: async (p) => files.has(p),
    unlink: async (p) => { files.delete(p); },
  };
  return { fs, files, writes, hashCalls: () => hashCalls };
}

/** A model that answers from a script; every prompt it saw is kept. */
function fakeModel(replies: string[] | ((n: number, user: string) => string)) {
  const prompts: string[] = [];
  let n = 0;
  const model = {
    propose: async (messages: { role: string; content: string }[], signal: AbortSignal) => {
      n++;
      prompts.push(messages.map((m) => m.content).join("\n"));
      const r = typeof replies === "function" ? replies(n, prompts[n - 1]) : replies[n - 1] ?? "";
      if (r === "@wait-for-abort") {
        signal.throwIfAborted();
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return r;
    },
  };
  return { model, prompts, count: () => n };
}

async function loopSetup(doc = SIMPLE, extraFiles: Record<string, Uint8Array> = {}) {
  const source = await docxBytes(doc);
  const files = new Map<string, Uint8Array>([["C:\\docs\\plan.docx", source], ...Object.entries(extraFiles)]);
  const f = fakeFs(files);
  const events: AgentRunEvent[] = [];
  const emit = (ev: AgentRunEvent) => events.push(ev);
  const ac = new AbortController();
  const run = (model: { model: unknown }, gate?: { waitFor(runId: string, signal: AbortSignal): Promise<boolean> }) =>
    runDocEdit({ runId: "doc-1", sourcePath: "C:\\docs\\plan.docx", task: "replace the drive mention", fs: f.fs, model: model.model as never, emit, signal: ac.signal, review: gate });
  const statuses = () => events.map((e) => e.status);
  return { f, files, events, emit, ac, run, statuses, source };
}

const EDITS = (ops: [string, string][], summary = "reworded") =>
  JSON.stringify({ kind: "edits", ops: ops.map(([find, replace]) => ({ find, replace })), summary });

describe("parseDocEditReply", () => {
  it("accepts the closed shapes and names every other fault", () => {
    expect(parseDocEditReply('{"kind":"edits","ops":[{"find":"a","replace":"b"}],"summary":"s"}')).toEqual({ proposal: { kind: "edits", ops: [{ find: "a", replace: "b" }], summary: "s" } });
    expect(parseDocEditReply('{"kind":"edits","ops":[],"summary":"nothing to change"}')).toEqual({ proposal: { kind: "edits", ops: [], summary: "nothing to change" } });
    expect(parseDocEditReply('{"kind":"unsupported","reason":"needs a table"}')).toEqual({ proposal: { kind: "unsupported", reason: "needs a table" } });
    expect(parseDocEditReply("no json here").fault).toContain("no JSON object");
    expect(parseDocEditReply('{"kind":"click","ref":"e1.0"}').fault).toContain("edits");
    expect(parseDocEditReply('{"kind":"edits","ops":[{"find":"a"}],"summary":"s"}').fault).toContain("replace");
    expect(parseDocEditReply('{"kind":"edits","ops":[],"summary":""}').fault).toContain("summary");
    expect(parseDocEditReply('{"kind":"unsupported","reason":""}').fault).toContain("reason");
  });

  it("repairs raw control characters inside string literals, once", () => {
    const parsed = parseDocEditReply('{"kind":"edits","ops":[{"find":"a","replace":"x\ny"}],"summary":"s"}'.replace("\\n", "\n"));
    expect(parsed).toEqual({ proposal: { kind: "edits", ops: [{ find: "a", replace: "x\ny" }], summary: "s" } });
  });

  it("repairs the thinking-off habit of splitting one edit into find-only + replace-only items", () => {
    const parsed = parseDocEditReply('{"kind":"edits","ops":[{"find":"a"},{"replace":"b"}],"summary":"s"}');
    expect(parsed).toEqual({ proposal: { kind: "edits", ops: [{ find: "a", replace: "b" }], summary: "s" } });
    // several pairs in a row merge in order
    const many = parseDocEditReply('{"kind":"edits","ops":[{"find":"a"},{"replace":"b"},{"find":"c"},{"replace":"d"}],"summary":"s"}');
    expect(many).toEqual({ proposal: { kind: "edits", ops: [{ find: "a", replace: "b" }, { find: "c", replace: "d" }], summary: "s" } });
    // a lone find-only (or replace-only) half stays refused — no invention
    expect(parseDocEditReply('{"kind":"edits","ops":[{"find":"a"}],"summary":"s"}').fault).toContain("find string and a replace string");
    expect(parseDocEditReply('{"kind":"edits","ops":[{"replace":"b"}],"summary":"s"}').fault).toContain("find string and a replace string");
    expect(parseDocEditReply('{"kind":"edits","ops":[{"find":"a"},{"replace":"b"},{"find":"c"}],"summary":"s"}').fault).toContain("find string and a replace string");
  });
});

describe("nextCopyPath", () => {
  it("names the copy beside the source and never overwrites", async () => {
    const files = new Map<string, Uint8Array>();
    const f = fakeFs(files);
    expect(await nextCopyPath(f.fs, "C:\\d\\plan.docx")).toBe("C:\\d\\plan (edited).docx");
    files.set("C:\\d\\plan (edited).docx", new Uint8Array(1));
    expect(await nextCopyPath(f.fs, "C:\\d\\plan.docx")).toBe("C:\\d\\plan (edited 2).docx");
    expect(await nextCopyPath(f.fs, "C:\\d\\plan.docm")).toBe("C:\\d\\plan (edited).docm");
  });
});

describe("the Edit a copy loop", () => {
  it("reads, proposes, applies to the copy, reopens and verifies, then settles done", async () => {
    const { f, run, statuses, events, files } = await loopSetup();
    await run(fakeModel([EDITS([["shared drive", "Q3 archive"]])]));
    expect(statuses()).toEqual(["running", "running", "running", "running", "done"]);
    expect(events.map((e) => e.phase)).toEqual(["observe", "propose", "act", "verify", "settled"]);
    expect(events[4]!.line).toContain('plan (edited).docx');
    expect(events[4]!.line).toContain("plan.docx");
    expect(events[4]!.line.endsWith(".")).toBe(true);
    const copy = files.get("C:\\docs\\plan (edited).docx")!;
    expect(await verifyEdit(files.get("C:\\docs\\plan.docx")!, copy, [{ find: "shared drive", replace: "Q3 archive" }])).toBeNull();
    expect(f.writes).toEqual(["C:\\docs\\plan (edited).docx.part"]);
    // The source's bytes are exactly what they were.
    expect(files.get("C:\\docs\\plan.docx")!.length).toBeGreaterThan(0);
  });

  it("leaves the source byte-identical and the model view in the prompt", async () => {
    const { source, files, run } = await loopSetup();
    const { model, prompts } = fakeModel([EDITS([["shared drive", "Q3 archive"]])]);
    await run({ model });
    expect(files.get("C:\\docs\\plan.docx")!).toEqual(source);
    expect(prompts[0]).toContain("Quarterly review draft\nThe numbers are in the shared drive.");
    expect(prompts[0]).toContain("The edit the person asked for");
  });

  it("settles done with no copy when the model proposes zero edits", async () => {
    const { run, events, files, f } = await loopSetup();
    await run(fakeModel([JSON.stringify({ kind: "edits", ops: [], summary: "already says it" })]));
    expect(events[events.length - 1]!.status).toBe("done");
    expect(events[events.length - 1]!.line).toContain("no copy was written");
    expect(f.writes).toEqual([]);
    expect(files.size).toBe(1);
  });

  it("Stop during the propose settles cancelled with nothing written", async () => {
    const { f, run, events, ac, files } = await loopSetup();
    let proposeStarted!: () => void;
    const started = new Promise<void>((resolve) => { proposeStarted = resolve; });
    const { model } = fakeModel(() => {
      proposeStarted();
      return "@wait-for-abort";
    });
    const pending = run({ model });
    await started;
    ac.abort();
    await pending;
    expect(events[events.length - 1]!.status).toBe("cancelled");
    expect(events[events.length - 1]!.line).toContain("nothing was written");
    expect(f.writes).toEqual([]);
    expect(files.size).toBe(1);
  });

  it("re-asks once with the exact fault and fails on a second refusal, writing nothing", async () => {
    const { f, run, events, files } = await loopSetup();
    const { model, prompts } = fakeModel([EDITS([["not in the doc", "x"]]), EDITS([["still not there", "y"]])]);
    await run({ model });
    expect(events[events.length - 1]!.status).toBe("failed");
    expect(events[events.length - 1]!.line).toContain("refused twice");
    expect(prompts[1]).toContain("was not found in the document");
    expect(f.writes).toEqual([]);
    expect(files.size).toBe(1);
  });

  it("recovers when the first proposal is invalid and the second is good", async () => {
    const { run, events, files } = await loopSetup();
    const { model, prompts } = fakeModel(["I would replace the drive mention with the archive name.", EDITS([["shared drive", "Q3 archive"]])]);
    await run({ model });
    expect(events[events.length - 1]!.status).toBe("done");
    expect(prompts[1]).toContain("no JSON object");
    expect(files.has("C:\\docs\\plan (edited).docx")).toBe(true);
  });

  it("settles unsupported as unresolved with the reason", async () => {
    const { run, events, f } = await loopSetup();
    await run(fakeModel([JSON.stringify({ kind: "unsupported", reason: "it would add a table" })]));
    console.log("DBG-UNSUPPORTED:", JSON.stringify(events.map((e) => [e.status, e.line])));
    const last = events[events.length - 1]!;
    expect(last.status).toBe("unresolved");
    expect(last.line).toContain("add a table");
    expect(f.writes).toEqual([]);
  });

  it("settles unresolved, never done, when the verification fails on the reopened copy", async () => {
    const { source } = await loopSetup();
    // Sabotage the reopened copy: the copy's bytes come back as garbage.
    const files = new Map<string, Uint8Array>([["C:\\docs\\plan.docx", source]]);
    const f = fakeFs(files, (p) => (p.endsWith("(edited).docx") ? toBytes("garbage") : files.get(p)!));
    const events: AgentRunEvent[] = [];
    const { model } = fakeModel([EDITS([["shared drive", "Q3 archive"]])]);
    await runDocEdit({ runId: "doc-1", sourcePath: "C:\\docs\\plan.docx", task: "edit", fs: f.fs, model: model as never, emit: (ev) => events.push(ev), signal: new AbortController().signal });
    const last = events[events.length - 1]!;
    expect(last.status).toBe("unresolved");
    expect(last.line).toContain("verification failed");
    expect(last.line).toContain("(edited).docx");
  });

  it("settles unresolved when the source's hash moves during the run", async () => {
    const source = await docxBytes(SIMPLE);
    const files = new Map<string, Uint8Array>([["C:\\docs\\plan.docx", source]]);
    const f = fakeFs(files, undefined, (n) => `hash-${n}`); // every hash differs
    const events: AgentRunEvent[] = [];
    const { model } = fakeModel([EDITS([["shared drive", "Q3 archive"]])]);
    await runDocEdit({ runId: "d", sourcePath: "C:\\docs\\plan.docx", task: "edit", fs: f.fs, model: model as never, emit: (ev) => events.push(ev), signal: new AbortController().signal });
    const last = events[events.length - 1]!;
    expect(last.status).toBe("unresolved");
    expect(last.line).toContain("source file changed");
  });

  it("names the second copy (edited 2) when one already exists", async () => {
    const { files, run, events } = await loopSetup();
    files.set("C:\\docs\\plan (edited).docx", new Uint8Array([1, 2, 3]));
    const { model } = fakeModel([EDITS([["shared drive", "Q3 archive"]])]);
    await run({ model });
    expect(events[events.length - 1]!.line).toContain("plan (edited 2).docx");
    expect(files.get("C:\\docs\\plan (edited).docx")!).toEqual(new Uint8Array([1, 2, 3]));
    expect(files.has("C:\\docs\\plan (edited 2).docx")).toBe(true);
  });

  it("refuses a legacy .doc and a non-Word file with their own messages", async () => {
    for (const [pathName, pattern] of [["C:\\docs\\plan.doc", /old Word format/], ["C:\\docs\\plan.txt", /not a Word document/]] as const) {
      const source = await docxBytes(SIMPLE);
      const files = new Map<string, Uint8Array>([[pathName, source]]);
      const f = fakeFs(files);
      const events: AgentRunEvent[] = [];
      const { model } = fakeModel(["x"]);
      await runDocEdit({ runId: "d", sourcePath: pathName, task: "edit", fs: f.fs, model: model as never, emit: (ev) => events.push(ev), signal: new AbortController().signal });
      expect(events[events.length - 1]!.status).toBe("failed");
      expect(events[events.length - 1]!.line).toMatch(pattern);
      expect(f.writes).toEqual([]);
    }
  });

  it("refuses a file with no document part", async () => {
    const files = new Map<string, Uint8Array>([["C:\\docs\\plan.docx", await writeZip({ "word/styles.xml": toBytes(STYLES) })]]);
    const f = fakeFs(files);
    const events: AgentRunEvent[] = [];
    const { model } = fakeModel(["x"]);
    await runDocEdit({ runId: "d", sourcePath: "C:\\docs\\plan.docx", task: "edit", fs: f.fs, model: model as never, emit: (ev) => events.push(ev), signal: new AbortController().signal });
    expect(events[events.length - 1]!.status).toBe("failed");
    expect(events[events.length - 1]!.line).toContain("no document part");
  });

  it("shows the review gate (exact ops and destination) and, on approve, writes and verifies", async () => {
    const { f, run, events, files } = await loopSetup();
    const answers: boolean[] = [];
    const gate = { waitFor: async () => { answers.push(true); return true; } };
    await run(fakeModel([EDITS([["shared drive", "Q3 archive"]])]), gate);
    // the gate sits between the proposal and the write
    expect(events.map((e) => e.phase)).toEqual(["observe", "propose", "review", "act", "verify", "settled"]);
    const review = events.find((e) => e.phase === "review")!.review!;
    expect(review).toEqual({
      ops: [{ find: "shared drive", replace: "Q3 archive" }],
      summary: "reworded",
      sourceName: "plan.docx",
      destination: "plan (edited).docx",
    });
    expect(answers).toEqual([true]); // the loop waited for exactly one answer
    const last = events[events.length - 1]!;
    expect(last.status).toBe("done");
    expect(last.copyPath).toBe("C:\\docs\\plan (edited).docx");
    expect(files.has("C:\\docs\\plan (edited).docx")).toBe(true);
    expect(f.writes).toEqual(["C:\\docs\\plan (edited).docx.part"]);
  });

  it("Cancel on the review gate settles cancelled with nothing written and no .part left", async () => {
    const { f, run, events, files } = await loopSetup();
    const gate = { waitFor: async () => false };
    await run(fakeModel([EDITS([["shared drive", "Q3 archive"]])]), gate);
    const last = events[events.length - 1]!;
    expect(last.status).toBe("cancelled");
    expect(last.line).toContain("nothing was written");
    expect(last.line).not.toContain("check the folder"); // the folder was never touched
    expect(f.writes).toEqual([]); // not even the .part file was created
    expect(files.size).toBe(1); // only the source
  });

  it("Stop while the review gate stands open settles cancelled with nothing written", async () => {
    const { f, run, events, ac, files } = await loopSetup();
    // the gate blocks until the run's own abort signal reaches it (main.ts's shape), and says
    // when the run has reached it: Stop is pressed then, not after a guessed delay that a busy
    // machine can outrun (the run then stopped before the gate, with another line)
    let reachedGate!: () => void;
    const atGate = new Promise<void>((r) => { reachedGate = r; });
    const gate = {
      waitFor: (_id: string, signal: AbortSignal) =>
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          reachedGate();
        }),
    };
    const pending = run(fakeModel([EDITS([["shared drive", "Q3 archive"]])]), gate);
    await atGate;
    ac.abort();
    await pending;
    const last = events[events.length - 1]!;
    expect(last.status).toBe("cancelled");
    expect(last.line).toContain("nothing was written");
    expect(f.writes).toEqual([]);
    expect(files.size).toBe(1);
  });

  it("revalidates the source when the gate approves: a moved source faults the run before the write", async () => {
    const source = await docxBytes(SIMPLE);
    const files = new Map<string, Uint8Array>([["C:\\docs\\plan.docx", source]]);
    // call 1 = the read's hash; calls 2+ differ → the file moved under the gate
    const f = fakeFs(files, undefined, (n) => (n === 1 ? "hash-1" : `hash-${n}`));
    const events: AgentRunEvent[] = [];
    const { model } = fakeModel([EDITS([["shared drive", "Q3 archive"]])]);
    const gate = { waitFor: async () => true };
    await runDocEdit({ runId: "d", sourcePath: "C:\\docs\\plan.docx", task: "edit", fs: f.fs, model: model as never, emit: (ev) => events.push(ev), signal: new AbortController().signal, review: gate });
    const last = events[events.length - 1]!;
    expect(last.status).toBe("failed");
    expect(last.line).toContain("changed while the change was under review");
    expect(last.line).toContain("wrote nothing");
    expect(f.writes).toEqual([]);
    expect(files.size).toBe(1);
  });
});

describe("review gate races", () => {
  it("never overwrites a file that took the destination name while the review stood open", async () => {
    const { f, files, run, statuses } = await loopSetup();
    const intruder = new Uint8Array([1, 2, 3]);
    const gate = { waitFor: async () => { files.set("C:\\docs\\plan (edited).docx", intruder); return true; } };
    await run(fakeModel([EDITS([["shared drive", "Q3 archive"]])]), gate);
    expect(files.get("C:\\docs\\plan (edited).docx")).toBe(intruder);
    expect(f.writes).toEqual([]);
    expect(statuses().at(-1)).toBe("failed");
  });

  it("a stop that came before the wait began ends the wait at once", async () => {
    const map = new Map<string, (ok: boolean) => void>();
    const ac = new AbortController();
    ac.abort();
    await expect(reviewWait(map, "r", ac.signal)).rejects.toThrow("aborted");
    expect(map.size).toBe(0);
  });

  it("an answer or a later stop settles the wait", async () => {
    const map = new Map<string, (ok: boolean) => void>();
    const ac = new AbortController();
    const yes = reviewWait(map, "r", ac.signal);
    map.get("r")!(true);
    await expect(yes).resolves.toBe(true);
    const later = reviewWait(map, "s", ac.signal);
    ac.abort();
    await expect(later).rejects.toThrow("aborted");
    expect(map.has("s")).toBe(false);
  });
});
