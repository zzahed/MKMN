import { describe, it, expect, vi } from "vitest";
import { batteryFromHost, batteryPercent, createCachedPowerReader, createHostFirstBatteryReader, type BatteryReading } from "../src/core/battery";
import { NPU_MEMORY_RETRY_MS, createNpuMemoryReader, npuReadingFromHost, type NpuReading } from "../src/core/perf";

/**
 * The host-native readings (src-tauri/src/battery.rs, the monitor's PDH sample) that
 * replaced the PowerShell probes: the selectors accept a host payload and refuse
 * anything else (the fallback then answers), unknown stays null end to end, and the
 * power read used by the request selection is cached for 30 s.
 */

describe("npuReadingFromHost — the host's PDH sample", () => {
  it("a host answer becomes a reading, with unknown kept null (never idle)", () => {
    expect(npuReadingFromHost({ util: 87.5, memBytes: null })).toEqual({ util: 87.5, memBytes: null, pidUtil: {}, pidMem: {}, sets: [], samples: 0 });
    // the host withholds the reading (no counters, invalid PDH status): unknown stays null
    expect(npuReadingFromHost({ util: null, memBytes: null })!.util).toBeNull();
    expect(npuReadingFromHost({ util: null, memBytes: null })!.memBytes).toBeNull();
  });

  it("there is never an invented NPU memory figure", () => {
    expect(npuReadingFromHost({ util: 3, memBytes: null })!.memBytes).toBeNull();
    expect(npuReadingFromHost({ util: 3, memBytes: -1 })!.memBytes).toBeNull();
    expect(npuReadingFromHost({ util: 3, memBytes: "12" })!.memBytes).toBeNull();
  });

  it("the host's PDH memory reading is kept", () => {
    expect(npuReadingFromHost({ util: 4, memBytes: 12_730_368 })!.memBytes).toBe(12_730_368);
  });

  it("a stale host answer keeps util null (never an old number shown as the load now)", () => {
    // The host withholds a reading it considers stale (its monitor rested, the cache is
    // old): it answers null util with a reason. That is still a host reading, so the
    // sidecar keeps the unknown instead of falling back or showing an old number.
    const r = npuReadingFromHost({ util: null, memBytes: null, reason: "stale" });
    expect(r).not.toBeNull();
    expect(r!.util).toBeNull();
  });

  it("a refused or malformed host answer is not a reading: the caller falls back", () => {
    expect(npuReadingFromHost(null)).toBeNull();
    expect(npuReadingFromHost(undefined)).toBeNull();
    expect(npuReadingFromHost("error")).toBeNull();
    expect(npuReadingFromHost({})).toBeNull(); // no util field: not a host reading
  });
});

describe("the NPU memory reader — the host first, PowerShell only when it has no figure", () => {
  const r = (memBytes: number | null) => ({ util: 5, memBytes, pidUtil: {}, pidMem: {}, sets: [], samples: 0 } as NpuReading);

  it("a host memory figure is used without spawning PowerShell", async () => {
    const host = vi.fn(async () => r(12_000_000));
    const powershell = vi.fn(async () => r(1));
    const read = createNpuMemoryReader({ host, powershell });
    for (let i = 0; i < 5; i++) expect((await read()).memBytes).toBe(12_000_000);
    expect(powershell).not.toHaveBeenCalled();
  });

  it("no figure from the host or PowerShell: PowerShell is asked once, not at every point", async () => {
    const host = vi.fn(async () => r(null));
    const powershell = vi.fn(async () => r(null));
    const read = createNpuMemoryReader({ host, powershell });
    for (let i = 0; i < 5; i++) expect((await read()).memBytes).toBeNull();
    expect(powershell).toHaveBeenCalledTimes(1);
  });

  it("a figure only PowerShell finds (counters the host cannot read): PowerShell answers the points the host has none for", async () => {
    const host = vi.fn(async () => r(null));
    const powershell = vi.fn(async () => r(7));
    const lines: string[] = [];
    const read = createNpuMemoryReader({ host, powershell, log: (l) => lines.push(l) });
    expect((await read()).memBytes).toBe(7);
    expect((await read()).memBytes).toBe(7);
    expect(host).toHaveBeenCalledTimes(2);
    expect(powershell).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(1);
  });

  it("one host miss (a timeout under load) does not hand the rest of the session to PowerShell", async () => {
    let calls = 0;
    const host = vi.fn(async () => (calls++ === 0 ? null : r(12_000_000)));
    const powershell = vi.fn(async () => r(7));
    const read = createNpuMemoryReader({ host, powershell });
    expect((await read()).memBytes).toBe(7);
    expect((await read()).memBytes).toBe(12_000_000);
    expect((await read()).memBytes).toBe(12_000_000);
    expect(powershell).toHaveBeenCalledTimes(1);
  });

  it("no host reading at all: every point still carries PowerShell's utilization, never an empty reading", async () => {
    const host = vi.fn(async () => null);
    const powershell = vi.fn(async () => r(null));
    const read = createNpuMemoryReader({ host, powershell });
    for (let i = 0; i < 3; i++) expect((await read()).util).toBe(5);
    expect(powershell).toHaveBeenCalledTimes(3);
  });

  it("a failed PowerShell read keeps the host's reading", async () => {
    const read = createNpuMemoryReader({ host: async () => r(null), powershell: async () => { throw new Error("no PowerShell"); } });
    expect((await read()).util).toBe(5);
  });

  it("a failed PowerShell read is not taken as 'no figure': it is asked again after a pause (the Codex review on #78)", async () => {
    let now = 0;
    let failing = true;
    const host = vi.fn(async () => r(null));
    const powershell = vi.fn(async () => { if (failing) throw new Error("timed out"); return r(7); });
    const read = createNpuMemoryReader({ host, powershell, now: () => now });
    expect((await read()).memBytes).toBeNull(); // the first read timed out
    now += NPU_MEMORY_RETRY_MS - 1;
    expect((await read()).memBytes).toBeNull(); // not hammered during the pause
    expect(powershell).toHaveBeenCalledTimes(1);
    failing = false;
    now += 1;
    expect((await read()).memBytes).toBe(7); // recovered: its figure is used
    expect(powershell).toHaveBeenCalledTimes(2);
  });
});

