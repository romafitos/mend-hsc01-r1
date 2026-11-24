// mend — applies an AI-written edit (unified diff, SEARCH/REPLACE, V4A, JSON tool calls) to a tree of text files,
// all files or none. SPEC.md is the contract. Node 22, standard library only. MIT, (c) 2026 romafitos.
// With MAKEFUN_ENV_URL set this file hands over to the kit's runner.ts (bottom of the file).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = new Set(['auto', 'unified', 'search-replace', 'v4a', 'json']);

/** Exit-2 outcome: one line, nothing written. */
class Stop {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
/** One failed edit: `error: <code> <path>`. */
class EditError {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const stripSpTab = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Patch text -> lines (SPEC §3, last bullet). */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return false;
  return true;
}

/** A file seen as lines with its break and final-break flag (SPEC §3). */
interface Doc {
  lines: string[];
  eol: string;
  final: boolean;
}

function toDoc(text: string): Doc {
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], eol, final: false };
  const lines = text.split(eol);
  const final = text.endsWith(eol);
  if (final) lines.pop();
  return { lines, eol, final };
}

function fromDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.eol) + (d.final ? d.eol : '');
}

/** Working tree: edits write to `now` (null = deleted); untouched paths come from disk. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.before(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

/** An edit: checks/changes the tree, throws EditError on failure. `moves` collects successful move pairs. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

function needSafe(...paths: string[]): void {
  for (const p of paths) if (!isSafePath(p)) throw new EditError('unsafe', p);
}

// ---- line matching (SPEC §5) ----

const TIER_NORMALIZERS: Array<(s: string) => string> = [(s) => s, stripSpTab, stripBoth];

/** All occurrence positions of `old` in `file` at a tier. */
function occurrences(file: string[], old: string[], tier: number, from = 0): number[] {
  const norm = TIER_NORMALIZERS[tier]!;
  const o = old.map(norm);
  const hits: number[] = [];
  // compare lazily: most start positions fail on their first line, so the file is never copied
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      const line = file[i + j]!;
      if ((tier === 0 ? line : norm(line)) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** First tier with at least one occurrence (filtered by `keep`), or null. */
function findTier(file: string[], old: string[], strict: boolean, from = 0, keep?: (i: number) => boolean): { tier: number; hits: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    let hits = occurrences(file, old, t, from);
    if (keep) hits = hits.filter(keep);
    if (hits.length > 0) return { tier: t, hits };
  }
  return null;
}

/** A body line of a hunk/chunk: ' ' context, '-' old, '+' new. SEARCH/REPLACE uses only '-' and '+'. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

const oldOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== '+').map((b) => b.text);
const newOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== '-').map((b) => b.text);

/** Lines that replace the k matched lines at `pos` (SPEC §5 last paragraph). */
function replacement(file: string[], pos: number, tier: number, body: BodyLine[]): string[] {
  const old = oldOf(body);
  const fileIndent = old.length > 0 ? leadWs(file[pos]!) : '';
  const patchIndent = old.length > 0 ? leadWs(old[0]!) : '';
  const out: string[] = [];
  let k = 0; // index into matched lines
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(file[pos + k]!);
      k++;
    } else if (b.kind === '-') {
      k++;
    } else if (tier === 2 && !isBlank(b.text) && b.text.startsWith(patchIndent)) {
      out.push(fileIndent + b.text.slice(patchIndent.length));
    } else {
      out.push(b.text);
    }
  }
  return out;
}

// ---- format detection (SPEC §4) ----

