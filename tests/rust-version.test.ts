// One Rust version for CI and local builds. CI used to install the newest stable Rust, so a
// lint added in a new release could fail CI with no change in the code, before anyone could
// see it locally. rust-toolchain.toml (at the repository root, where cargo is run) names the
// version, and every workflow that installs Rust names the same one.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

const read = (p: string) => readFileSync(p, "utf8");
const toolchain = () => read("rust-toolchain.toml");
const channel = () => toolchain().match(/^channel\s*=\s*"([^"]+)"/m)?.[1];

describe("one Rust version everywhere", () => {
  it("rust-toolchain.toml names an exact version, with clippy and the ARM64 target", () => {
    expect(channel()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(toolchain()).toMatch(/components\s*=\s*\[[^\]]*"clippy"/);
    expect(toolchain()).toMatch(/targets\s*=\s*\[[^\]]*"aarch64-pc-windows-msvc"/);
  });

  it("every workflow that installs Rust installs that version", () => {
    const dir = ".github/workflows";
    const steps = readdirSync(dir).filter((f) => f.endsWith(".yml")).flatMap((f) => {
      const lines = read(path.join(dir, f)).split(/\r?\n/);
      return lines.flatMap((line, i) => (/uses:\s*dtolnay\/rust-toolchain@/.test(line) ? [{ f, next: lines.slice(i + 1, i + 3).join("\n") }] : []));
    });
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.next, s.f).toMatch(new RegExp(`toolchain:\\s*${channel()!.replace(/\./g, "\\.")}\\b`));
  });

  it("the README names the pinned version, not an open range", () => {
    expect(read("README.md")).toContain(`Rust ${channel()}`);
    expect(read("README.md")).not.toMatch(/Rust 1\.90\+/);
  });
});
