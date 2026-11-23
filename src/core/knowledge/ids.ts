// One project id as a file name: every character outside A-Z, a-z, 0-9, ".", "_" and "-"
// becomes "_", so an id can never name a folder or reach outside the folder it is joined to.
// The index (<id>.json), the vectors (<id>.vectors) and the offloaded knowledge text
// (knowledge-<id>.txt) all use it, so removing a project finds exactly the files it wrote.
export const safeIdOf = (projectId: string): string => projectId.replace(/[^A-Za-z0-9._-]/g, "_");

/** The name the chat offloads a project's full knowledge text under (".txt" is added by the
 *  offload store); the delete removes the file of the same name. */
export const knowledgeOffloadName = (projectId: string): string => `knowledge-${safeIdOf(projectId)}`;

// How many times each project's knowledge was deleted in this process. A build or a vector job
// notes the count when it is asked for and checks it again before each write: a project deleted
// while its index was still being built, or its vectors still being made, gets nothing written
// back (the job would otherwise leave the deleted project's text on disk for good).
const forgotten = new Map<string, number>();
const forgetKey = (dir: string | null, projectId: string): string => `${dir ?? "memory"}\u0000${projectId}`;

/** The number of deletes of this project's knowledge so far: a job compares it before writing. */
export const forgetCountOf = (dir: string | null, projectId: string): number => forgotten.get(forgetKey(dir, projectId)) ?? 0;

/** Marks this project's knowledge deleted: every job begun before now writes nothing more. */
export function markKnowledgeForgotten(dir: string | null, projectId: string): void {
  forgotten.set(forgetKey(dir, projectId), forgetCountOf(dir, projectId) + 1);
}
