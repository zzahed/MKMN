import WebSocket from "ws";
import type { ChatEvent, ChatMessage, Settings } from "../shared/types";
import { cloudProviderOf, featureEnabled, modelServices, FUSE_EFFORTS, HUMAIN_LABEL, type HumainFeature, type HumainModel, type HumainProvider } from "../shared/humain";
import { HUMAIN_ORIGINS, humainEvents, HumainError, humainRequest } from "../core/humain";
import { humainVault } from "./humainVault";
import type { SidecarDispatcher } from "./protocol";

export function registerHumain(dispatcher: SidecarDispatcher, configDir: string, readConfig: () => Partial<Settings> = () => ({})) {
  const vault = humainVault(configDir);
  const requireFeature = (feature: HumainFeature) => {
    if (!featureEnabled(readConfig().humainDisabledFeatures, feature)) throw new Error("Enable this capability in HUMAIN Settings.");
  };
  const providerOf = (value: unknown): HumainProvider => {
    if (value !== "fuse" && value !== "node") throw new Error("Unknown HUMAIN provider.");
    return value;
  };
  const models = async (provider: HumainProvider, key: string, signal?: AbortSignal): Promise<HumainModel[]> => {
    const result = await (await humainRequest(provider, key, "GET", "/v1/models", undefined, signal)).json();
    if (!Array.isArray(result?.data)) throw new Error("HUMAIN returned an invalid model list.");
    return result.data.filter((m: HumainModel) => typeof m?.id === "string" && m.id);
  };
  dispatcher.register("humainKeySaved", (credential: HumainProvider) => vault.exists(credential));
  dispatcher.register("humainSaveKey", (credential: HumainProvider, key: string | null) => vault.save(credential, key));
  dispatcher.register("humainModels", async (name: unknown) => {
    const provider = providerOf(name);
    return models(provider, await vault.read(provider));
  });
  const realtimeEvents = new Map<string, unknown[]>();
  const realtime = new Map<string, WebSocket>();
  const opening = new Map<string, AbortController>();
  dispatcher.register("humainRealtimeOpen", async (session: string, model: string) => {
    if (opening.has(session) || realtime.has(session) || realtimeEvents.has(session) || opening.size + realtime.size >= 4) {
      throw new Error("Close an existing HUMAIN realtime connection first.");
    }
    requireFeature("realtime");
    const controller = new AbortController();
    opening.set(session, controller);
    let key: string;
    try {
      key = await vault.read("node");
      controller.signal.throwIfAborted();
      if (!(await models("node", key, controller.signal)).some((entry) => entry.id === model)) {
        throw new HumainError("node", 404, "model_not_found");
      }
      controller.signal.throwIfAborted();
    } finally {
      opening.delete(session);
    }
    const url = new URL("/v1/realtime", HUMAIN_ORIGINS.node);
    url.protocol = "wss:";
    url.searchParams.set("model", model);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` }, followRedirects: false,
      handshakeTimeout: 15_000, maxPayload: 4 * 1024 ** 2,
    });
    realtime.set(session, socket);
    const events: unknown[] = [];
    realtimeEvents.set(session, events);
    socket.on("message", (data) => {
      if (events.length >= 100) events.shift();
      try { events.push(JSON.parse(data.toString())); } catch { events.push({ type: "invalid_event" }); }
    });
    socket.on("close", (code) => {
      realtime.delete(session);
      events.push({ type: "closed", code });
      const expiry = setTimeout(() => realtimeEvents.delete(session), 30_000);
      expiry.unref();
    });
    return new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      // a refused upgrade is an HTTP answer: its status, code and request id are what the Node docs ask to report
      socket.once("unexpected-response", (_request, response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => { if (chunks.length < 64) chunks.push(c); });
        response.on("end", () => {
          let code = "";
          try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); code = body?.error?.code ?? body?.error?.type ?? ""; } catch { /* not JSON */ }
          const header = (name: string) => { const v = response.headers[name]; return typeof v === "string" ? v : ""; };
          reject(new HumainError("node", response.statusCode ?? 0, typeof code === "string" && !code.includes(key) ? code : "", header("x-request-id"), header("retry-after")));
          socket.terminate();
        });
      });
      socket.on("error", () => reject(new Error("HUMAIN Node realtime connection failed.")));
      socket.once("close", () => reject(new Error("HUMAIN Node closed the realtime connection.")));
    });
  });
  dispatcher.register("humainRealtimeEvents", (session: string) => realtimeEvents.get(session)?.splice(0) ?? []);
  dispatcher.register("humainRealtimeSend", (session: string, event: unknown) => {
    requireFeature("realtime");
    const socket = realtime.get(session);
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("Open a realtime connection first.");
    return new Promise<void>((resolve, reject) => socket.send(JSON.stringify(event), (error) =>
      error ? reject(new Error("HUMAIN Node could not send the event.")) : resolve()));
  });
  dispatcher.register("humainRealtimeClose", (session: string) => {
    opening.get(session)?.abort();
    realtime.get(session)?.close();
  });
  dispatcher.register("humainOperation", async (name: unknown, method: string, path: string, body: unknown, upload?: { field: string; filename: string; base64: string; mime: string }) => {
    const provider = providerOf(name);
    const route = operationRoute(provider, method, path);
    const feature = operationFeature(path);
    if (feature) requireFeature(feature);
    if (body && typeof body === "object" && "tools" in body && Array.isArray(body.tools)
      && body.tools.some((tool) => typeof tool?.type === "string" && tool.type.startsWith("web_search"))) requireFeature("search");
    if (upload) {
      if (route !== "inference" || method !== "POST" || typeof upload.base64 !== "string" || upload.base64.length > 70_000_000) {
        throw new Error("Choose a supported upload under 50 MB.");
      }
      const form = new FormData();
      for (const [field, value] of Object.entries(body ?? {})) form.append(field, typeof value === "string" ? value : JSON.stringify(value));
      form.append(upload.field, new Blob([new Uint8Array(Buffer.from(upload.base64, "base64"))], { type: upload.mime }), upload.filename);
      body = form;
    }
    const key = route === "public" ? "" : await vault.read(provider);
    const response = await humainRequest(provider, key, method, path, body ?? undefined);
    const type = response.headers.get("content-type")?.split(";")[0] ?? "";
    if (type === "text/event-stream") {
      const events: unknown[] = [];
      for await (const event of humainEvents(response)) {
        if (events.length >= 12_000) throw new Error("The response exceeds the API console event limit.");
        events.push(event);
      }
      return { type: "json", value: events };
    }
    if (response.status === 204) return { type: "json", value: null };
    if (type.includes("json") && !type.includes("jsonl") && !type.includes("ndjson")) return { type: "json", value: await response.json() };
    const bytes: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > 64 * 1024 ** 2) throw new Error("The response exceeds the 64 MB download limit.");
          bytes.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    return { type: "file", mime: type || "application/octet-stream", base64: Buffer.concat(bytes, total).toString("base64") };
  });

  return async (id: string, settings: Partial<Settings>, messages: ChatMessage[], signal: AbortSignal, send: (event: ChatEvent) => void) => {
    const start = performance.now();
    let first: number | null = null;
    let finish: string | null = null;
    let tokens = 0;
    let outputTokens: number | undefined;
    let estimatedUsd: number | undefined;
    const sources = new Map<string, string>();
    function cite(annotation: any) {
      const url = annotation?.url_citation?.url ?? annotation?.url;
      if (typeof url === "string" && /^https?:\/\/[^\s<>()[\]]+$/.test(url)) {
        const title = annotation?.url_citation?.title ?? annotation?.title;
        sources.set(url, typeof title === "string" ? title.replace(/[[\]\r\n]/g, " ").trim() : "");
      }
    }
    let promptTokens: number | undefined;
    let answered = false;
    const emit = (type: "thinking" | "answer", text: unknown) => {
      if (typeof text !== "string" || !text) return;
      if (type === "answer") answered = true;
      first ??= (performance.now() - start) / 1000;
      send({ id, type, text });
    };
    try {
      const provider = cloudProviderOf(settings.humainMode);
      if (!provider) throw new Error("Choose a HUMAIN provider in Settings.");
      signal.throwIfAborted();
      const model = settings[provider === "fuse" ? "humainFuseModel" : "humainNodeModel"];
      if (typeof model !== "string" || !model) throw new Error(`Choose a chat model for ${HUMAIN_LABEL[provider]} in Settings.`);
      const key = await vault.read(provider);
      const available = (await models(provider, key, signal)).find((item) => item.id === model);
      if (!available) throw new HumainError(provider, 404, "model_not_found");
      const services = modelServices(provider, available);
      if (services.length && !services.includes("chat")) throw new Error("Choose a chat model in HUMAIN settings.");
      const endpoint = settings[provider === "node" ? "humainNodeChatApi" : "humainFuseChatApi"];
      const searchMode = provider === "fuse" && featureEnabled(settings.humainDisabledFeatures, "search") ? settings.humainChatSearch : "off";
      const search = searchMode === "search" || searchMode === "research";
      let searched = false;
      const api = search ? "responses" : endpoint === "responses" || endpoint === "messages" ? endpoint : "chat/completions";
      const formats = available.node?.supported_formats;
      const format = api === "chat/completions" ? "chat_completions" : api;
      if (provider === "node" && formats?.length && !formats.includes(format)) {
        throw new Error("This Node model does not support the selected chat API. Choose a supported API in HUMAIN settings.");
      }
      const stream = available.node?.supports_streaming !== false;
      const system = messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content : "").join("\n\n");
      const turns = messages.filter((m) => m.role !== "system");
      const body = api === "responses" ? {
        model, stream, store: false, instructions: system,
        input: turns.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((p) => p.type === "image_url"
          ? { type: "input_image", image_url: p.image_url.url } : { type: "input_text", text: p.text }) : m.content })),
      } : api === "messages" ? {
        model, stream, system, max_tokens: 4096,
        messages: turns.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((p) => {
          if (p.type === "text") return p;
          const data = /^data:([^;]+);base64,(.+)$/.exec(p.image_url.url);
          return { type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url: p.image_url.url } };
        }) : m.content })),
      } : { model, stream, messages };
      const effort = settings.humainFuseEffort;
      const reasoning = provider === "fuse" && FUSE_EFFORTS.some((level) => level !== "default" && level === effort)
        ? api === "responses" ? { reasoning: { effort } }
          : api === "messages" ? { output_config: { effort } } : { reasoning_effort: effort }
        : {};
      const request = { ...body, ...reasoning, ...(search ? {
        tools: [{ type: "web_search" }],
        instructions: [system, searchMode === "research"
          ? "Synthesize findings, distinguish confirmed facts from uncertainty, and cite sources for factual claims."
          : "Cite the sources used in your answer."].filter(Boolean).join("\n\n"),
      } : {}) };
      const response = await humainRequest(provider, key, "POST", `/v1/${api}`, request, signal);
      const appliedEffort = response.headers.get("x-fuse-reasoning-effort");
      if (appliedEffort && FUSE_EFFORTS.some((level) => level === appliedEffort)) {
        send({ id, type: "notice", text: `Fuse thinking effort: ${appliedEffort}` });
      }
      send({ id, type: "notice", text: `${HUMAIN_LABEL[provider]} · ${model}` });
      const usage = (u: any) => {
        if (!u) return;
        const output = u.completion_tokens ?? u.output_tokens;
        if (Number.isSafeInteger(output) && output >= 0) tokens = outputTokens = output;
        promptTokens = u.prompt_tokens ?? u.input_tokens ?? promptTokens;
      };
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        for await (const { data } of humainEvents(response)) {
          if (data.error || data.type === "error" || data.type === "response.failed") throw new Error("HUMAIN reported an error during generation.");
          if (api === "responses") {
            if (data.type === "response.reasoning_summary_text.delta") emit("thinking", data.delta);
            if (search && data.type === "response.web_search_call.completed") searched = true;
            if (search && data.type === "response.output_text.annotation.added") cite(data.annotation);
            if (data.type === "response.output_text.delta") emit("answer", data.delta);
            if (data.type === "response.completed" || data.type === "response.incomplete") {
              usage(data.response?.usage);
              if (search) for (const item of data.response?.output ?? []) {
                if (item.type === "web_search_call" && item.status === "completed") searched = true;
                for (const part of item.content ?? []) for (const annotation of part.annotations ?? []) cite(annotation);
              }
              finish = data.type === "response.completed" ? "stop" : data.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : null;
            }
          } else if (api === "messages") {
            emit("answer", data.delta?.text);
            emit("thinking", data.delta?.thinking);
            usage(data.usage ?? data.message?.usage);
            if (data.delta?.stop_reason) finish = data.delta.stop_reason === "max_tokens" ? "length" : "stop";
          } else {
            const choice = data.choices?.[0];
            emit("thinking", choice?.delta?.reasoning_content);
            emit("answer", choice?.delta?.content);
            finish = choice?.finish_reason ?? finish;
            usage(data.usage);
          }
        }
      } else {
        const data = await response.json();
        if (data.error) throw new Error("HUMAIN reported an error during generation.");
        usage(data.usage);
        if (api === "responses") {
          for (const item of data.output ?? []) {
            if (search && item.type === "web_search_call" && item.status === "completed") searched = true;
            for (const part of item.content ?? []) {
              if (part.type === "output_text") emit("answer", part.text);
              if (search) for (const annotation of part.annotations ?? []) cite(annotation);
            }
          }
        } else if (api === "messages") {
          for (const part of data.content ?? []) if (part.type === "text") emit("answer", part.text);
        } else {
          emit("thinking", data.choices?.[0]?.message?.reasoning_content);
          emit("answer", data.choices?.[0]?.message?.content);
        }
        finish = data.choices?.[0]?.finish_reason ?? (data.stop_reason === "max_tokens" ? "length" : "stop");
      }
      if (!answered) {
        // the provider's request id is what its support asks for (Node and Fuse docs)
        const requestId = [response.headers.get("x-request-id"), response.headers.get("x-fuse-request-id")].find((v) => v && /^[\w.:-]{1,100}$/.test(v));
        throw new Error(`HUMAIN returned no answer text for this chat (finish reason ${finish ?? "none"}${requestId ? `, request ${requestId}` : ""}).`);
      }
      if (response.headers.get("content-type")?.includes("text/event-stream") && finish === null) throw new Error("The HUMAIN stream ended before the response completed.");
      if (sources.size) {
        emit("answer", "\n\n**Sources**\n" + [...sources].map(([url, title]) => `- [${title || new URL(url).hostname}](${url})`).join("\n"));
      } else if (search) {
        send({ id, type: "notice", text: searched ? "Fuse completed the search and returned no source citations." : "Fuse did not confirm that hosted search ran." });
      }
      const rates = settings.humainUsdRates as Settings["humainUsdRates"];
      const rate = rates?.[`${provider}:${model}`];
      if (rate && Number.isFinite(rate.input) && rate.input >= 0 && Number.isFinite(rate.output) && rate.output >= 0
        && outputTokens !== undefined && typeof promptTokens === "number" && Number.isSafeInteger(promptTokens) && promptTokens >= 0
        && !model.endsWith("/auto") && !model.startsWith("@preset/")) {
        estimatedUsd = promptTokens * (rate.input / 1e6) + outputTokens * (rate.output / 1e6);
      }
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof HumainError ? error.message : error instanceof SyntaxError ? "HUMAIN returned an invalid response." : error instanceof Error ? error.message : "HUMAIN request failed.";
        send({ id, type: "error", error: { id: "humain", title: message, fix: "Check the selected model and connection in HUMAIN settings.", raw: message } });
        return;
      }
    }
    send({ id, type: "done", stats: { finish, ttftSec: first, tokPerSec: null, tokens, promptTokens, estimatedUsd, totalSec: (performance.now() - start) / 1000 } });
  };
}

const id = "[A-Za-z0-9_.~%-]+";
const end = "(?:\\?[^#]*)?$";
const common = [
  "GET /v1/models", "POST /v1/(?:chat/completions|responses|messages|images/generations|embeddings|rerank|systemone)",
];
const fuse = [
  "GET /v1/limits",
  "POST /v1/(?:completions|messages/count_tokens|systemone/batch)",
  `(?:GET|DELETE) /v1/responses/${id}`,
  "POST /v1/(?:videos|files|batches|audio/(?:speech|transcriptions|voice|generate|clone))",
  "GET /v1/(?:files|batches|audio/voices)",
  `GET /v1/audio/voice/${id}`,
  `GET /v1/(?:images|videos|files)/${id}/content`,
  `GET /v1/(?:videos|files|batches)/${id}`,
  `DELETE /v1/(?:videos|files|audio/voice)/${id}`,
  `POST /v1/batches/${id}/cancel`,
];
export function operationRoute(provider: HumainProvider, method: string, path: string): "public" | "inference" {
  if (typeof path !== "string" || /[\\\s#]/.test(path) || path.split("?")[0].split("/").some((part) => {
    try { const decoded = decodeURIComponent(part); return decoded === "." || decoded === ".." || /[\\/]/.test(decoded); }
    catch { return true; }
  })) throw new Error("Invalid HUMAIN endpoint.");
  const matches = (routes: string[]) => routes.some((r) => new RegExp(`^(?:${r})${end}`).test(`${method} ${path}`));
  if ((provider === "node" && matches(["GET /healthz"])) || (provider === "fuse" && matches(["GET /v1/openapi\\.json"]))) return "public";
  if (matches(common) || (provider === "fuse" && matches(fuse))) return "inference";
  throw new Error("This method and endpoint are unavailable for the selected HUMAIN connection.");
}

export function operationFeature(path: string): HumainFeature | undefined {
  const parts = path.split("?")[0].split("/");
  switch (parts[2]) {
    case "images": return "images";
    case "videos": return "video";
    case "audio":
      return parts[3] === "transcriptions" ? "transcription" : parts[3] === "speech" ? "speech" : "voices";
    case "embeddings": return "embeddings";
    case "rerank": return "rerank";
    case "systemone": return "systemone";
    case "files": return "files";
    case "batches": return "batch";
    case "chat":
    case "completions":
    case "responses":
    case "messages": return "advancedText";
    default: return undefined;
  }
}

/**
 * What a chat on HUMAIN Fuse needs to run through the app's pipeline: the saved key, the chosen chat model
 * and its context window, read from Fuse's own model list (so a model no longer available fails here, named).
 */
export async function fuseConnection(configDir: string, config: Partial<Settings>, signal?: AbortSignal): Promise<{ key: string; model: string; maxModelLen: number | null }> {
  const model = config.humainFuseModel;
  if (typeof model !== "string" || !model) throw new Error(`Choose a chat model for ${HUMAIN_LABEL.fuse} in Settings.`);
  const key = await humainVault(configDir).read("fuse");
  const list = await (await humainRequest("fuse", key, "GET", "/v1/models", undefined, signal)).json();
  const found: HumainModel | undefined = Array.isArray(list?.data) ? list.data.find((m: HumainModel) => m?.id === model) : undefined;
  if (!found) throw new HumainError("fuse", 404, "model_not_found");
  const services = modelServices("fuse", found);
  if (services.length && !services.includes("chat")) throw new Error("Choose a chat model in HUMAIN settings.");
  const len = (found as { max_model_len?: unknown }).max_model_len;
  return { key, model, maxModelLen: typeof len === "number" && len > 0 ? len : null };
}

/**
 * Fuse's hosted web search, for a chat that runs through the app's pipeline. The search exists only on the
 * Responses and Messages APIs (the pipeline speaks Chat Completions), so it is asked first, over Responses,
 * and what it found rides the turn as context with numbered links. Null when the setting is off.
 */
export async function fuseSearchContext(o: { key: string; model: string; query: string; mode: unknown; signal?: AbortSignal; fetcher?: typeof fetch }): Promise<{ context: string; links: [string, string][] } | null> {
  if (o.mode !== "search" && o.mode !== "research") return null;
  const research = o.mode === "research";
  const request = {
    model: o.model, stream: false, store: false, tools: [{ type: "web_search" }], input: o.query,
    instructions: research
      ? "Search the web for this request. Report the findings in detail, separate confirmed facts from uncertainty, and keep figures and dates exact."
      : "Search the web for this request and report the relevant findings briefly, with figures and dates exact.",
  };
  const response = await humainRequest("fuse", o.key, "POST", "/v1/responses", request, o.signal, o.fetcher);
  const body = await response.json();
  const texts: string[] = [];
  const links = new Map<string, string>();
  // only the answer's own text: a reasoning item holds the model's guesses, not what the search found
  for (const item of body?.output ?? []) for (const part of item?.type === "message" ? item?.content ?? [] : []) {
    if (part?.type !== "output_text" || typeof part?.text !== "string") continue;
    texts.push(part.text);
    // Fuse leaves annotations empty on this path (its documentation): the links are the URLs in the text
    for (const url of part.text.match(/https?:\/\/[^\s<>()[\]"'`]+/g) ?? []) {
      const clean = url.replace(/[.,;:!?]+$/, "");
      if (!links.has(clean)) links.set(clean, "");
    }
    for (const a of part?.annotations ?? []) {
      const url = a?.url_citation?.url ?? a?.url;
      if (typeof url === "string" && /^https?:\/\/[^\s<>()[\]]+$/.test(url) && !links.get(url)) {
        const title = a?.url_citation?.title ?? a?.title;
        links.set(url, typeof title === "string" ? title.replace(/[[\]\r\n]/g, " ").trim() : "");
      }
    }
  }
  const findings = texts.join("\n").trim();
  if (!findings) return null;
  const numbered = [...links].map(([url, title], i) => `[${i + 1}] ${title || new URL(url).hostname} ${url}`);
  const context = [
    "Web search results for this request, found just now by HUMAIN Fuse. They are all you have: you cannot open pages or search again, so answer directly from them and never describe browsing. Cite a source as [n] where you use it.",
    findings,
    ...(numbered.length ? ["Sources:", ...numbered] : []),
  ].join("\n\n");
  return { context, links: [...links] };
}

/** The links a web search found, listed by the app under the answer (a model asked to list them, seen live, did not). */
export function sourcesBlock(links: [string, string][]): string {
  if (!links.length) return "";
  return "\n\n**Sources**\n" + links.map(([url, title]) => `- [${title || new URL(url).hostname}](${url})`).join("\n");
}
