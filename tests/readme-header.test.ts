import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * People decide in the first screen whether MKMN is for them. The hardware it
 * needs and the fact that it is an independent project must be there, not at
 * the bottom of the page.
 */
describe("the top of the README", () => {
  const head = readFileSync("README.md", "utf8").split("\n").slice(0, 30).join("\n");

  it("names the hardware requirement near the top", () => {
    expect(head).toMatch(/Snapdragon X/);
    expect(head).toMatch(/Works only on Snapdragon X laptops with Windows 11/);
  });

  it("states the non-endorsement near the top", () => {
    expect(head).toMatch(/not (affiliated with|endorsed by) HUMAIN or Qualcomm/i);
  });
});
