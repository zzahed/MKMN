/**
 * What code can put right in a unit without asking a model: the slips small models make every time, each rewritten where the meaning is not in
 * doubt and left alone otherwise (then the check names it and the model is asked with the exact fault). Nothing here knows a kind of program.
 */
import { parse } from "acorn";
import { closestName, GLOBALS } from "./mend";
import { declaredIn } from "./bind";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an acorn AST node: the walk reads whichever fields each node type has
type Node = { type: string; start: number; end: number; [key: string]: any };
interface Edit { start: number; end: number; text: string }
const skip = new Set(["type", "start", "end", "loc", "range"]);

const parseIt = (code: string): Node | null => {
  try { return parse(code, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true }) as unknown as Node; } catch { return null; }
};
const apply = (code: string, edits: Edit[]) => {
  let out = code;
  const used = new Set<number>();
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) { if (used.has(e.start) && e.start !== e.end) continue; used.add(e.start); out = out.slice(0, e.start) + e.text + out.slice(e.end); }
  return out;
};
const isFn = (n: Node) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
const walk = (n: Node | null | undefined, f: (n: Node, parent: Node | null) => boolean | void, parent: Node | null = null) => {
  if (!n || typeof n.type !== "string") return;
  if (f(n, parent) === false) return;
  for (const k of Object.keys(n)) {
    if (skip.has(k)) continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c === "object" && typeof (c as Node).type === "string" && walk(c as Node, f, n));
    else if (v && typeof v === "object" && typeof (v as Node).type === "string") walk(v as Node, f, n);
  }
};

/** Brackets a cut-off answer left open are closed, in the right order, ignoring strings, comments and templates. */
export function closeBrackets(code: string): string {
  const stack: string[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i], d = code[i + 1];
    if (c === "/" && d === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? code.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === "`") { i++; while (i < code.length && code[i] !== c) { if (code[i] === "\\") i++; i++; } i++; continue; }
    if ("{([".includes(c)) stack.push(c === "{" ? "}" : c === "(" ? ")" : "]");
    else if ("})]".includes(c)) { if (stack[stack.length - 1] === c) stack.pop(); else return code; }
    i++;
  }
  return stack.length && stack.length <= 6 ? `${code.replace(/\s+$/, "")}\n${stack.reverse().join("\n")}` : code;
}

/** Typographic quotes, module syntax and a cut-off ending: what makes a unit fail to load for nothing that is its idea. */
export function cleanSyntax(code: string): string {
  let out = code.replace(/^\s*(?:import\b[^\n]*|export\s+default\s+[\w$]+\s*;?)\s*$/gm, "").replace(/^(\s*)export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b)/gm, "$1").replace(/^\s*(?:module\.exports|exports\.[\w$]+)\s*=[^\n]*$/gm, "");
  // typographic quotes only when the code does not parse as written: inside a string ('It’s over') they are text, not quotes
  if (!parseIt(out)) out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  if (!parseIt(out)) { const closed = closeBrackets(out); if (parseIt(closed)) out = closed; }
  return out;
}

/** Other ways a key is written, by the name the program uses for it (`ArrowLeft` is also written `Left`; the space bar is `Space` in the plan and `" "` in an event). */
const KEY_ALIASES: Record<string, string[]> = {
  ArrowLeft: ["Left", "Arrow Left"], ArrowRight: ["Right", "Arrow Right"], ArrowUp: ["Up", "Arrow Up"], ArrowDown: ["Down", "Arrow Down"],
  Space: ["Spacebar", "Space", "SpaceBar"], Escape: ["Esc"], Enter: ["Return"]
};

/**
 * A key written another way than the program writes it, put in the program's own way: only for the keys the program HAS (its events name
 * them), so a program that listens for `Left` and never for `ArrowLeft` is left as it is. `known` are the key names of the plan's events.
 */
export function fixKeys(code: string, known: string[]): string {
  let out = code;
  for (const name of known) {
    const aliases = (KEY_ALIASES[name] ?? []).filter((a) => !known.includes(a) || a === name);
    for (const alias of aliases) {
      const want = name === "Space" ? " " : name;
      if (alias === want) continue;
      const lit = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // what an event reports (`e.key`) and what a variable holds are compared the same way: only a comparison with the alias as a word is touched
      out = out.replace(new RegExp(`(\\.key\\s*[!=]==?\\s*)(['"])${lit}\\2`, "g"), `$1'${want}'`).replace(new RegExp(`(['"])${lit}\\1(\\s*[!=]==?\\s*[\\w$.]*\\.key\\b)`, "g"), `'${want}'$2`);
    }
  }
  return out;
}

