import { describe, expect, it } from "vitest";
import { OPS, evalPlan, readInputs, readSteps, readWords, sheetAnswers, sheetText, stepsSchema, methodNotes, type CalcPlan } from "../src/core/templates/calcsheet";
import { makeFromTemplate } from "../src/core/templates/build";
import { Q } from "../src/core/router";
import { artifactsIn } from "../src/core/artifacts";
import { Workbook, parseSheets } from "../src/core/sheet";
import type { ChatEvent } from "../src/shared/types";

const REQUEST = `make an excel doc and put the accounting figures and the answers to the following questions in it:
on 1 November N, the stock was 1200 pieces valued at 170400 EUR
raw materials 350000
transport costs of materials 15000
direct production costs 260000
indirect production costs 90 000
on 31/12/N there are 2000 toys left in stock valued at 300000 (market price)
determine the production cost of 5000 toys
value the stock knowing that the company uses the weighted average cost method`;

const INPUTS = [
  { label: "Raw materials", value: 350000, unit: "€" }, { label: "Transport of materials", value: 15000, unit: "€" },
  { label: "Direct production costs", value: 260000, unit: "€" }, { label: "Indirect production costs", value: 90000, unit: "€" },
  { label: "Toys produced", value: 5000, unit: "toys" }, { label: "Opening stock (quantity)", value: 1200, unit: "toys" },
  { label: "Opening stock (value)", value: 170400, unit: "€" }, { label: "Closing stock (quantity)", value: 2000, unit: "toys" },
  { label: "Market price of the closing stock", value: 300000, unit: "€" }
];
const WORDS = [
  { label: "Production cost", how: "the sum of the four costs" }, { label: "Quantity available", how: "opening quantity plus toys produced" },
  { label: "Value available", how: "opening value plus cost of production" }, { label: "Weighted average cost", how: "value available divided by quantity available" },
  { label: "Closing stock at weighted average cost", how: "final quantity times the weighted average cost" }, { label: "Retained value of the closing stock", how: "the lower of the weighted average cost value and the market price" }
];
const STEPS = [
  { label: "Production cost", op: "sum", args: ["Raw materials", "Transport of materials", "Direct production costs", "Indirect production costs"] },
  { label: "Quantity available", op: "sum", args: ["Opening stock (quantity)", "Toys produced"] },
  { label: "Value available", op: "sum", args: ["Opening stock (value)", "Production cost"] },
  { label: "Weighted average cost", op: "div", args: ["Value available", "Quantity available"] },
  { label: "Closing stock at weighted average cost", op: "mul", args: ["Closing stock (quantity)", "Weighted average cost"] },
  { label: "Retained value of the closing stock", op: "min", args: ["Closing stock at weighted average cost", "Market price of the closing stock"] }
];
const ANSWERS = [{ question: "Production cost of 5000 toys", step: "Production cost" }, { question: "Value of the closing stock", step: "Retained value of the closing stock" }];

