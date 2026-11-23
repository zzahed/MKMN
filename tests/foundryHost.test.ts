import { describe, expect, it } from "vitest";
import { parseCatalogJson, parseJsonOutput } from "../src/core/foundry";
import { FoundryHost, parseCacheJson, parseCacheList, parseStatusJson, type FoundryRunner } from "../src/core/foundryHost";

const CATALOG_JSON = JSON.stringify({
  models: [
    {
      alias: "deepseek-r1-1.5b",
      id: "deepseek-r1-distill-qwen-1.5b-qnn-npu:2",
      displayName: "deepseek-r1-distill-qwen-1.5b-qnn-npu",
      type: "Chat",
      device: "Npu",
      fileSizeMb: 1556,
      cached: false
    },
    {
      alias: "qwen3-0.6b",
      id: "qwen3-0.6b-generic-cpu:4",
      displayName: "qwen3-0.6b-generic-cpu",
      type: "Chat",
      device: "Cpu",
      fileSizeMb: 593,
      cached: true
    }
  ]
});

const TABLE = `Alias         Device  Task   File Size  License     Model ID
-----------------------------------------------------------------------
phi-4         GPU     chat   8.37 GB    MIT         Phi-4-cuda-gpu
              CPU     chat   10.16 GB   MIT         Phi-4-generic-cpu
`;

describe("Foundry Local JSON output", () => {
  it("finds the JSON object in a command's coloured output", () => {
    expect(parseJsonOutput('\x1b[32m{"models":[{"alias":"a"}]}\x1b[0m')).toEqual({ models: [{ alias: "a" }] });
    expect(parseJsonOutput("downloading…\n[1,2,3]\ndone")).toEqual([1, 2, 3]);
    expect(parseJsonOutput("no json here")).toBeNull();
    expect(parseJsonOutput("{broken")).toBeNull();
  });

  it("reads the 0.12 catalog shape, with title-case devices and the cached flag", () => {
    const v = parseCatalogJson(JSON.parse(CATALOG_JSON));
    expect(v.map((x) => `${x.alias}/${x.device}/${x.task}/${x.cached}`)).toEqual([
      "deepseek-r1-1.5b/NPU/Chat/false",
      "qwen3-0.6b/CPU/Chat/true"
    ]);
    expect(v[1].modelId).toBe("qwen3-0.6b-generic-cpu:4");
    expect(v[0].sizeGB).toBeCloseTo(1.52, 2);

    const variants = parseCatalogJson({
      variants: [{ alias: "qwen3-0.6b", variantId: "qwen3-0.6b-generic-gpu:2", type: "Chat", device: "Gpu", fileSizeMb: 1024, cached: false }]
    });
    expect(variants[0]).toMatchObject({ alias: "qwen3-0.6b", modelId: "qwen3-0.6b-generic-gpu:2", device: "GPU", task: "Chat", sizeGB: 1 });
  });

  it("reads `cache list -o json`, and says null for anything else so the table is used", () => {
    const rows = parseCacheJson({ models: [{ alias: "qwen3-0.6b", device: "Cpu", fileSizeMb: 593, loaded: true, cached: true }] });
    expect(rows).toEqual([{ alias: "qwen3-0.6b", device: "CPU", sizeGB: 0.58, loaded: true }]);
    expect(parseCacheJson({ nothing: true })).toBeNull();
    expect(parseCacheJson("nope")).toBeNull();
  });

  it("reads `server status -o json` (webUrls) as an address", () => {
    expect(parseStatusJson({ running: true, state: "ready", webUrls: ["http://127.0.0.1:50798"] })).toBe("http://127.0.0.1:50798");
    expect(parseStatusJson({ webUrls: ["https://localhost:5000"] })).toBe("http://127.0.0.1:5000");
    expect(parseStatusJson({ running: false })).toBeNull();
    expect(parseStatusJson({ webUrls: [42] })).toBeNull();
  });

  it("reads the text cache table's Loaded column, both marks", () => {
    const rows = parseCacheList(`Alias        Size     Device  Loaded
phi-4        8.4 GB   GPU     ●
qwen3-0.6b   593 MB   CPU     ○`);
    expect(rows.map((r) => `${r.alias}/${r.device}/${r.loaded}`)).toEqual(["phi-4/GPU/true", "qwen3-0.6b/CPU/false"]);
    expect(rows[1].sizeGB).toBeCloseTo(0.58, 2);
  });
});

