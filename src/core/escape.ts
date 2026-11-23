/**
 * Escaping shared by the code that writes text into another language: a regular expression, a markdown table, a script.
 * Each one escapes every character that has a meaning there, the escape character first.
 */

/** A string matched literally inside a regular expression. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A markdown table cell: a backslash or a pipe in the text cannot end the cell or escape its border. */
export const mdCell = (s: string): string => s.replace(/[\\|]/g, "\\$&");

/** A value as a JavaScript literal that can sit inside an HTML <script>: no "</script>" or "<!--" can end the element early. */
export const scriptJson = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/**
 * An SVG with nothing that runs: the named elements (with what they hold) and every event attribute are removed, and the
 * removal is repeated until nothing changes, so a tag split around a removed one (`<scr<script></script>ipt>`) cannot come back together.
 */
export function stripActive(svg: string, tags: string[] = ["script"]): string {
  const names = tags.join("|");
  const pair = new RegExp(`<(${names})\\b[\\s\\S]*?<\\/\\1\\b[^>]*>`, "gi");
  const lone = new RegExp(`<\\/?(?:${names})\\b[^>]*>`, "gi");
  const on = /[\s/]on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
  let out = svg;
  for (let prev = ""; prev !== out;) {
    prev = out;
    out = out.replace(pair, "").replace(lone, "").replace(on, "");
  }
  return out;
}
