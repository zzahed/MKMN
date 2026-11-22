// One project id as a file name: every character outside A-Z, a-z, 0-9, ".", "_" and "-"
// becomes "_", so an id can never name a folder or reach outside the folder it is joined to.
// The index (<id>.json), the vectors (<id>.vectors) and the offloaded knowledge text
// (knowledge-<id>.txt) all use it, so removing a project finds exactly the files it wrote.
export const safeIdOf = (projectId: string): string => projectId.replace(/[^A-Za-z0-9._-]/g, "_");