describe("batteryFromHost — the host's native IOCTLs", () => {
  it("a host answer becomes the shared reading, figures kept", () => {
    const r = batteryFromHost({ present: true, onMains: false, discharging: true, remainingMWh: 20760, fullMWh: 45890, dischargeMW: 8500, voltageMV: 12870, at: 1000 }, 2000);
    expect(r).toEqual({ present: true, onMains: false, discharging: true, remainingMWh: 20760, fullMWh: 45890, dischargeMW: 8500, voltageMV: 12870, at: 2000 });
    expect(batteryPercent(r)).toBe(45.2);
  });

  it("no battery (present: false) reads as the same no-battery shape parseBattery makes", () => {
    expect(batteryFromHost({ present: false, onMains: null, discharging: null, remainingMWh: null, fullMWh: null, dischargeMW: null, voltageMV: null, at: 1000 }, 2000)).toEqual({
      present: false, onMains: false, discharging: false, remainingMWh: 0, fullMWh: 0, dischargeMW: 0, voltageMV: 0, at: 2000
    });
  });

  it("on the mains the draw is 0 whatever the rate field says", () => {
    expect(batteryFromHost({ present: true, onMains: true, discharging: false, remainingMWh: 100, fullMWh: 200, dischargeMW: 0, voltageMV: 1, at: 1 }).dischargeMW).toBe(0);
  });

  it("a refused host answer (null) is not a reading", () => {
    expect(batteryFromHost(null).present).toBe(false);
  });
});

describe("the request selection's power reader — one read per 30 s", () => {  it("at most one power read per 30 s", async () => {
    let now = 1000;
    const read = vi.fn(async () => ({ present: true, onMains: false, discharging: true, remainingMWh: 1, fullMWh: 2, dischargeMW: 3, voltageMV: 4, at: now } as BatteryReading));
    const reader = createCachedPowerReader(read, { now: () => now });
    await reader();
    await reader();
    await reader();
    expect(read).toHaveBeenCalledTimes(1);
    now += 29_999;
    await reader();
    expect(read).toHaveBeenCalledTimes(1); // still inside the 30 s
    now += 1;
    await reader();
    expect(read).toHaveBeenCalledTimes(2); // past it, one fresh read
  });

  it("a failed read is cached too, so a dead source is not hammered", async () => {
    let now = 0;
    const read = vi.fn(async () => { throw new Error("no source"); });
    const reader = createCachedPowerReader(read, { now: () => now });
    expect(await reader()).toBeNull();
    expect(await reader()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    now += 31_000;
    expect(await reader()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("the battery reader — the host first, the fallback when it is wrong", () => {
  const noBattery = { present: false, onMains: false, discharging: false, remainingMWh: 0, fullMWh: 0, dischargeMW: 0, voltageMV: 0, at: 1 } as BatteryReading;
  const realBattery = { present: true, onMains: false, discharging: true, remainingMWh: 25574, fullMWh: 71040, dischargeMW: 6774, voltageMV: 15189, at: 2 } as BatteryReading;

  it("a host 'no battery' the fallback contradicts gives the fallback's reading, and the choice sticks for the session", async () => {
    const host = vi.fn(async () => noBattery);
    const fallback = vi.fn(async () => realBattery);
    const lines: string[] = [];
    const read = createHostFirstBatteryReader({ host, fallback, log: (l) => lines.push(l) });
    const r = await read();
    expect(r?.present).toBe(true);
    expect(r?.dischargeMW).toBe(6774);
    expect(r?.remainingMWh).toBe(25574);
    expect(lines.some((l) => l.includes("host says no battery, fallback found one"))).toBe(true);
    // the choice holds for the session: the host is not asked again
    await read();
    await read();
    expect(host).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(3);
  });

  it("a host that refuses (null) with a battery found by the fallback sticks to the fallback too", async () => {
    const host = vi.fn(async () => null);
    const fallback = vi.fn(async () => realBattery);
    const read = createHostFirstBatteryReader({ host, fallback });
    expect((await read())?.present).toBe(true);
    await read();
    expect(host).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("a real host 'no battery' the fallback confirms keeps the host", async () => {
    const host = vi.fn(async () => noBattery);
    const fallback = vi.fn(async () => noBattery);
    const read = createHostFirstBatteryReader({ host, fallback });
    expect((await read())?.present).toBe(false);
    await read();
    await read();
    expect(host).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(1); // decided once, not re-asked every read
  });

  it("a real host reading is used as is, without spawning the fallback", async () => {
    const host = vi.fn(async () => realBattery);
    const fallback = vi.fn(async () => noBattery);
    const read = createHostFirstBatteryReader({ host, fallback });
    const r = await read();
    expect(r?.present).toBe(true);
    expect(r?.dischargeMW).toBe(6774);
    expect(fallback).not.toHaveBeenCalled();
  });
});
