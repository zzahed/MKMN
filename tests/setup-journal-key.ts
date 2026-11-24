/**
 * The harness journal is signed with the install's key, kept in its Config folder
 * (src/core/harness/journal.ts). The suite must never make or read that key in the real
 * profile, so every test file signs with a key of its own, in a temporary folder.
 */
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { useJournalKeyFile } from "../src/core/harness/journal";

useJournalKeyFile(path.join(mkdtempSync(path.join(os.tmpdir(), "mkmn-journal-key-")), "journal.key"));