const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const rootOf = (n: Node): string | null => { let x = n; while (x.type === "MemberExpression") x = x.object; return x.type === "Identifier" ? x.name : null; };

/** A function that changes what it was given and returns nothing is made a calculation: it works on a copy and returns it. */
export function pureCopy(code: string, name: string): string {
  const ast = parseIt(code);
  if (!ast) return code;
  const fn = (ast.body as Node[]).find((s) => s.type === "FunctionDeclaration" && s.id?.name === name);
  if (!fn || fn.body.type !== "BlockStatement") return code;
  const params = (fn.params as Node[]).filter((p) => p.type === "Identifier").map((p) => p.name as string);
  const mutated: string[] = [];
  let returnsValue = false;
  walk(fn.body, (n) => {
    if (n.type === "ReturnStatement" && n.argument) returnsValue = true;
    if (n !== fn.body && isFn(n)) { walk(n.body, (m) => {
      if (m.type === "AssignmentExpression" || m.type === "UpdateExpression") { const t = m.type === "AssignmentExpression" ? m.left : m.argument; const r = t.type === "MemberExpression" ? rootOf(t) : null; if (r && params.includes(r) && !mutated.includes(r)) mutated.push(r); }
      if (m.type === "CallExpression" && m.callee.type === "MemberExpression" && m.callee.property.type === "Identifier" && MUTATORS.has(m.callee.property.name)) { const r = rootOf(m.callee.object); if (r && params.includes(r) && !mutated.includes(r)) mutated.push(r); }
    }); return false; }
    if (n.type === "AssignmentExpression" || n.type === "UpdateExpression") { const t = n.type === "AssignmentExpression" ? n.left : n.argument; const r = t.type === "MemberExpression" ? rootOf(t) : null; if (r && params.includes(r) && !mutated.includes(r)) mutated.push(r); }
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.type === "Identifier" && MUTATORS.has(n.callee.property.name)) { const r = rootOf(n.callee.object); if (r && params.includes(r) && !mutated.includes(r)) mutated.push(r); }
    return true;
  });
  if (!mutated.length) return code;
  // a function that returns something else (`p.vx = 0; return p.x > w.x`) would silently stop
  // changing its argument: left alone, the frozen-argument check names the fault instead
  if (returnsValue) {
    const handsBack = (a: Node | null): boolean => !!a && ((a.type === "Identifier" && mutated.includes(a.name)) || (a.type === "ObjectExpression" && a.properties.some((p: Node) => p.type === "SpreadElement" && p.argument.type === "Identifier" && mutated.includes(p.argument.name))));
    let other = false;
    walk(fn.body, (n) => { if (n !== fn.body && isFn(n)) return false; if (n.type === "ReturnStatement" && n.argument && !handsBack(n.argument)) other = true; return true; });
    if (other) return code;
  }
  const edits: Edit[] = [{ start: fn.body.start + 1, end: fn.body.start + 1, text: `\n${mutated.map((p) => `  ${p} = ${p} === undefined ? ${p} : JSON.parse(JSON.stringify(${p}));`).join("\n")}` }];
  if (!returnsValue) edits.push({ start: fn.body.end - 1, end: fn.body.end - 1, text: `  return ${mutated[0]};\n` });
  return apply(code, edits);
}