describe("the plan of calculations", () => {
  const inputs = readInputs({ inputs: INPUTS });
  it("is read, put in order and run: 715000 and 285613", () => {
    const r = readSteps({ steps: [...STEPS].reverse() }, inputs, WORDS.map((w) => w.label));
    expect(r.problems).toEqual([]);
    expect(r.steps.map((s) => s.label)).toEqual(["Production cost", "Quantity available", "Value available", "Weighted average cost", "Closing stock at weighted average cost", "Retained value of the closing stock"]);
    const plan: CalcPlan = { inputs, steps: r.steps, answers: ANSWERS };
    const v = evalPlan(plan);
    expect(v.problems).toEqual([]);
    expect(v.values.get("Production cost")).toBe(715000);
    expect(Math.round(v.values.get("Retained value of the closing stock")!)).toBe(285613);
    const src = sheetText(plan, "en");
    expect(src).toContain("=[Value available]/[Quantity available]");
    expect(sheetAnswers(src, plan, "en").map((a) => Math.round(a.value))).toEqual([715000, 285613]);
    expect(new Workbook(parseSheets(src)).show(new Workbook(parseSheets(src)).cell("Calculations", 10, 1))).toBe("715000");
  });
  it("names what is wrong, exactly", () => {
    const planned = WORDS.map((w) => w.label);
    const bad = readSteps({ steps: [{ label: "Weighted average cost", op: "add", args: ["x"] }, { label: "Value available", op: "div", args: ["Opening stock (value)", "Quantity available", "Toys produced"] }, { label: "Production cost", op: "sum", args: ["Raw materials", 5000] }] }, inputs, planned);
    expect(bad.problems.join(" ")).toMatch(/"add" is not one of/);
    expect(bad.problems.join(" ")).toMatch(/div takes exactly two/);
    expect(bad.problems.join(" ")).toMatch(/"5000" is not the label/);
    expect(bad.problems.join(" ")).toMatch(/"Quantity available" has no operation/);
    const loop = readSteps({ steps: [{ label: "A", op: "sum", args: ["B"] }, { label: "B", op: "sum", args: ["A"] }] }, inputs, ["A", "B"]);
    expect(loop.problems.join(" ")).toMatch(/in a circle/);
    const zero = evalPlan({ inputs: [{ label: "a", value: 1, unit: "" }, { label: "z", value: 0, unit: "" }], steps: [{ label: "q", op: "div", args: ["a", "z"] }], answers: [] });
    expect(zero.problems[0]).toMatch(/divides by zero/);
  });
  it("closes the schema: the operation and the arguments can only be what exists", () => {
    const s = stepsSchema(["a", "b"], ["c"]) as { properties: { steps: { minItems: number; items: { properties: { op: { enum: string[] }; args: { items: { enum: string[] } }; label: { enum: string[] } } } } } };
    expect(s.properties.steps.minItems).toBe(1);
    expect(s.properties.steps.items.properties.op.enum).toEqual([...OPS]);
    expect(s.properties.steps.items.properties.args.items.enum).toEqual(["a", "b", "c"]);
    expect(s.properties.steps.items.properties.label.enum).toEqual(["c"]);
  });
  it("cleans labels and reads answers by their spelling", () => {
    expect(readInputs({ inputs: [{ label: "A [x]|@", value: "1 200,5 €", unit: "" }, { label: "a [x]", value: 2, unit: "" }, { label: "n", value: "n/a", unit: "" }] }).map((i) => `${i.label}=${i.value}`)).toEqual(["A x=1200.5", "a x (2)=2"]);
    expect(readWords({ steps: [{ label: "Cost", how: "x" }], answers: [{ question: "q", step: "COST" }] }, inputs).answers[0].step).toBe("Cost");
  });
  it("gives the model a line on the method the statement names, and only then", () => {
    expect(methodNotes(REQUEST).join(" ")).toMatch(/Weighted average cost =/);
    expect(methodNotes(REQUEST).join(" ")).toMatch(/lower of its cost and its market price/);
    expect(methodNotes("make a spreadsheet of my grades")).toEqual([]);
  });
});

describe("a sheet made from the figures of a request", () => {
  const stats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
  const model = (replies: Record<string, unknown>, seen: { sid: string; schema?: unknown }[] = []) => async function* (sid: string, _m: unknown[], _w: boolean, _r?: string, schema?: unknown): AsyncGenerator<ChatEvent> {
    seen.push({ sid, schema });
    const key = Object.keys(replies).find((k) => sid.includes(`:${k}`));
    yield { id: sid, type: "answer", text: key ? JSON.stringify(replies[key]) : "Done." } as ChatEvent;
    yield { id: sid, type: "done", stats } as ChatEvent;
  };
  const go = async (replies: Record<string, unknown>, seen: { sid: string; schema?: unknown }[] = []) => {
    const g = makeFromTemplate({ id: "t", messages: [{ role: "user", content: REQUEST }], stream: model(replies, seen) as never, askRouter: async (q: string) => q === Q.exercise });
    const events: ChatEvent[] = []; let r = await g.next();
    while (!r.done) { events.push(r.value); r = await g.next(); }
    return { result: r.value, events };
  };
  it("goes from the statement to a sheet whose formulas give the answers, the figures showing first", async () => {
    const seen: { sid: string; schema?: unknown }[] = [];
    const { result, events } = await go({ "calc:inputs": { inputs: INPUTS }, "calc:words": { steps: WORDS, answers: ANSWERS }, "calc:ops": { steps: STEPS } }, seen);
    expect(result.handled).toBe(true);
    const text = (result as { text: string }).text;
    const a = artifactsIn(text)[0];
    expect(a.kind).toBe("xlsx");
    expect(a.content).toContain("=MIN([Closing stock at weighted average cost],[Market price of the closing stock])");
    expect(text).toMatch(/715,000/);
    expect(text).toMatch(/285,61[23]/);
    // the figures are drawn before the calculations exist
    const drawn = events.filter((e) => e.type === "replace").map((e) => (e as { text: string }).text);
    expect(drawn[0]).toContain("350000");
    expect(drawn[0]).not.toContain("=[");
    // every question is a closed one, held to a schema, and does not think
    expect(seen.filter((s) => s.sid.includes(":x:calc:")).every((s) => !!s.schema)).toBe(true);
    expect(seen.map((s) => s.sid)).toEqual(["t:x:calc:inputs:0", "t:x:calc:words:0", "t:x:calc:ops:0"]);
  });
  it("asks the operations again with the exact fault, then falls back to the usual writing", async () => {
    const seen: { sid: string; schema?: unknown }[] = [];
    const bad = { steps: STEPS.map((s) => (s.label === "Weighted average cost" ? { ...s, op: "add" } : s)) };
    const { result, events } = await go({ "calc:inputs": { inputs: INPUTS }, "calc:words": { steps: WORDS, answers: ANSWERS }, "calc:ops": bad }, seen);
    expect(result.handled).toBe(false);
    expect(seen.map((s) => s.sid).filter((s) => s.includes("ops"))).toEqual(["t:x:calc:ops:0", "t:x:calc:ops:1"]);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });
});

