// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { HumainSettings } from "../src/renderer/HumainSettings";
import type { Settings } from "../src/shared/types";

afterEach(cleanup);

function setup(initial: Partial<Settings>, models: unknown[]) {
  const discover = vi.fn(async (provider: string) => provider === "node" ? models : []);
  window.mkmn = {
    humainKeySaved: async () => true,
    humainSaveKey: async () => {},
    humainModels: discover,
  } as unknown as typeof window.mkmn;
  function SettingsFixture() {
    const [settings, setSettings] = useState(initial as Settings);
    return <HumainSettings provider="node" settings={settings} save={async (patch) => setSettings((value) => ({ ...value, ...patch }))} />;
  }
  const view = render(<SettingsFixture />);
  expect(view.container.querySelector("#sec-humain-fuse")).toBeNull();
  const node = within(view.container.querySelector("#sec-humain-node")! as HTMLElement);
  return { node, discover };
}

const nodeModel = { id: "node-chat", node: { supported_formats: ["chat_completions"] } };

it("repairs an unsupported saved API when reconnecting to the same Node model", async () => {
  const { node } = setup({ humainNodeModel: "node-chat", humainNodeChatApi: "messages" }, [nodeModel]);
  fireEvent.click(node.getByRole("button", { name: "Test connection and load models" }));
  await node.findByText("Connected. 1 chat model(s) available.");
  expect((node.getByLabelText("Chat API") as HTMLSelectElement).value).toBe("chat/completions");
  expect((node.getByRole("option", { name: "Messages" }) as HTMLOptionElement).disabled).toBe(true);
});

it("keeps an unavailable saved model visible and labels the empty authenticated catalog", async () => {
  const { node } = setup({ humainNodeModel: "old-model" }, []);
  fireEvent.click(node.getByRole("button", { name: "Test connection and load models" }));
  await node.findByText("Connected. This key returned no selectable chat models.");
  expect((node.getByRole("option", { name: /no longer available/ }) as HTMLOptionElement).disabled).toBe(true);
});

it("clears a discovered catalog after removing a provider key", async () => {
  const { node, discover } = setup({}, [nodeModel]);
  fireEvent.click(node.getByRole("button", { name: "Test connection and load models" }));
  await node.findByRole("option", { name: "node-chat" });
  fireEvent.click(await node.findByRole("button", { name: "Remove key" }));
  await waitFor(() => expect(node.queryByRole("option", { name: "node-chat" })).toBeNull());
  expect(discover).toHaveBeenCalledWith("node");
  expect(screen.queryByText("Connected. 1 chat model(s) available.")).toBeNull();
});

it("lists only chat models (and ones of unknown kind) in the Fuse chat menu, never speech, embedding or video models", async () => {
  // ids and kinds from the Fuse model catalog matrix
  const catalog = [
    { id: "moonshotai/Kimi-K3", supported_reasoning_efforts: ["none", "low", "high", "max"] },
    { id: "tarjama/llmx-1.0", supported_reasoning_efforts: null },
    { id: "tarjama/arabicai-tts", supported_reasoning_efforts: null },
    { id: "tarjama/arabicai-stt", supported_reasoning_efforts: null },
    { id: "tarjama/arabicai-reranker", supported_reasoning_efforts: null },
    { id: "Qwen/Qwen3-Embedding-8B", supported_reasoning_efforts: null },
    { id: "Wan-AI/Wan2.2-T2V-A14B", supported_reasoning_efforts: null },
  ];
  window.mkmn = {
    humainKeySaved: async () => true, humainSaveKey: async () => {}, humainModels: vi.fn(async () => catalog),
  } as unknown as typeof window.mkmn;
  function Fixture() {
    const [settings, setSettings] = useState({} as Settings);
    return <HumainSettings provider="fuse" settings={settings} save={async (patch) => setSettings((v) => ({ ...v, ...patch }))} />;
  }
  const view = render(<Fixture />);
  const fuse = within(view.container.querySelector("#sec-humain-fuse")! as HTMLElement);
  fireEvent.click(fuse.getByRole("button", { name: "Test connection and load models" }));
  await fuse.findByRole("option", { name: "moonshotai/Kimi-K3" });
  const names = (fuse.getByLabelText("Chat model") as HTMLSelectElement).querySelectorAll("option");
  const ids = [...names].map((o) => o.value).filter(Boolean);
  expect(ids).toEqual(["moonshotai/Kimi-K3", "tarjama/llmx-1.0"]);
});

it("tells the truth about the Fuse chat API: the app's pipeline speaks Chat Completions, so the others are not offered", async () => {
  window.mkmn = {
    humainKeySaved: async () => true, humainSaveKey: async () => {}, humainModels: vi.fn(async () => []),
  } as unknown as typeof window.mkmn;
  function Fixture() {
    const [settings, setSettings] = useState({ humainFuseChatApi: "responses" } as Settings);
    return <HumainSettings provider="fuse" settings={settings} save={async (patch) => setSettings((v) => ({ ...v, ...patch }))} />;
  }
  const view = render(<Fixture />);
  const fuse = within(view.container.querySelector("#sec-humain-fuse")! as HTMLElement);
  const select = fuse.getByLabelText("Chat API") as HTMLSelectElement;
  expect(select.value).toBe("chat/completions");
  expect(select.disabled).toBe(true);
  expect(fuse.getByText(/MKMN's own pipeline/)).toBeTruthy();
});