describe("FoundryHost catalog and cache", () => {
  it("asks for the catalog as JSON, caches it, and refreshes on demand", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "model list -o json") return { code: 0, out: CATALOG_JSON };
      return { code: 1, out: "unexpected" };
    };
    const host = new FoundryHost(run);
    expect((await host.catalog())?.map((v) => v.alias)).toEqual(["deepseek-r1-1.5b", "qwen3-0.6b"]);
    await host.catalog();
    expect(calls.filter((c) => c === "model list -o json")).toHaveLength(1);
    await host.catalog(true);
    expect(calls.filter((c) => c === "model list -o json")).toHaveLength(2);
  });

  it("falls back to the text table when this version has no JSON output", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "model list -o json") return { code: 1, out: "error: unrecognized option '-o'" };
      if (args.join(" ") === "model list") return { code: 0, out: TABLE };
      return { code: 0, out: "" };
    };
    const host = new FoundryHost(run);
    expect((await host.catalog())?.map((v) => `${v.alias}/${v.device}`)).toEqual(["phi-4/GPU", "phi-4/CPU"]);
    expect(calls).toContain("model list");
  });

  it("does not invent a catalog when neither form can be read", async () => {
    const host = new FoundryHost(async () => ({ code: 1, out: "nothing" }));
    expect(await host.catalog()).toBeNull();
  });

  it("reads the cache as JSON and falls back to its table", async () => {
    const jsonRun: FoundryRunner = async (args) =>
      args.join(" ") === "cache list -o json"
        ? { code: 0, out: JSON.stringify({ models: [{ alias: "deepseek-r1-7b", device: "Npu", fileSizeMb: 3802, loaded: false }] }) }
        : { code: 1, out: "" };
    expect(await new FoundryHost(jsonRun).cached()).toEqual([{ alias: "deepseek-r1-7b", device: "NPU", sizeGB: 3.71, loaded: false }]);

    const tableRun: FoundryRunner = async (args) => {
      if (args.join(" ") === "cache list") return { code: 0, out: "Alias   Size    Device  Loaded\nphi-4   8.4 GB  GPU     ●" };
      return { code: 1, out: "" };
    };
    expect(await new FoundryHost(tableRun).cached()).toEqual([{ alias: "phi-4", device: "GPU", sizeGB: 8.4, loaded: true }]);
  });
});

describe("FoundryHost status line", () => {
  it("an installed 0.x Foundry Local is named by its version, never \"not installed\" (0.12.1 read as not installed)", async () => {
    const run: FoundryRunner = async (args) => (args[0] === "--version" ? { code: 0, out: "0.12.1\r\n" } : { code: 0, out: "" });
    const host = new FoundryHost(run);
    expect(await host.discover()).toBe(true);
    expect(host.statusLine()).toBe("0.12.1 · idle");
  });

  it("an undiscovered Foundry Local is not installed", () => {
    expect(new FoundryHost(async () => ({ code: 1, out: "" })).statusLine()).toBe("not installed");
  });
});

