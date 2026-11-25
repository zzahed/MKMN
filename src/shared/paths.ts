/**
 * One directory layout, shared by the Rust host (src-tauri/src/paths.rs) and the Node
 * sidecar. An earlier layout had the sidecar write custom-models.json to %APPDATA%\MKMN while
 * the host read %LOCALAPPDATA%\MKMN\Config: the person's models were invisible. Every
 * consumer now asks this resolver instead of joining environment variables by hand.
 *
 * Nothing here creates a directory or reads a file; it only derives paths from the
 * environment it is given, so the caller can report where each base came from.
 */
import * as path from "node:path";

export type PathSource = "LOCALAPPDATA" | "APPDATA" | "USERPROFILE" | "cwd";

export interface MkmnPathSources {
  dataDir: PathSource;
  legacyDataDir: PathSource;
}

export interface MkmnPaths {
  /** %LOCALAPPDATA%\MKMN */
  dataDir: string;
  /** %LOCALAPPDATA%\MKMN\Config */
  configDir: string;
  /** settings.json, hardware.json and custom-models.json live here. */
  settingsFile: string;
  hardwareFile: string;
  customModelsFile: string;
  /** %LOCALAPPDATA%\MKMN\Workspace (conversations, artifacts, voice-models) */
  workspaceDir: string;
  /** %LOCALAPPDATA%\MKMN\Logs */
  logsDir: string;
  /** %LOCALAPPDATA%\MKMN\QAIRT: the QAIRT runtimes a native model runs against (pinned by the host, `qairt_runtime.rs`). */
  qairtDir: string;
  /** %LOCALAPPDATA%\MKMN\Embeddings: the multilingual search model the knowledge retrieval may use (installed only when the person asks). */
  embeddingsDir: string;
  /** %LOCALAPPDATA%\MKMN\RouterUsers: one small file per instance that uses another instance's router (RouterUsers). */
  routerUsersDir: string;
  /** %APPDATA%\MKMN: the earlier sidecar folder, read only for migration. */
  legacyDataDir: string;
  sources: MkmnPathSources;
}

/** The base folder named by `name`, or the user-profile equivalent when it is absent. */
function baseDir(
  env: NodeJS.ProcessEnv,
  name: "LOCALAPPDATA" | "APPDATA",
  profileSubdir: string,
): { dir: string; source: PathSource } {
  const explicit = env[name];
  if (explicit) return { dir: explicit, source: name };
  if (env.USERPROFILE) {
    return { dir: path.join(env.USERPROFILE, "AppData", profileSubdir), source: "USERPROFILE" };
  }
  // Last resort only: keep the paths usable in a stripped-down environment.
  return { dir: path.join(process.cwd(), "AppData", profileSubdir), source: "cwd" };
}

export function mkmnPaths(env: NodeJS.ProcessEnv = process.env): MkmnPaths {
  const local = baseDir(env, "LOCALAPPDATA", "Local");
  const roaming = baseDir(env, "APPDATA", "Roaming");
  const dataDir = path.join(local.dir, "MKMN");
  const configDir = path.join(dataDir, "Config");
  return {
    dataDir,
    configDir,
    settingsFile: path.join(configDir, "settings.json"),
    hardwareFile: path.join(configDir, "hardware.json"),
    customModelsFile: path.join(configDir, "custom-models.json"),
    workspaceDir: path.join(dataDir, "Workspace"),
    logsDir: path.join(dataDir, "Logs"),
    qairtDir: path.join(dataDir, "QAIRT"),
    embeddingsDir: path.join(dataDir, "Embeddings"),
    routerUsersDir: path.join(dataDir, "RouterUsers"),
    legacyDataDir: path.join(roaming.dir, "MKMN"),
    sources: { dataDir: local.source, legacyDataDir: roaming.source },
  };
}
