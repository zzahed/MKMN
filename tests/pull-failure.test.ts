import { describe, expect, it } from "vitest";
import { pullFailure } from "../src/core/errors";

describe("pullFailure", () => {
  it("does not tell a failed download to 'send the message again'", () => {
    const e = pullFailure("Error: SDKError (Unknown error) code -100000");
    expect(e.id).toBe("pull");
    expect(e.title).toBe("The download did not finish");
    expect(e.fix).not.toMatch(/message/i);
    expect(e.fix).toMatch(/-100000/);
  });
  it("keeps rules that make sense for a download", () => {
    expect(pullFailure("requested quant \"Q4_K\" not found").id).toBe("quant-missing");
  });
  it("falls back to download wording for unknown output", () => {
    expect(pullFailure("weird").fix).toMatch(/connection and disk space/);
  });
});