/** Whether the function hands back its first argument (changed): `return player`, `return { ...player, x }`. */
export function returnsFirstArg(code: string, name: string): boolean {
  const ast = parseIt(code);
  const fn = ast && (ast.body as Node[]).find((s) => s.type === "FunctionDeclaration" && s.id?.name === name);
  if (!fn) return false;
  const p0 = fn.params[0]?.type === "Identifier" ? fn.params[0].name : null;
  if (!p0) return false;
  let yes = false;
  // a local that starts as a copy of the first argument (`let next = { ...player }`) and is handed back counts as the first argument, changed
  const copies = new Set<string>();
  walk(fn.body, (n) => {
    if (n !== fn.body && isFn(n)) return false;
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init) {
      const i = n.init as Node;
      if (i.type === "ObjectExpression" && (i.properties as Node[]).some((q) => q.type === "SpreadElement" && q.argument.type === "Identifier" && q.argument.name === p0)) copies.add(n.id.name);
      if (i.type === "CallExpression" && /Object\.assign$/.test(code.slice(i.callee.start, i.callee.end)) && (i.arguments as Node[]).some((q) => q.type === "Identifier" && q.name === p0)) copies.add(n.id.name);
    }
    return true;
  });
  walk(fn.body, (n) => {
    if (n !== fn.body && isFn(n)) return false;
    if (n.type === "ReturnStatement" && n.argument) {
      const a = n.argument as Node;
      if (a.type === "Identifier" && (a.name === p0 || copies.has(a.name))) yes = true;
      if (a.type === "ObjectExpression" && (a.properties as Node[]).some((q) => q.type === "SpreadElement" && q.argument.type === "Identifier" && (q.argument.name === p0 || copies.has(q.argument.name)))) yes = true;
    }
    return true;
  });
  return yes;
}

/** `applyInput(S.player, S.keys);` where the function hands back the new player: the result is kept, `S.player = applyInput(S.player, S.keys);`. */
export function keepResults(code: string, handBack: Set<string>): string {
  if (!handBack.size) return code;
  const ast = parseIt(code);
  if (!ast) return code;
  const edits: Edit[] = [];
  walk(ast, (n) => {
    if (n.type === "ExpressionStatement" && n.expression.type === "CallExpression" && n.expression.callee.type === "Identifier" && handBack.has(n.expression.callee.name)) {
      const a = n.expression.arguments[0] as Node | undefined;
      if (a && a.type === "MemberExpression" && rootOf(a) === "S") edits.push({ start: n.start, end: n.start, text: `${code.slice(a.start, a.end)} = ` });
    }
    return true;
  });
  return apply(code, edits);
}

const argName = (a: Node): string | null => (a.type === "Identifier" ? a.name : a.type === "MemberExpression" && !a.computed && a.property.type === "Identifier" ? a.property.name : null);

/** A call whose arguments are the right ones in another order (`f(keys, player)` for `f(player, keys)`): put in the order of the signature. */
export function orderArgs(code: string, sigs: Map<string, string[]>): string {
  const ast = parseIt(code);
  if (!ast) return code;
  const edits: Edit[] = [];
  walk(ast, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && sigs.has(n.callee.name)) {
      const want = sigs.get(n.callee.name)!, args = n.arguments as Node[];
      if (args.length !== want.length || args.length < 2) return true;
      const names = args.map(argName);
      if (names.some((x) => !x) || new Set(names).size !== names.length || new Set(want).size !== want.length) return true;
      if (!want.every((w) => names.includes(w)) || names.every((x, i) => x === want[i])) return true;
      want.forEach((w, i) => { const src = args[names.indexOf(w)]; edits.push({ start: args[i].start, end: args[i].end, text: code.slice(src.start, src.end) }); });
    }
    return true;
  });
  return apply(code, edits);
}

