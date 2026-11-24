/**
 * The Lucide icon table (about 100 KB of path data) is needed only when a page or a game
 * names icons, and never on the first screen: it is kept out of the startup bundle and
 * loads by itself as soon as the module that needs it is in. Until it lands, a lookup
 * finds nothing and the callers fall back (a game draws a plain disc, an icons library
 * is written empty) — it is in place within the first moments of the app, long before
 * any answer can name an icon.
 */
export type IconTable = Record<string, string>;

let paths: IconTable = {};
let tags: Record<string, string[]> = {};
let ready: Promise<void> | null = null;
let landed = false;

/** The icon path data loaded so far (empty until the table has landed). */
export const iconPaths = (): IconTable => paths;
/** The meaning tags of the icons loaded so far (empty until the table has landed). */
export const iconTags = (): Record<string, string[]> => tags;
/** True once the table has landed: before that, a lookup finds nothing and a caller
 * that takes it for an answer (a fault reported, a circle drawn) would be wrong. */
export const isLoaded = (): boolean => landed;

/** Loads the icon table once and keeps it for the session. */
export function loadIcons(): Promise<void> {
  ready ??= import("./icons.generated.js").then((m) => { paths = m.ICON_PATHS; tags = m.ICON_TAGS; landed = true; });
  return ready;
}