describe("FoundryHost server", () => {
  it("reads the address from JSON status and restarts a daemon that does not answer", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      calls.push(args.join(" "));
      const cmd = args.join(" ");
      if (cmd === "server start") return { code: 0, out: "Starting the Foundry Local server…" };
      if (cmd === "server status") return { code: 0, out: "running (no address printed)" };
      if (cmd === "server status -o json") return { code: 0, out: '{"running":true,"webUrls":["http://127.0.0.1:5001"]}' };
      if (cmd === "server restart") return { code: 0, out: "restarted" };
      return { code: 1, out: "" };
    };
    let healthChecks = 0;
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith("/v1/models")) {
        healthChecks++;
        return new Response("{}", { status: healthChecks === 1 ? 503 : 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const host = new FoundryHost(run, () => undefined, fetchFn);
    expect(await host.serviceUrl()).toBe("http://127.0.0.1:5001");
    expect(calls).toContain("server restart");
    expect(healthChecks).toBe(2);
  });

  it("waits for a daemon that says ready before its port answers, instead of restarting it (Foundry 0.12.1, measured)", async () => {
    // measured: `foundry server start` printed "Server ready (http://127.0.0.1:51814)" in 6 s and the
    // port refused the first health check, then answered 2 s later; a restart only repeated the race and the switch
    // from GenieX to a Foundry model failed with "the Foundry Local server did not answer"
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "server start") return { code: 0, out: "■ Starting Foundry Local server\r\n● success: Server ready (http://127.0.0.1:51814)\r\n" };
      if (args[0] === "service") return { code: 2, out: "Unknown command: 'service'" };
      return { code: 0, out: "" };
    };
    let refused = 3;
    const fetchFn = (async () => {
      if (refused-- > 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const host = new FoundryHost(run, () => undefined, fetchFn);
    host.readyPollMs = 1;
    expect(await host.serviceUrl()).toBe("http://127.0.0.1:51814");
    expect(calls).not.toContain("server restart");
  });

  it("a port that never opens is given up after the wait, then restarted once", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "server") return { code: 0, out: "Server ready (http://127.0.0.1:51814)" };
      return { code: 2, out: "Unknown command: 'service'" };
    };
    const fetchFn = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const host = new FoundryHost(run, () => undefined, fetchFn);
    host.readyPollMs = 1;
    host.readyWaitMs = 20;
    await expect(host.serviceUrl()).rejects.toThrow(/did not answer/);
    expect(calls.filter((c) => c === "server restart")).toHaveLength(1);
  });

  it("names the log lines when the server never answers", async () => {
    const run: FoundryRunner = async (args) => {
      const cmd = args.join(" ");
      if (cmd === "server logs -n 20") return { code: 0, out: "daemon: port 5000 is already in use" };
      if (cmd.startsWith("server")) return { code: 0, out: "running" };
      if (cmd.startsWith("service")) return { code: 2, out: "Unknown command: 'service'" };
      return { code: 1, out: "" };
    };
    const fetchFn = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const host = new FoundryHost(run, () => undefined, fetchFn);
    await expect(host.serviceUrl()).rejects.toThrow(/port 5000 is already in use/);
  });

  it("reads what Foundry says is loaded from its endpoint when it serves one", async () => {
    const run: FoundryRunner = async (args) =>
      args.join(" ") === "server status" ? { code: 0, out: "running on http://127.0.0.1:5099" } : { code: 0, out: "" };
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith("/openai/loadedmodels")) return new Response(JSON.stringify(["gemma-3-4b"]), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const host = new FoundryHost(run, () => undefined, fetchFn);
    expect(await host.serviceUrl()).toBe("http://127.0.0.1:5099");
    expect(await host.loadedModels()).toEqual(["gemma-3-4b"]);
  });

  it("reads loaded model names given as objects, not only strings", async () => {
    const run: FoundryRunner = async (args) =>
      args.join(" ") === "server status" ? { code: 0, out: "running on http://127.0.0.1:5099" } : { code: 0, out: "" };
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith("/openai/loadedmodels")) return new Response(JSON.stringify([{ modelId: "phi-4-mini:2" }, { id: "qwen3-0.6b" }, {}]), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const host = new FoundryHost(run, () => undefined, fetchFn);
    await host.serviceUrl();
    expect(await host.loadedModels()).toEqual(["phi-4-mini:2", "qwen3-0.6b"]);
  });
});