describe("writing in the cells", () => {
  it("sets one cell of the text form, adds what is past the end, and keeps formulas", async () => {
    const { setCell } = await import("../src/core/sheet");
    const src = "## S\n| Item | Value |\n|---|---|\n| a | 1 |\n| Total | =B2 |";
    const one = setCell(src, 0, 1, 1, "5");
    expect(parseSheets(one)[0].rows[1]).toEqual(["a", "5"]);
    expect(parseSheets(one)[0].rows[2]).toEqual(["Total", "=B2"]);
    expect(parseSheets(setCell(src, 0, 5, 3, "x"))[0].rows[5]).toEqual(["", "", "", "x"]);
    expect(parseSheets(setCell(src, 0, 3, 0, ""))[0].rows).toHaveLength(3);
    expect(setCell(src, 4, 0, 0, "x")).toBe(src);
  });
  // CodeQL #97/#21: the cell to write comes in a message from the sheet preview's frame, where the
  // generated page runs; only whole numbers within the sheet are taken, anything else changes nothing
  it("writes a cell only for whole-number positions: names such as __proto__ never reach an object path", async () => {
    const { setCell } = await import("../src/core/sheet");
    const src = "## S\n| Item | Value |\n|---|---|\n| a | 1 |";
    const odd = ["__proto__", "constructor", "1", 1.5, Number.NaN, Infinity, -1, null, undefined, {}] as unknown as number[];
    for (const v of odd) {
      expect(() => setCell(src, v, 1, 1, "x"), `sheet ${String(v)}`).not.toThrow();
      expect(setCell(src, v, 1, 1, "x"), `sheet ${String(v)}`).toBe(src);
      expect(setCell(src, 0, v, 1, "x"), `row ${String(v)}`).toBe(src);
      expect(setCell(src, 0, 1, v, "x"), `col ${String(v)}`).toBe(src);
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(setCell(src, 0, 1, 1, "x")).not.toBe(src); // a real cell still writes
  });
  it("puts the cell writer in the preview only when asked", async () => {
    const { officePreview } = await import("../src/core/office");
    const src = "## S\n| a | =1+1 |";
    expect(officePreview("xlsx", src)).not.toContain("npuEditCell");
    const p = officePreview("xlsx", src, {}, undefined, false, true);
    expect(p).toContain("npuEditCell");
    expect(p).toContain('data-raw="=1+1"');
    expect(() => new Function(p.match(/<script>([\s\S]*)<\/script>/)![1])).not.toThrow();
  });
});

describe("writing in the text of a document", () => {
  it("cuts a document into blocks (a fence is one block) and writes one back", async () => {
    const { splitBlocks, replaceBlock, isFenced } = await import("../src/core/docBlocks");
    const src = "# Title\n\nFirst paragraph\nsecond line\n\n```chart\na: 1\n\nb: 2\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    expect(splitBlocks(src)).toEqual(["# Title", "First paragraph\nsecond line", "```chart\na: 1\n\nb: 2\n```", "| a | b |\n|---|---|\n| 1 | 2 |"]);
    expect(isFenced(splitBlocks(src)[2])).toBe(true);
    expect(replaceBlock(src, 1, "Changed")).toBe("# Title\n\nChanged\n\n```chart\na: 1\n\nb: 2\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(replaceBlock(src, 0, "")).not.toContain("# Title");
    expect(replaceBlock("", 0, "New text")).toBe("New text");
    expect(replaceBlock("a\n\nb", 5, "c")).toBe("a\n\nb\n\nc");
  });
});

describe("a sheet or a document that no template holds", () => {
  const stats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
  const run = async (request: string, text: string) => {
    const seen: string[] = [];
    const stream = async function* (sid: string): AsyncGenerator<ChatEvent> { seen.push(sid); yield { id: sid, type: "answer", text } as ChatEvent; yield { id: sid, type: "done", stats } as ChatEvent; };
    const g = makeFromTemplate({ id: "t", messages: [{ role: "user", content: request }], stream: stream as never, askRouter: async () => false, drawEveryMs: 0 });
    let r = await g.next(); while (!r.done) r = await g.next();
    return { result: r.value, seen };
  };
  it("is written as a file, never handed to the program builder", async () => {
    const { result, seen } = await run("make an empty accounting journal I can use in exel", "```\n## Journal\n| Date | Description | Debit | Credit | Balance |\n|---|---|---|---|---|\n| | | | | =C2-D2 |\n| | | | | =C3-D3 |\n```");
    expect(result.handled).toBe(true);
    const a = artifactsIn((result as { text: string }).text)[0];
    expect(a.kind).toBe("xlsx");
    expect(a.content).toContain("| Date | Description | Debit | Credit | Balance |");
    expect(a.content).not.toContain("```");
    expect(seen.some((s) => s.includes(":x:free:xlsx"))).toBe(true);
  });
  it("gives the request back when nothing usable was written", async () => {
    const { result } = await run("make an empty accounting journal I can use in exel", "Sorry, I cannot.");
    expect(result.handled).toBe(false);
  });
  it("keeps only the table lines of a sheet and the text of a document", async () => {
    const { fileText } = await import("../src/core/templates/freefile");
    expect(fileText("Here is the sheet:\n## A\n| x | y |\n|---|---|\n| 1 | 2 |\nHave a good day", "xlsx")).toBe("## A\n| x | y |\n|---|---|\n| 1 | 2 |");
    expect(fileText("```markdown\n# Title\n\nText\n```", "docx")).toBe("# Title\n\nText");
  });
});

describe("the search of a request that asks for a document", () => {
  it("searches the topic, not what is to be done with it", async () => {
    const { keywords } = await import("../src/core/websearch");
    expect(keywords("do some research on american healthcare and make a research doc")).toBe("american healthcare");
  });
});

describe("what is searched", () => {
  it("leaves out the greeting and the qualifiers of the request", async () => {
    const { keywords } = await import("../src/core/websearch");
    expect(keywords("hello, do some simple research on the american healthcare system")).toBe("american healthcare system");
  });
});

describe("what the router wrote as a search", () => {
  it("refuses what is not a line of words", async () => {
    const { readSearchQuery } = await import("../src/core/router");
    expect(readSearchQuery("no_result")).toBeNull();
    expect(readSearchQuery("none")).toBeNull();
    expect(readSearchQuery("Query: american healthcare system")).toBe("american healthcare system");
    expect(readSearchQuery('"price of bitcoin"')).toBe("price of bitcoin");
  });
});

describe("a heavy decision asked three ways", () => {
  it("is settled by two that agree, and stays open otherwise", async () => {
    const { settled, PRODUCE_VOTES } = await import("../src/core/router");
    expect(PRODUCE_VOTES).toHaveLength(3);
    expect(new Set(PRODUCE_VOTES).size).toBe(3);
    expect(settled([true], 3)).toBeUndefined();
    expect(settled([true, true], 3)).toBe(true);
    expect(settled([false, false], 3)).toBe(false);
    expect(settled([true, false], 3)).toBeUndefined();
    expect(settled([true, false, false], 3)).toBe(false);
  });
});

describe("the router's room to answer", () => {
  it("never caps an answer below the empty thinking block some models write first", async () => {
    const { routerSampling, ROUTER_MIN_TOKENS } = await import("../src/core/router");
    expect(routerSampling(3).max_tokens).toBe(ROUTER_MIN_TOKENS);
    expect(routerSampling(24).max_tokens).toBe(24);
    expect(routerSampling(3).top_k).toBe(1);
  });
});

describe("the lab asked the way the router is", () => {
  it("reads a greedy option", async () => {
    const { parseLabFile } = await import("../src/core/promptLab");
    const f = parseLabFile("---\ngreedy: on\n---\n## a\nx\n### Checks\n- contains: y\n");
    expect(f.problems).toEqual([]);
    expect(f.options.greedy).toBe(true);
  });
});

describe("opening the whole text of a document at a block", () => {
  it("finds where a block starts", async () => {
    const { blockStart } = await import("../src/core/docBlocks");
    const src = "# Title\n\nFirst\nline\n\nLast";
    expect(blockStart(src, 0)).toBe(0);
    expect(blockStart(src, 1)).toBe(9);
    expect(src.slice(blockStart(src, 2))).toBe("Last");
    expect(blockStart(src, 9)).toBe(src.length);
  });
});
