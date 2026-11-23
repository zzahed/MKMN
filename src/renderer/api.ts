import type { MkmnApi } from "../shared/api";

declare global {
  interface Window {
    mkmn: MkmnApi;
  }
}

export const api = (): MkmnApi => window.mkmn;

/**
 * Whether the renderer runs inside the Tauri WebView (as opposed to the
 * plain browser preview): the Tauri build has no office suite, so its export menu must
 * not offer formats only that suite can produce.
 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
