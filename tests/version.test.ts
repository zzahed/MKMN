import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A release is one version in every manifest. The installer reads package.json
 * and refuses to run when the others disagree, so this test fails on the same
 * mismatch before a 20-minute build does.
 */
describe("the v0.0.3-rc.3 candidate version", () => {
  const version = "0.0.3-rc.3";
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
  const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
  const cargo = /\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(readFileSync("src-tauri/Cargo.toml", "utf8"))?.[1];
  const lock = /\[\[package\]\]\r?\nname = "mkmn"\r?\nversion = "([^"]+)"/.exec(readFileSync("src-tauri/Cargo.lock", "utf8"))?.[1];
  const live = /\[string\]\$ExpectedVersion = "([^"]+)"/.exec(readFileSync("scripts/Live-Relaunch-Check.ps1", "utf8"))?.[1];

  it("is the same in every manifest and in the live check", () => {
    expect({ pkg, tauri, cargo, lock, live }).toEqual({ pkg: version, tauri: version, cargo: version, lock: version, live: version });
  });

  it("builds the pilot for device testing on manual dispatch", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toMatch(/^on:\s*\r?\n {2}workflow_dispatch:\s*\r?\n/m);
    expect(workflow).not.toMatch(/^ {2}push:|^\s*contents: write|gh release create/m);
    expect(workflow).toMatch(/Validate-Installer\.ps1" -Release/);
    expect(workflow).toContain("uses: actions/attest-build-provenance@");
    expect(workflow).toContain('--source-digest "$GITHUB_SHA"');
  });

  it("has release notes and a candidate pointer without claiming stable publication", () => {
    const notes = readFileSync(`docs/releases/RELEASE_NOTES_v${version}.md`, "utf8");
    expect(notes).toContain(`MKMN AI ${version}`);
    expect(readFileSync("docs/RELEASE-NOTES.md", "utf8")).toContain(`Current candidate: v${version}`);
    expect(readFileSync("README.md", "utf8")).toContain(`Release candidate: v${version}`);
    expect(readFileSync("docs/README.md", "utf8")).toContain(`Current candidate: v${version}`);
  });
});
