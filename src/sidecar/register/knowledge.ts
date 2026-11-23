// The knowledge methods of the sidecar: a project's index (status, build, forget) and the
// optional multilingual search model whose vectors the build also makes. Moved out of
// main.ts as they were; they need nothing from main.ts but the dispatcher.
import * as path from "path";
import { journalDir } from "../../core/harness/journal";
import { filesHashOf } from "../../core/knowledge/index";
import { buildKnowledgeIndexNow, knowledgeDirOf, knowledgeIndexStatus, openKnowledgeIndex, removeKnowledgeFiles } from "../../core/knowledge/store";
import { openVectorIndex } from "../../core/knowledge/vectors";
import { installVectorModel, removeVectorModel, vectorEmbedder, vectorModelStatus } from "../../core/knowledge/vectorModel";
import type { SidecarDispatcher } from "../protocol";

export function registerKnowledge(dispatcher: SidecarDispatcher): void {
  // One project's knowledge index state: what the Project knowledge
  // screen shows. Observed from the store and this process's tracker, never a rebuild.
  dispatcher.register("knowledgeStatus", (projectId: string, filesHash: string) =>
    knowledgeIndexStatus(knowledgeDirOf(), String(projectId), String(filesHash ?? "")));

  // A deleted project's knowledge: its index and vectors in the knowledge folder, and the full
  // knowledge text a chat offloaded (the chats' offload folder, Workspace\harness\offload).
  // Returns the names of the files removed.
  dispatcher.register("knowledgeForget", (projectId: string) =>
    removeKnowledgeFiles(knowledgeDirOf(), path.join(journalDir(), "offload"), String(projectId)));

  // The index build, started by the Files panel's add/remove: the same
  // machine-tracked build a chat's retrieval would run, begun in the background here so
  // the FIRST chat already finds the index ready. The files ride whole from the renderer
  // (the project store lives in the webview); the build yields between files and its
  // progress (n of m) is read through knowledgeStatus.
  dispatcher.register("knowledgeBuild", async (projectId: string, files: unknown) => {
    const list = Array.isArray(files) ? files : [];
    const clean = list
      .map((f) => (f && typeof f === "object" ? (f as { id?: unknown; name?: unknown; content?: unknown }) : null))
      .filter((f): f is { id: string; name: string; content: string } =>
        !!f && typeof f.id === "string" && typeof f.name === "string" && typeof f.content === "string");
    const built = await buildKnowledgeIndexNow(knowledgeDirOf(), String(projectId), clean);
    // with the multilingual model installed, the project's vectors are made now too, so the
    // first question that needs them does not wait for them (a failure only logs: the chat
    // makes them itself, or falls back to the rewrite)
    if (built.state === "ready") void prepareVectors(String(projectId), clean);
    return built;
  });

  async function prepareVectors(projectId: string, files: { id: string; name: string; content: string }[]): Promise<void> {
    try {
      const embedder = await vectorEmbedder();
      if (!embedder || !files.length) return;
      const t = Date.now();
      const v = await openVectorIndex(knowledgeDirOf(), projectId, filesHashOf(files), openKnowledgeIndex(knowledgeDirOf(), projectId, files).sections(), embedder);
      if (v.source === "built") console.error(`[knowledge] vectors for ${v.count} sections made in ${Date.now() - t} ms`);
    } catch (e) {
      console.error(`[knowledge] the vectors could not be made: ${(e as Error).message}`);
    }
  }

  // The multilingual search model (Settings → Files & projects): installed only when the
  // person asks, from pinned files whose SHA-256 is checked before anything is replaced.
  dispatcher.register("vectorModelStatus", () => vectorModelStatus());
  dispatcher.register("vectorModelInstall", () => installVectorModel());
  dispatcher.register("vectorModelRemove", () => removeVectorModel());
}
