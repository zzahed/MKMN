import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { GENIEX_INDEX_URL, geniexReleaseNewer, parseGeniexIndex, parseWindowsInstaller, resolveGeniexRelease } from "../src/core/geniexRelease";
import { installGeniex } from "../src/core/setupService";

/**
 * Qualcomm publishes GenieX releases as a feed: `index.json` names `latest_stable`, and
 * `manifest-<tag>.json` lists every asset with its url, size and sha256. MKMN downloaded the unversioned
 * `geniex-cli.exe` and judged "newer" from its Last-Modified date ("GenieX has no version feed").
 */

const INDEX = {
  schema_version: 1, updated_at: "2026-11-12T17:54:19Z", latest_stable: "v0.11.0", latest_prerelease: "v0.11.0-rc.1",
  versions: [{ tag: "v0.11.0", is_prerelease: false, released_at: "2026-11-12T17:54:18Z", manifest: "manifest-v0.11.0.json" }]
};
const MANIFEST = {
  schema_version: 1, tag: "v0.11.0", is_prerelease: false, released_at: "2026-11-12T17:54:18Z", llama_sha: "93cf73", htp_signed: true,
  assets: [
    { name: "geniex-cli-linux-arm64-v0.11.0.tar.gz", url: "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/geniex-cli-linux-arm64-v0.11.0.tar.gz", size: 117020386, sha256: "b80fbc2149784a5e01d2c48d4700a459d83ec340b1f28e9351eaa4549fb3d9f8", kind: "cli-archive", platform: "linux", arch: "arm64" },
    { name: "geniex-cli-setup-windows-arm64-v0.11.0.exe", url: "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/geniex-cli-setup-windows-arm64-v0.11.0.exe", size: 71154113, sha256: "8470b8a1d51ae3a41040c831c76ec7e9e5fed72c51b49ef8a0f1bf2580cfb57f", kind: "cli-installer", platform: "windows", arch: "arm64" },
    { name: "geniex-cli-setup-windows-arm64-v0.11.0.exe.sha256", url: "https://example.invalid/x.sha256", size: 109, sha256: "a9979b79f0484759f2403934daaef9de0895cf2af934b858dd9a439dfa25c972", kind: "sha256", platform: "windows", arch: "arm64" }
  ]
};
const WIN = { tag: "v0.11.0", url: MANIFEST.assets[1].url, sha256: MANIFEST.assets[1].sha256, size: 71154113 };

describe("the GenieX release feed", () => {
  it("reads the latest stable tag and the Windows ARM64 installer of a manifest", () => {
    expect(parseGeniexIndex(INDEX)).toEqual({ latestStable: "v0.11.0", manifest: "manifest-v0.11.0.json" });
    expect(parseWindowsInstaller(MANIFEST)).toEqual(WIN);
    expect(parseGeniexIndex({})).toBeNull();
    expect(parseWindowsInstaller({ ...MANIFEST, assets: [MANIFEST.assets[0]] })).toBeNull();
    // a hash that is not 64 hex characters, or a URL off https, is not an installer to trust
    expect(parseWindowsInstaller({ ...MANIFEST, assets: [{ ...MANIFEST.assets[1], sha256: "abc" }] })).toBeNull();
    expect(parseWindowsInstaller({ ...MANIFEST, assets: [{ ...MANIFEST.assets[1], url: "http://x/y.exe" }] })).toBeNull();
  });

  it("an installed version is behind the feed only by its version number", () => {
    expect(geniexReleaseNewer("v0.11.0", "v0.10.0")).toBe(true);
    expect(geniexReleaseNewer("v0.11.0", "v0.11.0")).toBe(false);
    expect(geniexReleaseNewer("v0.11.0", "0.11.1")).toBe(false);
    expect(geniexReleaseNewer("v0.12.0", "v0.9.5-alpha.1")).toBe(true);
    // what `geniex --version` really prints (this PC)
    expect(geniexReleaseNewer("v0.11.0", "GenieX CLI Version:     v0.10.0\nQAIRT Runtime Version:  2.50\nLlamaCPP Runtime Hash:  93cf736")).toBe(true);
    expect(geniexReleaseNewer("v0.11.0", "GenieX CLI Version:     v0.11.0\nQAIRT Runtime Version:  2.50")).toBe(false);
    expect(geniexReleaseNewer("v0.11.0", null)).toBeNull();
    expect(geniexReleaseNewer(null, "v0.11.0")).toBeNull();
  });

  it("resolves the installer through the index, then the manifest it names", async () => {
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify(String(u).endsWith("index.json") ? INDEX : MANIFEST), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await resolveGeniexRelease(fetchFn)).toEqual(WIN);
    expect(urls).toEqual([GENIEX_INDEX_URL, "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/manifest-v0.11.0.json"]);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await resolveGeniexRelease(down)).toBeNull();
    const mismatched = (async (u: string) => Response.json(
      u.endsWith("index.json") ? INDEX : { ...MANIFEST, tag: "v0.10.0" },
    )) as typeof fetch;
    await expect(resolveGeniexRelease(mismatched)).rejects.toThrow(/v0\.10\.0.*v0\.11\.0/);
  });
});

const deps = (over: any = {}) => ({
  download: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ code: 0, output: "" })),
  exists: (p: string) => p.endsWith("geniex.exe"),
  env: { LOCALAPPDATA: "C:\\L" } as any,
  tmpDir: tmpdir() + "/mkmn-release-test",
  signature: async () => ({ status: "Valid", signer: "CN=QUALCOMM Inc., O=QUALCOMM Inc., L=San Diego, S=California, C=US" }),
  sha256: async () => WIN.sha256,
  probe: async () => "GenieX CLI Version: v0.11.0",
  ...over,
});

describe("installGeniex with the published release", () => {
  it("checks the version of the executable the installer left behind", async () => {
    await expect(installGeniex(deps({ release: WIN, probe: async () => "v0.10.0" }), () => undefined)).rejects.toThrow(/0\.10\.0.*v0\.11\.0/);
    await expect(installGeniex(deps({ release: WIN, probe: async () => null }), () => undefined)).rejects.toThrow(/working serve command/);
  });
  it("refuses an installed GenieX below the minimum even when no release tag was compared", async () => {
    await expect(installGeniex(deps({ release: null, probe: async () => "GenieX CLI Version: v0.10.0" }), () => undefined)).rejects.toThrow(/too old for MKMN.*found v0\.10\.0, needs v0\.11\.0 or newer/);
  });
  it("downloads the versioned installer and runs it when its SHA-256 is the published one", async () => {
    const d = deps({ release: WIN });
    await installGeniex(d, () => undefined);
    expect(d.download).toHaveBeenCalledWith(WIN.url, expect.stringContaining(WIN.sha256), expect.any(Function));
    expect(d.run).toHaveBeenCalledOnce();
  });

  it("never runs a download whose SHA-256 is not the published one, even signed", async () => {
    const d = deps({ release: WIN, sha256: async () => "0".repeat(64) });
    await expect(installGeniex(d, () => undefined)).rejects.toThrow(/does not match the SHA-256 Qualcomm published for GenieX v0\.11\.0/);
    expect(d.run).not.toHaveBeenCalled();
  });
});