function detectFormat(lines: string[]): string | null {
  const i = lines.findIndex((l) => !isBlank(l));
  if (i < 0) return null;
  const first = lines[i]!;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const c = first.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let j = 0; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---- JSON edits (SPEC §9) ----

const lineBreakOf = (text: string): string => {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
};

function existing(tree: Tree, p: string): string {
  needSafe(p);
  const t = tree.get(p);
  if (t === null) throw new EditError('missing', p);
  return t;
}

/** Turn one parsed JSON value into an edit, or null when it is not a valid edit object. */
function jsonToEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  switch (o.command) {
    case 'create': {
      const text = o.file_text;
      if (typeof text !== 'string') return null;
      return (tree) => {
        needSafe(path);
        if (tree.get(path) !== null) throw new EditError('exists', path);
        tree.set(path, text);
      };
    }
    case 'str_replace': {
      const oldStr = o.old_str;
      const newRaw = o.new_str;
      if (typeof oldStr !== 'string' || oldStr === '') return null;
      if (newRaw !== undefined && typeof newRaw !== 'string') return null;
      const newStr = newRaw ?? '';
      return (tree) => {
        const src = existing(tree, path);
        const crlf = lineBreakOf(src) === '\r\n';
        const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
        const text = norm(src);
        const needle = norm(oldStr);
        const first = text.indexOf(needle);
        if (first < 0) throw new EditError('no-match', path);
        if (text.indexOf(needle, first + 1) >= 0) throw new EditError('ambiguous', path);
        const out = text.slice(0, first) + norm(newStr) + text.slice(first + needle.length);
        tree.set(path, crlf ? out.split('\n').join('\r\n') : out);
      };
    }
    case 'insert': {
      const at = o.insert_line;
      const ns = o.new_str;
      if (typeof at !== 'number' || !Number.isInteger(at) || typeof ns !== 'string') return null;
      const add = splitPatch(ns);
      return (tree) => {
        const doc = toDoc(existing(tree, path));
        if (at < 0 || at > doc.lines.length) throw new EditError('no-match', path);
        doc.lines.splice(at, 0, ...add);
        tree.set(path, fromDoc(doc));
      };
    }
    default:
      return null;
  }
}

function readJson(text: string, lines: string[]): Edit[] {
  const start = lines.findIndex((l) => !isBlank(l));
  if (start < 0) throw new Stop('error: parse 1');
  const edits: Edit[] = [];
  if (lines[start]!.trimStart().startsWith('[')) {
    const bad = new Stop(`error: parse ${start + 1}`);
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw bad;
    }
    if (!Array.isArray(arr)) throw bad;
    for (const item of arr) {
      const e = jsonToEdit(item);
      if (e === null) throw bad;
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i]!)) continue;
    let e: Edit | null = null;
    try {
      e = jsonToEdit(JSON.parse(lines[i]!));
    } catch {
      e = null;
    }
    if (e === null) throw new Stop(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

// ---- CLI (SPEC §1, §2, §10) ----

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function parseArgs(args: string[]): { format: string; check: boolean; strict: boolean; patch: string | null } | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let optsDone = false;
  const positional: string[] = [];
  for (const a of args) {
    if (!optsDone && a === '--') {
      optsDone = true;
      continue;
    }
    if (optsDone || a === '-' || !a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (a.startsWith('--format=')) {
      const v = a.slice('--format='.length);
      if (format !== null || !FORMAT_NAMES.has(v)) return null;
      format = v;
    } else if (a === '--check') {
      if (check) return null;
      check = true;
    } else if (a === '--strict') {
      if (strict) return null;
      strict = true;
    } else return null;
  }
  if (positional.length > 1) return null;
  const patch = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  return { format: format ?? 'auto', check, strict, patch };
}

function readEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  switch (kind) {
    case 'json':
      return readJson(text, lines);
    case 'unified':
      return readUnified(lines, strict);
    case 'search-replace':
      return readSearchReplace(lines, strict);
    default:
      return readV4A(lines, strict);
  }
}