/** An id the code asks the page for that the page does not have, when one id of the page clearly stands for it. */
export function mendIds(code: string, ids: string[]): string {
  if (!ids.length) return code;
  const have = new Set(ids);
  // a selector is touched only when it is a bare `#id`: `div > p` or `.row` name no id
  return code.replace(/(getElementById\(\s*|querySelector(?:All)?\(\s*['"]#(?=[\w-]+['"]))(['"]?)([\w-]+)\2/g, (m, pre: string, q: string, id: string) => {
    if (have.has(id)) return m;
    const near = closestName(id, ids);
    return near ? `${pre}${q}${near}${q}` : m;
  });
}

/** A top-level name another unit already declares (two `const TILE`): this unit's own is renamed, so the page still loads. */
export function renameCollisions(code: string, taken: Set<string>, unit: string): string {
  const ast = parseIt(code);
  if (!ast) return code;
  const own = new Set<string>();
  for (const s of ast.body as Node[]) if (s.type === "VariableDeclaration") for (const d of s.declarations as Node[]) if (d.id.type === "Identifier") own.add(d.id.name);
  // renamed from the syntax tree, not the text: a ternary (`c ? TILE : 0`) and a `case TILE:` keep
  // pointing at the right binding, strings, comments and property names are left alone, a shorthand
  // `{ TILE }` keeps its key, and a function that declares the name itself is not touched
  const edits: Edit[] = [];
  for (const name of own) {
    if (!taken.has(name)) continue;
    const to = `${name}_${unit.replace(/[^\w$]/g, "")}`;
    const shadows = (fn: Node): boolean => {
      let found = false;
      const binds = (p: Node | null): void => { if (!p) return; if (p.type === "Identifier" && p.name === name) found = true; else if (p.type === "AssignmentPattern") binds(p.left); else if (p.type === "RestElement") binds(p.argument); else if (p.type === "ObjectPattern") p.properties.forEach((q: Node) => binds(q.type === "RestElement" ? q : q.value)); else if (p.type === "ArrayPattern") p.elements.forEach(binds); };
      (fn.params as Node[]).forEach(binds);
      walk(fn.body, (n) => { if (n !== fn.body && isFn(n)) return false; if (n.type === "VariableDeclarator") binds(n.id); if (n.type === "FunctionDeclaration" && n.id?.name === name) found = true; return true; });
      return found;
    };
    walk(ast, (n, parent) => {
      if (isFn(n) && shadows(n)) return false;
      if (n.type !== "Identifier" || n.name !== name) return;
      if (parent?.type === "Property" && parent.shorthand && parent.value === n) return; // the key's edit covers it
      if (parent?.type === "MemberExpression" && parent.property === n && !parent.computed) return;
      if (parent && (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === n && !parent.computed) {
        if (parent.type === "Property" && parent.shorthand) edits.push({ start: n.start, end: n.end, text: `${name}: ${to}` });
        return;
      }
      if (parent && (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement")) return;
      edits.push({ start: n.start, end: n.end, text: to });
    });
  }
  return edits.length ? apply(code, edits) : code;
}

/**
 * A unit's name used as an element or a value (its own, or another unit's). A view is not a page element and a function is not a value: the page
 * gives a view the element it draws into (the id, `canvas` and `ctx`), and a function is called. A property read on a unit's name (`drawCanvas.getContext`,
 * `drawSnake.appendChild`) is always this confusion, and it is named exactly so a correction can act on it.
 */
export function unitValueProblems(code: string, units: { name: string; kind: string }[]): string[] {
  const byName = new Map(units.filter((u) => u.kind === "fn" || u.kind === "view" || u.kind === "handler").map((u) => [u.name, u.kind]));
  if (!byName.size) return [];
  const ast = parseIt(code);
  if (!ast) return [];
  const out: string[] = [];
  const say = (m: string) => { if (!out.includes(m)) out.push(m); };
  const visit = (n: Node | null | undefined) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier" && n.property.type === "Identifier") {
      const kind = byName.get(n.object.name);
      if (kind) say(`it uses ${n.object.name} (a ${kind}) as an element or a value (${n.object.name}.${n.property.name}): ${n.object.name} is a unit of the program, not an element of the page. A function is called (${n.object.name}(...)); a view draws into the element the page gives it (the id, or canvas and ctx)`);
    }
    for (const key of Object.keys(n)) {
      if (skip.has(key)) continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === "object" && typeof (c as Node).type === "string" && visit(c as Node));
      else if (v && typeof v === "object" && typeof (v as Node).type === "string") visit(v as Node);
    }
  };
  for (const s of ast.body as Node[]) visit(s);
  return out.slice(0, 3);
}

/** The names every page and every browser already has: calling one of them is never a gap in the plan. */
const BUILTINS = new Set([
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "BigInt", "Date", "RegExp", "Error", "TypeError", "RangeError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Proxy", "Reflect",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask", "structuredClone",
  "alert", "confirm", "prompt", "fetch", "console", "document", "window", "navigator", "localStorage", "sessionStorage", "Audio", "Image", "HTMLElement", "Element", "Event", "CustomEvent", "requestIdleCallback"
]);

/** Every name a pattern binds (a parameter, a loop variable), so a call to it is not taken for a gap. */
const bindings = (p: Node | null | undefined, into: Set<string>) => {
  if (!p || typeof p.type !== "string") return;
  if (p.type === "Identifier") into.add(p.name);
  else if (p.type === "ObjectPattern") (p.properties as Node[]).forEach((q) => bindings(q.type === "Property" ? q.value : q, into));
  else if (p.type === "ArrayPattern") (p.elements as Node[]).forEach((e) => bindings(e, into));
  else if (p.type === "AssignmentPattern") bindings(p.left, into);
  else if (p.type === "RestElement") bindings(p.argument, into);
};

/**
 * The names a unit calls that the program does not plan and that are not the page's or the browser's: each one is a missing unit (a gap in the plan),
 * found the moment the calling unit is written, never left until the page is played. A name that IS planned but not written yet is not here: that one is
 * a unit waiting its turn, which the caller already sees as a stub.
 */
export function unplannedCalls(code: string, planned: Set<string> | string[]): string[] {
  const known = planned instanceof Set ? planned : new Set(planned);
  const ast = parseIt(code);
  if (!ast) return [];
  const own = new Set<string>();
  walk(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id?.name) own.add(n.id.name);
    else if (n.type === "ClassDeclaration" && n.id?.name) own.add(n.id.name);
    else if (n.type === "VariableDeclarator") bindings(n.id, own);
    if (isFn(n)) (n.params as Node[]).forEach((p) => bindings(p, own));
    return true;
  });
  const out: string[] = [];
  walk(ast, (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier") {
      const name = n.callee.name as string;
      if (!known.has(name) && !own.has(name) && !BUILTINS.has(name) && !out.includes(name)) out.push(name);
    }
    return true;
  });
  return out.slice(0, 8);
}

