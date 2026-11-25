import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { translateError } from "../src/core/errors";
import { noPdfText } from "../src/core/attachments";
import { describePdfError } from "../src/core/pdf";
import { setupOutcomeView } from "../src/core/setupView";

/**
 * Phase 4 (docs/design/usability-audit.md, E1–E5): what a person reads when something goes
 * wrong says what happened and what to do, without engine words. Each error keeps its id.
 */
const ENGINE_WORDS = /GenieX failed|SDK error|-100000|MXFP4|GGUF|\bcontext\b|metadata|runtime|\brepo\b|precompiled|bundle/i;

describe("chat errors in plain words", () => {
  it.each([
    ["old-bundle", "cannot read metadata.json"],
    ["model-load", "Could not create context from binary"],
    ["npu-overflow", "ggml-hex: HTP0 buffer mapping failed"],
    ["npu-sdk-error", '{"code":-100000,"error":"SDKError(Unknown error)"}'],
    ["connection-reset", "fetch failed"],
    ["quant-missing", 'requested quant "Q4_K" not found'],
    ["no-chipset", "Requested chipset not available"],
    ["npu-busy", "another inference session is running"],
    ["ram-low", "Only 1.2 GB of RAM is free"],
  ])("%s keeps its id and reads without engine words", (id, raw) => {
    const e = translateError(raw);
    expect(e?.id).toBe(id);
    expect(`${e?.title} ${e?.fix}`).not.toMatch(ENGINE_WORDS);
  });

  it("the internal-error advice points at something that exists: restarting MKMN", () => {
    expect(translateError('{"code":-100000,"error":"SDKError(Unknown error)"}')?.fix).toContain("restart MKMN");
  });
});

describe("PDF messages", () => {
  it("a PDF without readable text says what to do, without 'vision model'", () => {
    const m = noPdfText("scan.pdf");
    expect(m).toContain("found no text it could read");
    // the same helper serves chat attachments and project files, so the advice fits both
    expect(m).toContain("even on scanned pages");
    expect(m).toContain("If you have the text elsewhere, paste it in");
    expect(m).not.toMatch(/vision model|selectable|\(a scan\?\)/);
  });

  it("an unknown PDF error gives a next step, and only a sanitized code", () => {
    const m = describePdfError("report.pdf", new Error("weird parser text with document words"));
    expect(m).toMatch(/Save it again as a PDF.*\(Code for support: other\)/);
    expect(m).not.toContain("document words");
  });
});

describe("setup and status", () => {
  it("setup names the engines for what they do", () => {
    const v = setupOutcomeView({ awaitingConfirm: false, steps: [{ id: "geniex", label: "AI engine for the NPU (Qualcomm GenieX)", state: "error" }] } as never);
    expect(v.description).toContain("AI engine for the NPU (Qualcomm GenieX)");
    const src = readFileSync("src/core/setup.ts", "utf8");
    expect(src).not.toContain("command-line runtime");
    expect(readFileSync("src/renderer/SetupScreen.tsx", "utf8")).toContain(">Try again</button>");
  });

  it("the status pill says what to do when it cannot read the AI's state", () => {
    const app = readFileSync("src/renderer/App.tsx", "utf8");
    expect(app).toContain("Can't check the AI right now. Try again, or restart MKMN if this continues.");
    expect(app).not.toContain("the status check keeps failing");
    expect(app).not.toContain("backend is not answering");
  });
});

describe("phase 4, round 2: no promise the code does not keep, and plain setup errors", () => {
  it("errors that may end in a failed state say MKMN tries, never that it will", () => {
    expect(translateError("ggml-hex: HTP0 buffer mapping failed")?.fix).toMatch(/^MKMN tries to restart the AI with less room/);
    expect(translateError("fetch failed")?.fix).toMatch(/^MKMN tries to restart it/);
  });

  it("first-run installer errors lead with what happened and what to do; details only for support", () => {
    const svc = readFileSync("src/core/setupService.ts", "utf8");
    for (const m of svc.match(/throw new Error\(`[^`]*`\)|throw new Error\("[^"]*"\)/g) ?? []) {
      const lead = m.split("Details for support")[0];
      expect(lead, m).not.toMatch(/SHA-256|geniex\.exe was not found|serve command|inference stays off|Open a new terminal|stopped with code/);
    }
  });

  it("settings paths use the › style and name tabs that exist", () => {
    const errs = readFileSync("src/core/errors.ts", "utf8") + readFileSync("src/core/setupService.ts", "utf8");
    expect(errs).not.toMatch(/Settings → |Settings, HUMAIN/);
  });
});

describe("setup says where each part can be installed later", () => {
  it("names the right Settings group for each failed part", async () => {
    const { installLater } = await import("../src/core/setupView");
    expect(installLater(["geniex"])).toBe("You can install it later in Settings › Developer.");
    expect(installLater(["voice-stt"])).toBe("You can install it later in Settings › Voice.");
    expect(installLater(["llama", "voice-tts"])).toBe("You can install them later: the graphics card and processor engine in Settings › Speed & memory, after choosing the graphics card or processor; read-aloud in Settings › Voice.");
  });

  it("the places named exist: Developer, Voice and Speed & memory are Settings groups", () => {
    const schema = readFileSync("src/shared/settingsSchema.ts", "utf8");
    for (const g of ["Developer", "Voice", "Speed & memory"]) expect(schema).toContain(`label: "${g}"`);
  });
});