function run(args: string[]): { code: number; out: string[] } {
  const opts = parseArgs(args);
  if (opts === null) return { code: 2, out: ['error: usage'] };
  let text: string;
  try {
    text = readFileSync(opts.patch ?? 0, 'utf8');
  } catch {
    if (opts.patch !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = splitPatch(text);
  const kind = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = readEdits(kind, text, lines, opts.strict);
    if (edits.length === 0) throw new Stop('error: parse 1');
  } catch (e) {
    if (e instanceof Stop) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const failures: EditError[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      moves.length = movesBefore;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return { code: 1, out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`] };
  }
  return { code: 0, out: commit(tree, moves, opts.check) };
}

/** Build the exit-0 report and (unless --check) write the tree. */
function commit(tree: Tree, moves: Array<[string, string]>, dryRun: boolean): string[] {
  const rows = new Map<string, string>(); // sort key -> row
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.before(p);
    const is = tree.now.get(p)!;
    if (was === is) continue;
    changed.push(p);
    rows.set(p, `${was === null ? 'A' : is === null ? 'D' : 'M'} ${p}`);
  }
  const used = new Set<string>();
  for (const [from, to] of moves) {
    if (used.has(from) || used.has(to) || from === to) continue;
    const ok = tree.before(from) !== null && tree.get(from) === null && tree.before(to) === null && tree.get(to) !== null;
    if (!ok) continue;
    used.add(from);
    used.add(to);
    rows.delete(from);
    rows.set(to, `R ${from} -> ${to}`);
  }
  const keys = [...rows.keys()].sort(byteOrder);
  if (!dryRun) {
    for (const p of changed.sort(byteOrder)) {
      const v = tree.now.get(p)!;
      if (v === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const v = tree.now.get(p)!;
      if (v === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  const n = keys.length;
  return [...keys.map((k) => rows.get(k)!), `ok: ${n} ${n === 1 ? 'file' : 'files'}`];
}

// ---- unified diffs (SPEC §6): parsing ----

interface Hunk {
  start: number; // A
  body: BodyLine[];
  noEolAfterLast: boolean; // a `\` line follows the last context or `+` line
  noEolAfterLastPlus: boolean; // a `\` line follows the last `+` line
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null | undefined; // undefined: no ---/+++ pair; null: /dev/null
  plus: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newMode: boolean;
  deletedMode: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function diffPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.replace(/^ +/, '').replace(/ +$/, '');
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** `diff --git a/X b/Y` -> [X, Y]; prefers the split where X equals Y. */
function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cuts: number[] = [];
  for (let k = rest.indexOf(' b/'); k >= 0; k = rest.indexOf(' b/', k + 1)) cuts.push(k);
  if (cuts.length === 0) return null;
  const pairs = cuts.map((k) => [rest.slice(2, k), rest.slice(k + 3)] as [string, string]);
  return pairs.find(([x, y]) => x === y) ?? pairs[0]!;
}

const startsPair = (lines: string[], i: number): boolean =>
  lines[i]!.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');

const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';

function newSection(): Section {
  return { gitOld: null, gitNew: null, minus: undefined, plus: undefined, renameFrom: null, renameTo: null, newMode: false, deletedMode: false, hunks: [] };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = gitPaths(l);
      if (g === null) throw new Stop(`error: parse ${i + 1}`);
      cur = newSection();
      [cur.gitOld, cur.gitNew] = g;
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (inHeader && cur !== null && l.startsWith('--- ') && cur.minus === undefined) {
      if (!(i + 1 < lines.length && lines[i + 1]!.startsWith('+++ '))) throw new Stop(`error: parse ${i + 2}`);
      cur.minus = diffPath(l);
      cur.plus = diffPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (startsPair(lines, i)) {
      cur = newSection();
      cur.minus = diffPath(l);
      cur.plus = diffPath(lines[i + 1]!);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEADER.exec(l);
      if (m === null || cur === null) throw new Stop(`error: parse ${i + 1}`);
      i = readHunkBody(lines, i + 1, Number(m[1]), cur);
      inHeader = false;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('--- ')) throw new Stop(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length);
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length);
      else if (l.startsWith('new file mode')) cur.newMode = true;
      else if (l.startsWith('deleted file mode')) cur.deletedMode = true;
    }
    i++;
  }
  return sections;
}

/** Read a hunk body starting at line `i`; returns the index of the first line after it. */
function readHunkBody(lines: string[], i: number, start: number, sec: Section): number {
  const raw: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (!isBodyLine(l) || l.startsWith('diff --git ') || startsPair(lines, j)) break;
    raw.push(l);
    j++;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') {
    raw.pop();
    j--;
  }
  const body: BodyLine[] = [];
  let lastCtxOrPlus = -1; // index in raw
  let lastPlus = -1;
  raw.forEach((l, k) => {
    if (l.startsWith('\\')) return;
    const kind = (l === '' ? ' ' : l[0]) as ' ' | '-' | '+';
    body.push({ kind, text: l.slice(1) });
    if (kind !== '-') lastCtxOrPlus = k;
    if (kind === '+') lastPlus = k;
  });
  const marked = (k: number): boolean => k >= 0 && k + 1 < raw.length && raw[k + 1]!.startsWith('\\');
  sec.hunks.push({ start, body, noEolAfterLast: marked(lastCtxOrPlus), noEolAfterLastPlus: marked(lastPlus) });
  return j;
}

/** Apply a section's hunks to a document (SPEC §6 "Applying hunks"). */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const old = oldOf(h.body);
    const neu = newOf(h.body);
    if (old.length === 0) {
      const at = Math.max(0, Math.min(h.start + d, doc.lines.length));
      const atEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...neu);
      if (atEnd) doc.final = !h.noEolAfterLast;
    } else {
      const found = findTier(doc.lines, old, strict);
      if (found === null) throw new EditError('no-match', path);
      const want = h.start - 1 + d;
      let pos = found.hits[0]!;
      for (const p of found.hits) if (Math.abs(p - want) < Math.abs(pos - want)) pos = p;
      const toEnd = pos + old.length === doc.lines.length;
      const rep = replacement(doc.lines, pos, found.tier, h.body);
      doc.lines.splice(pos, old.length, ...rep);
      if (toEnd) doc.final = !h.noEolAfterLast;
    }
    d += neu.length - old.length;
  }
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const pair = sec.minus !== undefined;
  const oldPath = pair ? sec.minus! : (sec.renameFrom ?? sec.gitOld);
  const newPath = pair ? sec.plus! : (sec.renameTo ?? sec.gitNew);
  const creating = (pair && sec.minus === null) || sec.newMode;
  const deleting = (pair && sec.plus === null) || sec.deletedMode;
  return (tree, moves) => {
    if (creating) {
      const p = (newPath ?? oldPath)!;
      needSafe(p);
      if (tree.get(p) !== null) throw new EditError('exists', p);
      const lines = sec.hunks.flatMap((h) => h.body.filter((b) => b.kind === '+').map((b) => b.text));
      const lastWithPlus = [...sec.hunks].reverse().find((h) => h.body.some((b) => b.kind === '+'));
      const final = !(lastWithPlus?.noEolAfterLastPlus ?? false);
      tree.set(p, fromDoc({ lines, eol: '\n', final }));
      return;
    }
    if (deleting) {
      const p = (oldPath ?? newPath)!;
      needSafe(p);
      if (tree.get(p) === null) throw new EditError('missing', p);
      tree.set(p, null);
      return;
    }
    const from = (oldPath ?? newPath)!;
    const to = (newPath ?? oldPath)!;
    needSafe(from, to);
    const src = tree.get(from);
    if (src === null) throw new EditError('missing', from);
    if (from !== to && tree.get(to) !== null) throw new EditError('exists', to);
    const doc = toDoc(src);
    applyHunks(doc, sec.hunks, strict, from);
    if (from !== to) {
      tree.set(from, null);
      moves.push([from, to]);
    }
    tree.set(to, fromDoc(doc));
  };
}

function readUnified(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => sectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC §7) ----

function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const marker = (k: number, m: string): boolean => lines[k]!.trimEnd() === m;
  let afterPrev = 0; // first line after the previous block
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!marker(i, '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= afterPrev; k--) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    path ??= prevPath;
    if (path === null) throw new Stop(`error: parse ${i + 1}`);
    let eq = i + 1;
    while (eq < lines.length && !marker(eq, '=======')) eq++;
    let end = eq + 1;
    while (end < lines.length && !marker(end, '>>>>>>> REPLACE')) end++;
    if (eq >= lines.length || end >= lines.length) throw new Stop(`error: parse ${i + 1}`);
    const body: BodyLine[] = [
      ...lines.slice(i + 1, eq).map((text) => ({ kind: '-' as const, text })),
      ...lines.slice(eq + 1, end).map((text) => ({ kind: '+' as const, text })),
    ];
    edits.push(blockEdit(path, body, strict));
    prevPath = path;
    afterPrev = end + 1;
    i = end + 1;
  }
  return edits;
}

function blockEdit(path: string, body: BodyLine[], strict: boolean): Edit {
  const old = oldOf(body);
  return (tree) => {
    needSafe(path);
    const src = tree.get(path);
    if (old.length === 0) {
      if (src !== null) throw new EditError('exists', path);
      tree.set(path, fromDoc({ lines: newOf(body), eol: '\n', final: true }));
      return;
    }
    if (src === null) throw new EditError('missing', path);
    const doc = toDoc(src);
    const found = findTier(doc.lines, old, strict);
    if (found === null) throw new EditError('no-match', path);
    if (found.hits.length > 1) throw new EditError('ambiguous', path);
    const pos = found.hits[0]!;
    doc.lines.splice(pos, old.length, ...replacement(doc.lines, pos, found.tier, body));
    tree.set(path, fromDoc(doc));
  };
}

// ---- V4A patches (SPEC §8) ----

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number; // 1-based line of the section header
  rows: Array<{ text: string; n: number }>; // the section's lines (trailing blanks removed)
}

const V4A_HEADS: Array<[string, V4ASection['kind']]> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];

const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function splitV4ASections(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Stop('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Stop(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') throw new Stop(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    const head = V4A_HEADS.find(([prefix]) => l.startsWith(prefix));
    if (head !== undefined) {
      sections.push({ kind: head[1], path: trimSpaces(l.slice(head[0].length)), line: i + 1, rows: [] });
      continue;
    }
    const cur = sections[sections.length - 1];
    if (cur === undefined) {
      if (isBlank(l)) continue;
      throw new Stop(`error: parse ${i + 1}`);
    }
    cur.rows.push({ text: l, n: i + 1 });
  }
  for (const s of sections) while (s.rows.length > 0 && isBlank(s.rows[s.rows.length - 1]!.text)) s.rows.pop();
  return sections;
}

const isV4ABody = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';

/** Chunks of an Update File section; returns the move target (or null) and the chunks. */
function parseUpdate(sec: V4ASection): { moveTo: string | null; chunks: Chunk[] } {
  let k = 0;
  let moveTo: string | null = null;
  if (sec.rows.length > 0 && sec.rows[0]!.text.startsWith('*** Move to: ')) {
    moveTo = trimSpaces(sec.rows[0]!.text.slice('*** Move to: '.length));
    k = 1;
  }
  const chunks: Chunk[] = [];
  let open: Chunk | null = null;
  for (; k < sec.rows.length; k++) {
    const { text, n } = sec.rows[k]!;
    if (text.startsWith('@@')) {
      const a = trimSpaces(text.slice(2));
      open = { anchor: a === '' ? null : a, body: [], eof: false };
      chunks.push(open);
    } else if (text.trim() === '*** End of File' && open !== null) {
      open.eof = true;
      open = null;
    } else if (isV4ABody(text) && (open !== null || chunks.length === 0)) {
      if (open === null) {
        open = { anchor: null, body: [], eof: false };
        chunks.push(open);
      }
      open.body.push({ kind: (text === '' ? ' ' : text[0]) as BodyLine['kind'], text: text.slice(1) });
    } else throw new Stop(`error: parse ${n}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Stop(`error: parse ${sec.line}`);
  return { moveTo, chunks };
}

function applyChunks(doc: Doc, chunks: Chunk[], strict: boolean, path: string): void {
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const hit = findTier(doc.lines, [c.anchor], strict, cursor);
      if (hit === null) throw new EditError('no-match', path);
      cursor = hit.hits[0]! + 1;
    }
    const old = oldOf(c.body);
    const neu = newOf(c.body);
    if (old.length === 0) {
      const at = c.eof ? doc.lines.length : Math.min(cursor, doc.lines.length);
      doc.lines.splice(at, 0, ...neu);
      cursor = at + neu.length;
      continue;
    }
    const len = doc.lines.length;
    const keep = c.eof ? (i: number) => i + old.length === len : undefined;
    const found = findTier(doc.lines, old, strict, cursor, keep);
    if (found === null) throw new EditError('no-match', path);
    const pos = found.hits[0]!;
    const rep = replacement(doc.lines, pos, found.tier, c.body);
    doc.lines.splice(pos, old.length, ...rep);
    cursor = pos + rep.length;
  }
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  const path = sec.path;
  if (sec.kind === 'add') {
    const lines = sec.rows.map(({ text, n }) => {
      if (text === '') return '';
      if (text[0] !== '+') throw new Stop(`error: parse ${n}`);
      return text.slice(1);
    });
    return (tree) => {
      needSafe(path);
      if (tree.get(path) !== null) throw new EditError('exists', path);
      tree.set(path, fromDoc({ lines, eol: '\n', final: true }));
    };
  }
  if (sec.kind === 'delete') {
    if (sec.rows.length > 0) throw new Stop(`error: parse ${sec.rows[0]!.n}`);
    return (tree) => {
      needSafe(path);
      if (tree.get(path) === null) throw new EditError('missing', path);
      tree.set(path, null);
    };
  }
  const { moveTo, chunks } = parseUpdate(sec);
  return (tree, moves) => {
    needSafe(path, ...(moveTo === null ? [] : [moveTo]));
    const src = tree.get(path);
    if (src === null) throw new EditError('missing', path);
    const target = moveTo ?? path;
    if (target !== path && tree.get(target) !== null) throw new EditError('exists', target);
    const doc = toDoc(src);
    applyChunks(doc, chunks, strict, path);
    if (target !== path) {
      tree.set(path, null);
      moves.push([path, target]);
    }
    tree.set(target, fromDoc(doc));
  };
}

function readV4A(lines: string[], strict: boolean): Edit[] {
  return splitV4ASections(lines).map((s) => v4aEdit(s, strict));
}


const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // Trial mode: the kit runner fetches the checks and runs this CLI on each one.
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => l + '\n').join(''));
  process.exitCode = result.code;
}