/** The faults that are better named than rewritten: a timer started inside a unit (the page already calls it), S declared again. */
export function wiringProblems(code: string, kind: string, on?: string): string[] {
  const out: string[] = [];
  // a timer started where the page already calls the unit again and again piles up; a one-off handler may start one (that is the program's own idea)
  if ((kind === "view" || kind === "fn" || (kind === "handler" && /^tick /.test(on ?? ""))) && /\b(?:setInterval|requestAnimationFrame)\s*\(/.test(code)) out.push("it starts its own timer or animation loop: the page already calls handlers on their event (tick 16 runs 60 times a second) and draws the views after each, so write only what happens once per call");
  if (/(?:^|[\n;])\s*(?:const|let|var)\s+S\b/.test(code)) out.push("it declares its own S: S is the program's state and already exists, use it");
  if (/\baddEventListener\s*\(\s*['"]key(?:down|up)['"]/.test(code)) out.push("it adds its own key listener: the page already connects each key handler to its key");
  return out;
}

/** `const S = window.S;` (or globalThis, self): S is already the program's, and the line only hides it. */
export function dropOwnState(code: string): string {
  return code.replace(/^[ \t]*(?:const|let|var)\s+S\s*=\s*(?:window|globalThis|self|this)\.S\s*;?[ \t]*\n?/gm, "");
}

/**
 * What a view does that the page already does for it: wipe the whole canvas (the page clears every canvas before the views draw, so a view
 * that wipes it erases the ones drawn before it), and call another view (the page calls each view once).
 */
export function mendView(code: string, name: string, views: string[]): string {
  const ast = parseIt(code);
  if (!ast) return code;
  const edits: Edit[] = [];
  const full = (a: Node) => a.type === "Literal" && a.value === 0;
  walk(ast, (n) => {
    if (n.type !== "ExpressionStatement" || n.expression.type !== "CallExpression") return true;
    const c = n.expression, callee = c.callee as Node;
    if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === "clearRect") {
      const a = c.arguments as Node[];
      if (a.length === 4 && full(a[0]) && full(a[1]) && /width|height|\d{3,}/.test(code.slice(a[2].start, a[3].end))) edits.push({ start: n.start, end: n.end, text: "" });
    }
    if (callee.type === "Identifier" && callee.name !== name && views.includes(callee.name)) edits.push({ start: n.start, end: n.end, text: "" });
    return true;
  });
  return apply(code, edits);
}

/**
 * A tick handler that sets a field the key handlers set (`S.keysPressed = { ArrowLeft: false, ... }` on every tick) wipes what the keys
 * just said: the line is removed. Read from this program: only a field of flags that its own key handlers write.
 */
export function keepKeyFlags(code: string, state: Record<string, unknown>, keyHandlers: string[]): string {
  const ast = parseIt(code);
  if (!ast) return code;
  const edits: Edit[] = [];
  walk(ast, (n) => {
    if (n.type === "ExpressionStatement" && n.expression.type === "AssignmentExpression" && n.expression.operator === "=") {
      const l = n.expression.left as Node, r = n.expression.right as Node;
      if (l.type === "MemberExpression" && !l.computed && l.object.type === "Identifier" && l.object.name === "S" && l.property.type === "Identifier" && r.type === "ObjectExpression" && (r.properties as Node[]).length && (r.properties as Node[]).every((p) => p.type === "Property" && p.value.type === "Literal" && typeof p.value.value === "boolean")) {
        const f = l.property.name, cur = state[f];
        const set = keyHandlers.some((h) => new RegExp(`\\bS\\.${f}\\b`).test(h));
        if (set && cur && typeof cur === "object" && !Array.isArray(cur)) edits.push({ start: n.start, end: n.end, text: "" });
      }
    }
    return true;
  });
  return apply(code, edits);
}

/**
 * Page work a view or a tick handler writes itself (the page already does it): `setInterval(() => { ... }, 16)` becomes what is inside,
 * `requestAnimationFrame(loop)` goes, and a key listener it adds goes (the key handlers exist). What is inside is kept: it is the unit's own.
 */
export function dropPageWork(code: string): string {
  const ast = parseIt(code);
  if (!ast) return code;
  const edits: Edit[] = [];
  walk(ast, (n) => {
    if (n.type !== "ExpressionStatement" || n.expression.type !== "CallExpression") return true;
    const c = n.expression, callee = c.callee as Node, args = c.arguments as Node[];
    const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : "";
    if (name === "setInterval" || name === "requestAnimationFrame") {
      const f = args[0];
      if (f && (f.type === "ArrowFunctionExpression" || f.type === "FunctionExpression") && f.body.type === "BlockStatement") {
        edits.push({ start: n.start, end: n.end, text: code.slice(f.body.start + 1, f.body.end - 1).trim() });
        return false;
      }
      edits.push({ start: n.start, end: n.end, text: "" });
      return false;
    }
    if (name === "addEventListener" && args[0]?.type === "Literal" && /^key(?:down|up|press)$/.test(String(args[0].value))) { edits.push({ start: n.start, end: n.end, text: "" }); return false; }
    return true;
  });
  return apply(code, edits);
}

/**
 * A function whose every answer is an object made only of keys of S (`{ score, timeLeft, gameState }`) hands back a piece of the state.
 * Read from this program's own state: a call to it whose result is thrown away is kept with `Object.assign(S, f(...))`.
 */
export function returnsStatePatch(code: string, name: string, stateKeys: string[]): boolean {
  const ast = parseIt(code);
  const fn = ast && (ast.body as Node[]).find((s) => s.type === "FunctionDeclaration" && s.id?.name === name);
  if (!fn || !stateKeys.length) return false;
  let seen = 0, bad = 0;
  walk(fn.body, (n) => {
    if (n !== fn.body && isFn(n)) return false;
    if (n.type === "ReturnStatement" && n.argument) {
      seen++;
      const a = n.argument as Node;
      const keys = a.type === "ObjectExpression" ? (a.properties as Node[]).map((q) => (q.type === "Property" && !q.computed ? (q.key.type === "Identifier" ? q.key.name : String(q.key.value)) : null)) : null;
      if (!keys || keys.length < 2 || keys.some((k) => !k || !stateKeys.includes(k))) bad++;
    }
    return true;
  });
  return seen > 0 && bad === 0;
}

/** Calls of such functions, as statements, keep what they give back: `Object.assign(S, updateScore(...));`. */
export function keepPatches(code: string, patching: Set<string>): string {
  if (!patching.size) return code;
  const ast = parseIt(code);
  if (!ast) return code;
  const edits: Edit[] = [];
  walk(ast, (n) => {
    if (n.type === "ExpressionStatement" && n.expression.type === "CallExpression" && n.expression.callee.type === "Identifier" && patching.has(n.expression.callee.name)) {
      edits.push({ start: n.start, end: n.start, text: "Object.assign(S, " }, { start: n.expression.end, end: n.expression.end, text: ")" });
    }
    return true;
  });
  return apply(code, edits);
}

/** A view that reads `S.canvas` or `S.ctx` wants the element it draws into and its context, which the page gives it as `canvas` and `ctx` (S holds no such key). */
export function pageNames(code: string, stateKeys: string[], into?: string): string {
  const out = code.replace(/\bS\.(canvas|ctx)\b/g, (m, k: string) => (stateKeys.includes(k) ? m : k));
  // `S.board` for a view that draws into #board: the element is what the page calls `canvas`, S has no such key
  return into && /^[A-Za-z_$][\w$]*$/.test(into) && !stateKeys.includes(into) && into !== "canvas" ? out.replace(new RegExp(`\\bS\\.${into}\\b`, "g"), "canvas") : out;
}

/**
 * The free names of a unit that stand for nothing — not a unit of the plan, not something the unit declares, not the browser's or the page's
 * own things (S, state, canvas, ctx, document, Math…). An unplanned call is a gap in the plan, which is its own matter (`unplannedCalls`, the
 * missing unit is added); a name used in any other position, like `keys[LEFT_ARROW]`, is nothing that can ever resolve, so the code cannot
 * run, and the fault is named exactly. Nothing here knows a kind of program.
 */
export function unplannedNames(code: string, planned: Set<string> | string[], extra?: Set<string> | string[]): string[] {
  const known = planned instanceof Set ? planned : new Set(planned);
  if (extra) for (const n of extra as Iterable<string>) known.add(n);
  const ast = parseIt(code);
  if (!ast) return [];
  const PAGE = new Set(["state", "canvas", "ctx", "context"]);
  const refs: { name: string; call: boolean; scopes: Set<string>[] }[] = [];
  const visit = (n: Node | null | undefined, parent: Node | null, scopes: Set<string>[]): void => {
    if (!n || typeof n.type !== "string") return;
    switch (n.type) {
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": visit(n.body, n, [...scopes, declaredIn(n)]); return;
      case "LabeledStatement": visit(n.body, n, scopes); return;
      case "BreakStatement": case "ContinueStatement": case "ObjectPattern": case "ArrayPattern": return;
      case "VariableDeclarator": visit(n.init, n, scopes); return;
      case "Property": if (parent?.type === "ObjectPattern") return; if (n.computed) visit(n.key, n, scopes); visit(n.value, n, scopes); return;
      case "MethodDefinition": case "PropertyDefinition": if (n.computed) visit(n.key, n, scopes); visit(n.value, n, scopes); return;
      case "MemberExpression": visit(n.object, n, scopes); if (n.computed) visit(n.property, n, scopes); return;
      case "CatchClause": { const s = new Set<string>(); if (n.param?.type === "Identifier") s.add(n.param.name); visit(n.body, n, [...scopes, s]); return; }
      case "Identifier": refs.push({ name: n.name as string, call: parent?.type === "CallExpression" && parent.callee === n, scopes }); return;
    }
    for (const k of Object.keys(n)) {
      if (skip.has(k)) continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === "object" && typeof (c as Node).type === "string" && visit(c as Node, n, scopes));
      else if (v && typeof v === "object" && typeof (v as Node).type === "string") visit(v as Node, n, scopes);
    }
  };
  const root = declaredIn({ type: "Program", params: [], body: ast, start: 0, end: code.length } as Node);
  visit(ast, null, [root]);
  const out: string[] = [];
  for (const r of refs) {
    if (r.call) continue;             // a call to an unplanned name is a gap in the plan, not a dangling reference
    if (known.has(r.name) || GLOBALS.has(r.name) || PAGE.has(r.name)) continue;
    if (r.scopes.some((s) => s.has(r.name))) continue;
    if (!out.includes(r.name)) out.push(r.name);
  }
  return out.slice(0, 3);
}

const ordinal = (i: number) => (i === 1 ? "st" : i === 2 ? "nd" : i === 3 ? "rd" : "th");
/** The kind of a call's argument: what it holds, when it is knowable statically; null when it is not. */
const argKind = (a: Node): string | null => {
  if (a.type === "Literal") return a.value === null ? "null" : Array.isArray(a.value) ? "list" : typeof a.value;
  if (a.type === "ArrayExpression") return "list";
  if (a.type === "ObjectExpression") return "object";
  return null;
};
/** The kind of a `S.key` argument, as the declared state holds it; null when it is not an S key or the state does not say. */
const argKindOfState = (a: Node, state: Record<string, unknown> | undefined): string | null => {
  if (!state || a.type !== "MemberExpression" || a.computed || a.object?.type !== "Identifier" || a.object.name !== "S") return null;
  const k = a.property?.name;
  if (typeof k !== "string" || !(k in state)) return null;
  const v = state[k];
  return v === null ? "null" : Array.isArray(v) ? "list" : typeof v === "object" ? "object" : typeof v;
};
/** True when the unit's body reads a property straight off this parameter (`score.x`) — the body treats it as an object. */
const bodyUsesParamAsObject = (body: Node, param: string): boolean => {
  let used = false;
  walk(body, (n) => {
    if (used) return false;
    if (n.type === "MemberExpression" && !n.computed && n.object?.type === "Identifier" && n.object.name === param) used = true;
    return !used;
  }, null);
  return used;
};

/**
 * The same function called with different kinds of values by different units: `move(S.x, "3")` in one and `move(1, 2)` in another. A function
 * has one meaning per position of its signature, so one of the two callers is wrong. And the unit's own body can contradict its caller: the
 * body reads a property straight off a parameter (`score.x` — it expects an object) while the caller passes a number or a string there.
 * What a value holds is never judged here beyond what the code and the declared state themselves show; only the kinds the code itself shows.
 */
export function argKindProblems(units: { name: string; code: string }[], planned: Set<string> | string[], state?: Record<string, unknown>): Map<string, string[]> {
  const want = planned instanceof Set ? planned : new Set(planned);
  const kindOf = (a: Node): string | null => argKind(a) ?? argKindOfState(a, state);
  const calls: { unit: string; callee: string; kinds: (string | null)[] }[] = [];
  for (const u of units) {
    const ast = parseIt(u.code);
    if (!ast) continue;
    walk(ast, (n) => {
      if (n.type === "CallExpression" && n.callee?.type === "Identifier" && want.has(n.callee.name)) {
        calls.push({ unit: u.name, callee: n.callee.name, kinds: (n.arguments as Node[]).map(kindOf) });
      }
      return true;
    }, null);
  }
  const out = new Map<string, string[]>();
  const byName = new Map<string, typeof calls>();
  for (const c of calls) { const list = byName.get(c.callee) ?? []; list.push(c); byName.set(c.callee, list); }
  for (const [callee, list] of byName) {
    if (list.length < 2) continue;
    const first = list[0];
    for (const c of list.slice(1)) {
      for (let i = 0; i < Math.min(c.kinds.length, first.kinds.length); i++) {
        const a = first.kinds[i], b = c.kinds[i];
        if (!a || !b || a === b) continue;
        const msg = `it calls ${callee}(…) with a ${b} in the ${i + 1}${ordinal(i + 1)} argument where ${first.unit} calls it with a ${a}: the same function must be called with the same kinds of values; one of them is wrong`;
        const cur = out.get(c.unit) ?? [];
        if (!cur.includes(msg)) out.set(c.unit, [...cur, msg]);
        break;
      }
    }
  }
  // the body against its callers: a parameter the body reads a property off (it expects an object), passed a scalar somewhere
  const scalars = new Set(["number", "string", "boolean"]);
  for (const u of units) {
    const ast = parseIt(u.code);
    if (!ast || !want.has(u.name)) continue;
    const fn = (ast.body ?? []).find((n: Node) => isFn(n) && (n as any).id?.name === u.name) as Node | undefined;
    const params = (fn?.params ?? []) as Node[];
    if (!params.length) continue;
    for (const c of calls) {
      if (c.callee !== u.name) continue;
      for (let i = 0; i < Math.min(params.length, c.kinds.length); i++) {
        const p = params[i];
        if (p?.type !== "Identifier" || !bodyUsesParamAsObject(fn!, p.name)) continue;
        const k = c.kinds[i];
        if (!k || !scalars.has(k)) continue;
        const msg = `it calls ${u.name}(…) with a ${k} in the ${i + 1}${ordinal(i + 1)} argument, but ${u.name} reads a property off that argument in its own body (it expects an object there): one of them is wrong`;
        const cur = out.get(c.unit) ?? [];
        if (!cur.includes(msg)) out.set(c.unit, [...cur, msg]);
        break;
      }
    }
  }
  return out;
}
