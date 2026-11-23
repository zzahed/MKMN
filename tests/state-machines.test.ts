import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canTransition, isMachineState, machineDefinition, nextState, STATE_MACHINES } from "../src/shared/stateMachines";
// The scan is plain ESM so the docs generator and this test look with the same eyes.
import { scanLifecycles } from "../scripts/lib/lifecycle-scan.mjs";

/**
 * One registry describes the server, voice and build lifecycles. The generator
 * writes the TypeScript types, the Rust enum and the docs page from it. These
 * tests keep the registry honest and stop a committed output from drifting away
 * from the registry that explains it.
 */

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

interface State {
  id: string;
  label: string;
  description: string;
}
interface Transition {
  from: string;
  to: string;
  event: string;
  description: string;
}
interface Machine {
  id: string;
  title: string;
  description: string;
  initial: string;
  rust?: string;
  states: State[];
  transitions: Transition[];
  rejects?: [string, string][];
}
interface Registry {
  version: number;
  machines: Machine[];
}

const registry = JSON.parse(read("src/shared/stateMachines.json")) as Registry;

describe("the state machine registry", () => {
  it("names every machine once and gives it a title, description and real initial state", () => {
    const ids = registry.machines.map((machine) => machine.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["server", "voice", "build"]));
    for (const machine of registry.machines) {
      expect(machine.title.trim(), `${machine.id} title`).not.toBe("");
      expect(machine.description.trim(), `${machine.id} description`).not.toBe("");
      expect(machine.states.map((state) => state.id), `${machine.id} initial`).toContain(machine.initial);
    }
  });

  it("has unique, lower-snake states with a label and a meaning", () => {
    for (const machine of registry.machines) {
      const ids = machine.states.map((state) => state.id);
      expect(new Set(ids).size, `${machine.id} states`).toBe(ids.length);
      for (const state of machine.states) {
        expect(state.id, `${machine.id} state id`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(state.label.trim(), `${machine.id}.${state.id} label`).not.toBe("");
        expect(state.description.trim(), `${machine.id}.${state.id} meaning`).not.toBe("");
      }
    }
  });

  it("only names known states in transitions and never gives one state two meanings for one event", () => {
    for (const machine of registry.machines) {
      const states = new Set(machine.states.map((state) => state.id));
      const edges = new Set<string>();
      const events = new Set<string>();
      for (const transition of machine.transitions) {
        expect(states.has(transition.from), `${machine.id}: ${transition.from}`).toBe(true);
        expect(states.has(transition.to), `${machine.id}: ${transition.to}`).toBe(true);
        expect(transition.event, `${machine.id} event`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(transition.description.trim(), `${machine.id}: ${transition.from} -> ${transition.to}`).not.toBe("");
        expect(edges.has(`${transition.from}/${transition.to}/${transition.event}`), `${machine.id}: duplicate edge`).toBe(false);
        edges.add(`${transition.from}/${transition.to}/${transition.event}`);
        expect(events.has(`${transition.from}/${transition.event}`), `${machine.id}: ${transition.event} is ambiguous from ${transition.from}`).toBe(false);
        events.add(`${transition.from}/${transition.event}`);
      }
    }
  });

  it("never both allows and rejects the same jump, and always has a way back to stopped for the server", () => {
    for (const machine of registry.machines) {
      const allowed = new Set(machine.transitions.map((transition) => `${transition.from}/${transition.to}`));
      const states = new Set(machine.states.map((state) => state.id));
      for (const [from, to] of machine.rejects ?? []) {
        expect(states.has(from) && states.has(to), `${machine.id}: reject ${from} -> ${to}`).toBe(true);
        expect(allowed.has(`${from}/${to}`), `${machine.id}: ${from} -> ${to} is both allowed and rejected`).toBe(false);
      }
    }
    const server = registry.machines.find((machine) => machine.id === "server")!;
    for (const state of server.states.map((entry) => entry.id)) {
      const stops = server.transitions.some((transition) => transition.from === state && transition.event === "stop");
      expect(stops, `server.${state} can stop`).toBe(true);
    }
  });
});

describe("the state machine helpers", () => {
  it("reports the registry definition for a machine", () => {
    const server = machineDefinition("server");
    expect(server.initial).toBe("stopped");
    expect(server.states.map((state) => state.id)).toContain("busy");
  });

  it("recognises real states and refuses typos", () => {
    expect(isMachineState("voice", "transcribing")).toBe(true);
    expect(isMachineState("voice", "transcribingg")).toBe(false);
    expect(isMachineState("build", "unresolved")).toBe(true);
    expect(isMachineState("build", "error")).toBe(false);
  });

  it("allows every registered move and staying put, and refuses every listed impossible jump", () => {
    // The test walks the whole registry, so it calls the helpers the way a data-driven screen would.
    const allows = canTransition as (id: string, from: string, to: string) => boolean;
    for (const machine of registry.machines) {
      for (const transition of machine.transitions) {
        expect(allows(machine.id, transition.from, transition.to), `${machine.id}: ${transition.from} -> ${transition.to}`).toBe(true);
      }
      for (const state of machine.states) {
        expect(allows(machine.id, state.id, state.id), `${machine.id}: ${state.id} stays`).toBe(true);
      }
      for (const [from, to] of machine.rejects ?? []) {
        expect(allows(machine.id, from, to), `${machine.id}: ${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("follows a named event and returns nothing when the event does not apply", () => {
    expect(nextState("server", "failed", "restart")).toBe("restarting");
    expect(nextState("server", "failed", "idle_release")).toBeUndefined();
    expect(nextState("voice", "transcribing", "text")).toBe("thinking");
    expect(nextState("build", "running", "finished_with_problem")).toBe("unresolved");
  });
});

describe("the generated state machine files", () => {
  it("keeps the generated TypeScript in step with the registry", () => {
    const generatedIds = Object.keys(STATE_MACHINES).sort();
    expect(generatedIds).toEqual(registry.machines.map((machine) => machine.id).sort());
    for (const machine of registry.machines) {
      const generated = STATE_MACHINES[machine.id as keyof typeof STATE_MACHINES];
      expect(generated.initial).toBe(machine.initial);
      expect(generated.states.map((state) => state.id)).toEqual(machine.states.map((state) => state.id));
      expect(generated.transitions.map((transition) => `${transition.from}/${transition.event}/${transition.to}`))
        .toEqual(machine.transitions.map((transition) => `${transition.from}/${transition.event}/${transition.to}`));
    }
  });

  it("writes every machine, state and event into the Rust enum and the docs page", () => {
    const rust = read("src-tauri/src/state_machine.rs");
    const docs = read("docs/state-machines.md");
    expect(rust).toMatch(/Do not edit/);
    expect(docs).toMatch(/Do not edit/);
    for (const machine of registry.machines) {
      expect(docs).toContain(`## ${machine.title} (\`${machine.id}\`)`);
      expect(docs).toContain(`Initial state: \`${machine.initial}\``);
      for (const state of machine.states) {
        expect(docs, `${machine.id}.${state.id} in docs`).toContain(`\`${state.id}\``);
      }
      expect(docs).toContain(machine.description);
    }
    const server = registry.machines.find((machine) => machine.id === "server")!;
    for (const state of server.states) {
      expect(rust, `server.${state.id} in Rust`).toContain(`"${state.id}"`);
    }
  });

  it("runs the generator check and finds nothing stale", () => {
    const output = execFileSync(process.execPath, ["scripts/generate-state-machines.mjs", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60000,
    });
    expect(output).toContain(`state machines are up to date (${registry.machines.length} machines)`);
  });

  it("finds nothing stale in a Windows checkout, where the files have CRLF line endings", () => {
    // GitHub's Windows runners check files out with CRLF; the content is the same
    const files = ["src/shared/stateMachines.generated.ts", "src-tauri/src/state_machine.rs", "docs/state-machines.md"]
      .map((f) => join(ROOT, f));
    const original = files.map((f) => readFileSync(f));
    try {
      for (const [i, f] of files.entries()) writeFileSync(f, original[i].toString("utf8").replace(/\r?\n/g, "\r\n"));
      const output = execFileSync(process.execPath, ["scripts/generate-state-machines.mjs", "--check"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60000,
      });
      expect(output).toContain("state machines are up to date");
    } finally {
      for (const [i, f] of files.entries()) writeFileSync(f, original[i]);
    }
  });
});

/**
 * The inventory names every lifecycle the scan can find. A lifecycle that is neither a
 * registered machine nor listed in src/shared/lifecycles.json fails these tests, so a new
 * state/status/phase type cannot slip in without saying how it is handled.
 */
interface LifecycleEntry {
  id: string;
  classification: string;
  scan: string[];
}
const lifecycles = JSON.parse(read("src/shared/lifecycles.json")) as { lifecycles: LifecycleEntry[] };

describe("the lifecycle inventory", () => {
  const scan = scanLifecycles(ROOT);
  const entries = lifecycles.lifecycles;

  it("finds lifecycles in the source at all", () => {
    expect(scan.length).toBeGreaterThan(5);
  });

  it("covers every lifecycle the scan finds, exactly once", () => {
    const covered = new Map<string, string>();
    for (const entry of entries) {
      for (const key of entry.scan) {
        expect(covered.has(key), `${key} is listed by both ${covered.get(key)} and ${entry.id}`).toBe(false);
        covered.set(key, entry.id);
      }
    }
    const missing = scan.filter((key: string) => !covered.has(key));
    expect(missing, `these lifecycles are not in src/shared/lifecycles.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists no lifecycle key the scan can no longer find", () => {
    const found = new Set(scan);
    const stale: string[] = [];
    for (const entry of entries) for (const key of entry.scan) if (!found.has(key)) stale.push(`${entry.id}: ${key}`);
    expect(stale, `these inventory keys no longer exist in the source: ${stale.join(", ")}`).toEqual([]);
  });

  it("gives every registry machine a migrated entry", () => {
    const migrated = new Set(entries.filter((entry) => entry.classification === "migrated").map((entry) => entry.id));
    for (const machine of registry.machines) {
      expect(migrated.has(machine.id), `the registry machine ${machine.id} has no migrated inventory entry`).toBe(true);
    }
  });

  it("classifies every entry as migrated, not-migrated or not-a-machine", () => {
    for (const entry of entries) {
      expect(["migrated", "not-migrated", "not-a-machine"]).toContain(entry.classification);
    }
  });

  it("writes the inventory into the docs page", () => {
    const docs = read("docs/state-machines.md");
    expect(docs).toContain("## Every lifecycle in the program");
    for (const entry of entries) {
      expect(docs, `${entry.id} in the docs inventory`).toContain(`\`${entry.id}\``);
    }
  });
});
