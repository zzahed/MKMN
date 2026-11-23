import { describe, it } from "vitest";

/** Windows-only behaviour (PowerShell, DPAPI, backslash paths). Skips elsewhere with a reason in the report. */
export const isWindows = process.platform === "win32";
export const describeWindows = describe.skipIf(!isWindows);
export const itWindows = it.skipIf(!isWindows);

/** Turn a relative path into the repo's canonical forward-slash form, for comparisons that must hold on every OS. */
export const posixRel = (p: string): string => p.split(/[\\/]/).join("/");