describe("FoundryHost models", () => {
  it("forwards download progress lines and reports a failure's last words", async () => {
    const lines: string[] = [];
    const run: FoundryRunner = async (args, opts) => {
      expect(args).toEqual(["model", "download", "qwen3-0.6b"]);
      opts?.onLine?.("Downloading 38%");
      opts?.onLine?.("Downloading 100%");
      return { code: 0, out: "done" };
    };
    expect(await new FoundryHost(run).download("qwen3-0.6b", { onLine: (l) => lines.push(l) })).toEqual({ ok: true });
    expect(lines).toEqual(["Downloading 38%", "Downloading 100%"]);

    const broken: FoundryRunner = async () => ({ code: 1, out: "starting\nnetwork timeout" });
    expect(await new FoundryHost(broken).download("phi-4")).toEqual({ ok: false, error: "starting | network timeout" });

    const ctl = new AbortController();
    ctl.abort();
    const stopped: FoundryRunner = async () => ({ code: 130, out: "killed" });
    expect(await new FoundryHost(stopped).download("phi-4", { signal: ctl.signal })).toEqual({ ok: false, error: "cancelled" });
  });

  it("unloads a model before removing it from Foundry's cache", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      calls.push(args.join(" "));
      return { code: 0, out: args[1] === "remove" ? "Removed 'phi-4' from the cache." : "" };
    };
    expect(await new FoundryHost(run).remove("phi-4")).toEqual({ ok: true, message: "Removed 'phi-4' from the cache." });
    expect(calls).toEqual(["model unload phi-4", "cache remove phi-4 --force"]);
  });

  it("leaves an idle daemon alone, and unloads a model Foundry loaded outside the app", async () => {
    const idle = new FoundryHost(async (args) =>
      args.join(" ") === "cache list -o json"
        ? { code: 0, out: JSON.stringify({ models: [{ alias: "qwen3-0.6b", device: "Cpu", fileSizeMb: 593, loaded: false }] }) }
        : { code: 0, out: "" });
    expect(await idle.unloadIfLoaded()).toBe(false);

    const calls: string[] = [];
    const busy = new FoundryHost(async (args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "cache list -o json")
        return { code: 0, out: JSON.stringify({ models: [
          { alias: "phi-4", device: "Gpu", fileSizeMb: 8602, loaded: true },
          { alias: "qwen3-0.6b", device: "Cpu", fileSizeMb: 593, loaded: false }
        ] }) };
      return { code: 0, out: "" };
    });
    expect(await busy.unloadIfLoaded()).toBe(true);
    expect(calls).toContain("model unload phi-4");
    expect(calls).toContain("server stop");
  });

  it("requires a loaded-model inventory and refuses a handoff when a model remains loaded", async () => {
    const unknown = new FoundryHost(async () => ({
      code: 0, out: JSON.stringify({ models: [{ alias: "phi-4" }] }),
    }));
    await expect(unknown.releaseForHandoff()).rejects.toThrow(/could not report/);

    let loaded = true;
    const persistent = new FoundryHost(async (args) => args[0] === "cache"
      ? { code: 0, out: JSON.stringify({ models: [{ alias: "phi-4", device: "Npu", loaded }] }) }
      : { code: 1, out: "busy" });
    await expect(persistent.releaseForHandoff()).rejects.toThrow(/still has.*phi-4/);
    loaded = false;
    await expect(persistent.releaseForHandoff()).resolves.toBeUndefined();
  });

  it("distinguishes a missing CLI from an installed CLI that failed to answer", async () => {
    const absent = new FoundryHost(async () => ({ code: 1, out: "", notFound: true }));
    expect(await absent.discover()).toBe(false);
    expect(absent.missing).toBe(true);
    const broken = new FoundryHost(async () => ({ code: 1, out: "failed" }));
    expect(await broken.discover()).toBe(false);
    expect(broken.missing).toBe(false);
  });
});
