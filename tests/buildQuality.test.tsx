// @vitest-environment jsdom
// The quality score a build reports (BuildRun.quality, src/core/harness/quality.ts) is shown on the build card once the work has
// finished: a quiet chip in the card's header, warning-toned below the bar, and what fell short listed when the card is opened.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildCard, fullLog } from "../src/renderer/BuildProgress";
import { loadConversations, persistableConversations } from "../src/renderer/store";
import type { BuildRun } from "../src/shared/types";

afterEach(cleanup);

const done = (quality?: BuildRun["quality"], status: BuildRun["status"] = "done"): BuildRun => ({
  status,
  steps: [{ file: "Slide 1 · Solar", action: "new", job: "text", status: status === "running" ? "running" : "done", stages: [{ id: "write", label: "Text", status: status === "running" ? "running" : "done", sec: 2, at: Date.now() }] }],
  ...(quality ? { quality } : {}),
});

describe("the quality badge on a finished build", () => {
  it("shows the score as a percentage, in a good tone at or above the bar", () => {
    render(<BuildCard build={done({ rubric: "deck", score: 0.917, notes: [] })} />);
    const chip = screen.getByText("Quality 92%");
    expect(chip.className).toContain("good");
    expect(chip.getAttribute("title")).toMatch(/deck/i);
  });
  it("below the bar it is warning-toned, and the weak points are counted and listed when the card is opened", () => {
    render(<BuildCard build={done({ rubric: "docx", score: 0.615, notes: ["the document says almost nothing (0 words)", "the heading \"Summary\" has nothing under it"] })} />);
    const chip = screen.getByText("Quality 62%"); // the score alone: it must fit a narrow chat column
    expect(chip.className).toContain("weak");
    expect(chip.getAttribute("title")).toContain("2 weak points");
    expect(screen.getByText("2 weak points found by the quality check")).toBeTruthy();
    // the card folds its details away (inert) until it is opened
    const folded = () => screen.getByText(/says almost nothing/).closest(".unfold")!;
    expect(folded().hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Quality 62%/ }));
    expect(folded().hasAttribute("inert")).toBe(false);
    expect(screen.getByText(/"Summary" has nothing under it/)).toBeTruthy();
  });
  it("is not shown while the work is still running, nor when no score came back", () => {
    render(<BuildCard build={done({ rubric: "deck", score: 0.9, notes: [] }, "running")} />);
    expect(screen.queryByText(/Quality \d+%/)).toBeNull();
    cleanup();
    render(<BuildCard build={done()} />);
    expect(screen.queryByText(/Quality \d+%/)).toBeNull();
  });
  it("is kept when the chat is saved and read back, and a malformed saved score is dropped", () => {
    const conv = (quality: unknown) => [{ id: "c1", title: "Deck", updated: 1, turns: [{ role: "assistant", content: "x", pending: false, build: { ...done(), quality } }] }];
    localStorage.setItem("opennpu.conversations", JSON.stringify(persistableConversations(conv({ rubric: "deck", score: 0.6, notes: ["slide 3 is nearly empty"] }) as never)));
    expect(loadConversations()[0].turns[0].build?.quality).toEqual({ rubric: "deck", score: 0.6, notes: ["slide 3 is nearly empty"] });
    for (const bad of [{ rubric: "deck", score: "high", notes: [] }, { rubric: "deck", score: 7, notes: [] }, { score: 0.5, notes: [] }, "0.9"]) {
      localStorage.setItem("opennpu.conversations", JSON.stringify(conv(bad)));
      expect(loadConversations()[0].turns[0].build?.quality, JSON.stringify(bad)).toBeUndefined();
    }
    localStorage.setItem("opennpu.conversations", JSON.stringify(conv({ rubric: "page", score: 0.5, notes: ["ok", 3, null] })));
    expect(loadConversations()[0].turns[0].build?.quality?.notes).toEqual(["ok"]);
  });
  it("rides the copied full log", () => {
    const log = fullLog(done({ rubric: "xlsx", score: 0.636, notes: ["D3 =B3*C3) gives #NAME?"] }));
    expect(log).toContain("Quality: 64% (xlsx rubric)");
    expect(log).toContain("D3 =B3*C3) gives #NAME?");
  });
});
