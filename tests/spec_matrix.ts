// tests/spec_matrix.ts: extra cases for mend, each tied to a sentence of SPEC.md.
// Run from the repository root: node tests/spec_matrix.ts [filter]
// Every case runs `node main.ts ...` in a fresh temp directory and compares exit code, stdout and the whole tree.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Tree = Record<string, string>;
interface Case {
  name: string; // "§section: what the sentence says"
  args?: string[];
  stdin?: string;
  files: Tree;
  exit: number;
  out: string[]; // stdout lines, each ended by \n
  after?: Tree; // the tree afterwards; omitted = unchanged
}

const MAIN = path.resolve(import.meta.dirname, "..", "main.ts");
export const cases: Case[] = [];
const add = (c: Case) => cases.push(c);

function writeTree(root: string, t: Tree) {
  for (const [p, body] of Object.entries(t)) {
    const full = path.join(root, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

function readTree(root: string, rel = ""): Tree {
  const t: Tree = {};
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) Object.assign(t, readTree(root, r));
    else t[r] = fs.readFileSync(path.join(root, r), "utf8");
  }
  return t;
}

function sameTree(a: Tree, b: Tree): string | null {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    if (!(k in a)) return `unexpected file ${k}`;
    if (!(k in b)) return `missing file ${k}`;
    if (a[k] !== b[k]) return `bytes differ in ${k}: ${JSON.stringify(a[k])} vs expected ${JSON.stringify(b[k])}`;
  }
  return null;
}

export function runCase(c: Case): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-m-"));
  try {
    writeTree(dir, c.files);
    const r = spawnSync(process.execPath, [MAIN, ...(c.args ?? [])], {
      cwd: dir, input: c.stdin ?? "", encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH ?? "" },
    });
    const want = c.out.map((l) => l + "\n").join("");
    if (r.status !== c.exit) return `exit ${r.status}, want ${c.exit}; stdout ${JSON.stringify(r.stdout)}`;
    if (r.stdout !== want) return `stdout ${JSON.stringify(r.stdout)}, want ${JSON.stringify(want)}`;
    return sameTree(readTree(dir), c.after ?? c.files);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- helpers to write patches ----
const L = (...lines: string[]) => lines.map((l) => l + "\n").join("");
const sr = (p: string, o: string[], n: string[]) =>
  L(p, "<<<<<<< SEARCH", ...o, "=======", ...n, ">>>>>>> REPLACE");
const js = (...objs: object[]) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

// ---- §1 Invocation ----
const P1 = sr("a.txt", ["one"], ["ONE"]);
add({ name: "§1 unknown option is a usage error", args: ["-x", "p"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 option given twice", args: ["--check", "--check", "p"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 --format value outside the five names", args: ["--format=diff", "p"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 --format= empty value", args: ["--format=", "p"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 bare --format without value", args: ["--format", "p"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 two --format options (auto then json) is twice", args: ["--format=auto", "--format=json", "p"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 more than one positional", args: ["p", "q"], files: { p: P1, q: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 PATCH plus '-' is two positionals", args: ["p", "-"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§2 usage error wins over no-patch", args: ["nothere", "--bogus"], files: { "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 options may follow PATCH", args: ["p", "--strict"], files: { p: P1, "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { p: P1, "a.txt": "ONE\n" } });
add({ name: "§1 -- ends options: '-x' after it is the PATCH path", args: ["--", "-x"], files: { "-x": P1, "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "-x": P1, "a.txt": "ONE\n" } });
add({ name: "§1 option after -- is a positional (second one = usage)", args: ["p", "--", "--check"], files: { p: P1, "a.txt": "one\n" }, exit: 2, out: ["error: usage"] });
add({ name: "§1 '-' reads standard input", args: ["-"], stdin: P1, files: { "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "ONE\n" } });
add({ name: "§1 no PATCH reads standard input", stdin: P1, files: { "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "ONE\n" } });
add({ name: "§1 --check: same output, nothing written", args: ["--check", "p"], files: { p: P1, "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"] });
add({ name: "§1 --check on a failing patch: same exit 1 output", args: ["--check"], stdin: sr("a.txt", ["zzz"], ["y"]), files: { "a.txt": "one\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§1 PATCH in a subdirectory", args: ["sub/p"], files: { "sub/p": P1, "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "sub/p": P1, "a.txt": "ONE\n" } });

// ---- §2 Output and exit codes ----
add({ name: "§2 unreadable PATCH (absent) is no-patch", args: ["nope.diff"], files: { "a.txt": "one\n" }, exit: 2, out: ["error: no-patch"] });
add({ name: "§2 PATCH that is a directory is no-patch", args: ["d"], files: { "d/x": "1\n" }, exit: 2, out: ["error: no-patch"] });
add({ name: "§2/§4 nothing detectable is error: format", stdin: L("just prose", "no patch here"), files: {}, exit: 2, out: ["error: format"] });
add({ name: "§2/§4 empty input is error: format", stdin: "", files: {}, exit: 2, out: ["error: format"] });
add({ name: "§2 parse error reported before files are looked at", stdin: sr("missing.txt", ["a"], ["b"]) + L("<<<<<<< SEARCH", "x"), files: {}, exit: 2, out: ["error: parse 7"] });
add({ name: "§2 a patch that changes nothing prints ok: 0 files", stdin: sr("a.txt", ["one"], ["one"]), files: { "a.txt": "one\n" }, exit: 0, out: ["ok: 0 files"] });
add({ name: "§2 changed paths in UTF-8 byte order", stdin: js({ command: "create", path: "b", file_text: "" }, { command: "create", path: "a", file_text: "" }, { command: "create", path: "B", file_text: "" }, { command: "create", path: "é", file_text: "" }, { command: "create", path: "z/a", file_text: "" }), files: {}, exit: 0, out: ["A B", "A a", "A b", "A z/a", "A é", "ok: 5 files"], after: { a: "", b: "", B: "", "é": "", "z/a": "" } });
add({ name: "§2 created then deleted file is not listed", stdin: L("*** Begin Patch", "*** Add File: t.txt", "+x", "*** Delete File: t.txt", "*** End Patch"), files: {}, exit: 0, out: ["ok: 0 files"] });
add({ name: "§2 deleted then re-added with same bytes is not listed", stdin: L("*** Begin Patch", "*** Delete File: a.txt", "*** Add File: a.txt", "+one", "*** End Patch"), files: { "a.txt": "one\n" }, exit: 0, out: ["ok: 0 files"] });
add({ name: "§2 every failure reported, in patch order, then failed k of n", stdin: sr("a.txt", ["nope"], ["x"]) + sr("b.txt", ["two"], ["TWO"]) + sr("c.txt", ["q"], ["r"]), files: { "a.txt": "one\n", "b.txt": "two\n" }, exit: 1, out: ["error: no-match a.txt", "error: missing c.txt", "failed: 2 of 3 edits"] });
add({ name: "§2 R line when moved path's old is gone and new is new", stdin: L("*** Begin Patch", "*** Update File: a.txt", "*** Move to: z/b.txt", "*** End Patch"), files: { "a.txt": "one\n" }, exit: 0, out: ["R a.txt -> z/b.txt", "ok: 1 file"], after: { "z/b.txt": "one\n" } });
add({ name: "§2 R sorts by its new path", stdin: L("*** Begin Patch", "*** Update File: m.txt", "*** Move to: a.txt", "*** Add File: b.txt", "+n", "*** End Patch"), files: { "m.txt": "one\n" }, exit: 0, out: ["R m.txt -> a.txt", "A b.txt", "ok: 2 files"], after: { "a.txt": "one\n", "b.txt": "n\n" } });
add({ name: "§2 move whose old path is re-created is not R", stdin: L("*** Begin Patch", "*** Update File: a.txt", "*** Move to: b.txt", "*** Add File: a.txt", "+fresh", "*** End Patch"), files: { "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "A b.txt", "ok: 2 files"], after: { "a.txt": "fresh\n", "b.txt": "one\n" } });

// ---- §3 Files, lines and paths ----
add({ name: "§3 CRLF file keeps CRLF breaks", stdin: sr("a.txt", ["a"], ["A"]), files: { "a.txt": "a\r\nb\r\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\r\nb\r\n" } });
add({ name: "§3 break decided by the first line feed only (LF): a later \\r stays in its line", stdin: sr("a.txt", ["b"], ["B"]), files: { "a.txt": "a\nb\r\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§3 file without final break keeps none", stdin: sr("a.txt", ["a"], ["A"]), files: { "a.txt": "a\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\nb" } });
add({ name: "§3 last line replaced in file without final break", stdin: sr("a.txt", ["b"], ["B", "C"]), files: { "a.txt": "a\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nB\nC" } });
add({ name: "§3 a file of no lines is written empty", stdin: sr("a.txt", ["only"], []), files: { "a.txt": "only\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "" } });
add({ name: "§3 CRLF file reduced to no lines is empty", stdin: sr("a.txt", ["x"], []), files: { "a.txt": "x\r\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "" } });
add({ name: "§3 patch lines lose one trailing \\r (CRLF patch)", stdin: sr("a.txt", ["one"], ["ONE"]).replace(/\n/g, "\r\n"), files: { "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "ONE\n" } });
for (const bad of ["./a.txt", "a//b", "a\\b", "/abs", "../x", "d/..", "d/./e"]) {
  add({ name: `§3 unsafe path ${JSON.stringify(bad)}`, stdin: sr(bad, ["q"], ["r"]), files: { "a.txt": "q\n" }, exit: 1, out: [`error: unsafe ${bad}`, "failed: 1 of 1 edits"] });
}
add({ name: "§10 safety checked before existence (create)", stdin: js({ command: "create", path: "../evil", file_text: "x" }), files: {}, exit: 1, out: ["error: unsafe ../evil", "failed: 1 of 1 edits"] });
add({ name: "§3 directories created as files need them", stdin: js({ command: "create", path: "p/q/r.txt", file_text: "z" }), files: {}, exit: 0, out: ["A p/q/r.txt", "ok: 1 file"], after: { "p/q/r.txt": "z" } });

// ---- §4 Detecting the format ----
const V4 = L("*** Begin Patch", "*** Add File: n.txt", "+hi", "*** End Patch");
add({ name: "§4 v4a after blank lines, Begin Patch with surrounding whitespace", stdin: "\n  \n  *** Begin Patch  \n*** Add File: n.txt\n+hi\n*** End Patch\n", files: {}, exit: 0, out: ["A n.txt", "ok: 1 file"], after: { "n.txt": "hi\n" } });
add({ name: "§4 v4a wins over SEARCH markers inside it", stdin: L("*** Begin Patch", "*** Add File: n.txt", "+<<<<<<< SEARCH", "*** End Patch"), files: {}, exit: 0, out: ["A n.txt", "ok: 1 file"], after: { "n.txt": "<<<<<<< SEARCH\n" } });
add({ name: "§4 json: first non-blank line starts with whitespace then [", stdin: "\n   [\n" + JSON.stringify({ command: "create", path: "j", file_text: "1" }) + "\n]\n", files: {}, exit: 0, out: ["A j", "ok: 1 file"], after: { j: "1" } });
add({ name: "§4/§9 json array fault: parse names the array's first line", stdin: "\n\n  [\n  {\"command\": \"create\"}\n]\n", files: {}, exit: 2, out: ["error: parse 3"] });
add({ name: "§4 SEARCH marker with trailing whitespace detected", stdin: L("a.txt", "<<<<<<< SEARCH \t", "one", "=======  ", "ONE", ">>>>>>> REPLACE\t"), files: { "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "ONE\n" } });
add({ name: "§4 SEARCH marker with leading whitespace is not a marker", stdin: L("a.txt", " <<<<<<< SEARCH", "one"), files: { "a.txt": "one\n" }, exit: 2, out: ["error: format"] });
add({ name: "§4 '--- '/'+++ ' pair alone detects unified", stdin: L("--- a.txt", "+++ a.txt", "@@ -1 +1 @@", "-one", "+ONE"), files: { "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "ONE\n" } });
add({ name: "§4 '---' without space is not a unified header", stdin: L("---a.txt", "+++a.txt"), files: {}, exit: 2, out: ["error: format"] });
add({ name: "§4 forced format reads text as that format (SR as unified: no edit)", args: ["--format=unified"], stdin: P1, files: { "a.txt": "one\n" }, exit: 2, out: ["error: parse 1"] });
add({ name: "§4 forced v4a on non-v4a text: parse at first non-blank line", args: ["--format=v4a"], stdin: L("", "hello"), files: {}, exit: 2, out: ["error: parse 2"] });

// ---- §5 Matching lines ----
add({ name: "§5 tier 1: trailing spaces/tabs ignored", stdin: sr("a.txt", ["foo"], ["FOO"]), files: { "a.txt": "foo \t\nbar\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "FOO\nbar\n" } });
add({ name: "§5 --strict: tier 0 only", args: ["--strict"], stdin: sr("a.txt", ["foo"], ["FOO"]), files: { "a.txt": "foo \nbar\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§5 tier 2 re-indents N by replacing P with F", stdin: sr("a.py", ["if x:", "    y"], ["if z:", "    w", "", "q"]), files: { "a.py": "    if x:\n        y\n" }, exit: 0, out: ["M a.py", "ok: 1 file"], after: { "a.py": "    if z:\n        w\n\n    q\n" } });
add({ name: "§5 tier 2: N line not starting with P is written as is", stdin: sr("a.txt", ["  A", "  B"], ["  C", "D", "   "]), files: { "a.txt": "\tA\n\tB\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "\tC\nD\n   \n" } });
add({ name: "§5 tier 1 does not re-indent", stdin: sr("a.txt", ["  A"], ["    B"]), files: { "a.txt": "  A \n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "    B\n" } });
add({ name: "§5 tier 0 occurrence wins over a nearer tier-1 one", stdin: L("--- a.txt", "+++ a.txt", "@@ -1 +1 @@", "-x", "+X"), files: { "a.txt": "x \nm\nm\nm\nx\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "x \nm\nm\nm\nX\n" } });
add({ name: "§5 context line written as the file's own line", stdin: L("--- a.txt", "+++ a.txt", "@@ -1,2 +1,2 @@", " a", "-b", "+B"), files: { "a.txt": "a  \nb\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a  \nB\n" } });
add({ name: "§5 tier 2 in V4A: context kept, + line re-indented", stdin: L("*** Begin Patch", "*** Update File: a.txt", " a", "-b", "+c", "*** End Patch"), files: { "a.txt": "    a\n    b\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "    a\n    c\n" } });

// ---- §6 Unified diffs ----
const U = (p: string, ...body: string[]) => L(`--- a/${p}`, `+++ b/${p}`, ...body);
const ten = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
add({ name: "§6 nearest occurrence to A-1+d", stdin: U("a.txt", "@@ -6 +6 @@", "-x", "+X"), files: { "a.txt": "x\nm\nm\nx\nm\nm\nm\nx\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "x\nm\nm\nX\nm\nm\nm\nx\n" } });
add({ name: "§6 equally near occurrences: the earlier", stdin: U("a.txt", "@@ -3 +3 @@", "-x", "+X"), files: { "a.txt": "x\nm\nm\nm\nx\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "X\nm\nm\nm\nx\n" } });
add({ name: "§6 d shifts later hunks by earlier growth", stdin: U("a.txt", "@@ -1 +1,3 @@", "-x", "+X", "+n", "+n", "@@ -3 +5 @@", "-x", "+Y"), files: { "a.txt": "x\nm\nx\nm\nx\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "X\nn\nn\nm\nY\nm\nx\n" } });
add({ name: "§6 empty O inserts after the first A+d lines", stdin: U("a.txt", "@@ -2,0 +3 @@", "+new"), files: { "a.txt": "a\nb\nc\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nb\nnew\nc\n" } });
add({ name: "§6 empty O with A past the end appends", stdin: U("a.txt", "@@ -40,0 +41 @@", "+end"), files: { "a.txt": "a\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nb\nend\n" } });
add({ name: "§6 empty O, A=0 inserts at top", stdin: U("a.txt", "@@ -0,0 +1 @@", "+top"), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "top\na\n" } });
add({ name: "§6 hunk reaching EOF without '\\' line adds final break", stdin: U("a.txt", "@@ -2 +2 @@", "-b", "+B"), files: { "a.txt": "a\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nB\n" } });
add({ name: "§6 '\\' after last + line: no final break", stdin: U("a.txt", "@@ -2 +2 @@", "-b", "\\ No newline at end of file", "+B", "\\ No newline at end of file"), files: { "a.txt": "a\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nB" } });
add({ name: "§6 '\\' after old line only: result gains a break", stdin: U("a.txt", "@@ -2 +2 @@", "-b", "\\ No newline at end of file", "+B"), files: { "a.txt": "a\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nB\n" } });
add({ name: "§6 hunk not at EOF keeps the final break as it was", stdin: U("a.txt", "@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\nb" } });
add({ name: "§6 removing a break: '\\' after last context line", stdin: U("a.txt", "@@ -1,2 +1 @@", " a", "\\ No newline at end of file", "-b"), files: { "a.txt": "a\nb\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a" } });
add({ name: "§6 creation: + lines, final break", stdin: L("--- /dev/null", "+++ b/n/new.txt", "@@ -0,0 +1,2 @@", "+x", "+y"), files: {}, exit: 0, out: ["A n/new.txt", "ok: 1 file"], after: { "n/new.txt": "x\ny\n" } });
add({ name: "§6 creation with '\\' after last + line: no final break", stdin: L("--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+x", "\\ No newline at end of file"), files: {}, exit: 0, out: ["A new.txt", "ok: 1 file"], after: { "new.txt": "x" } });
add({ name: "§6 creation of existing path is exists", stdin: L("--- /dev/null", "+++ b/a.txt", "@@ -0,0 +1 @@", "+x"), files: { "a.txt": "a\n" }, exit: 1, out: ["error: exists a.txt", "failed: 1 of 1 edits"] });
add({ name: "§6 new file mode makes a creation (diff --git paths)", stdin: L("diff --git a/n.txt b/n.txt", "new file mode 100644", "index 0000000..1111111", "@@ -0,0 +1 @@", "+hi"), files: {}, exit: 0, out: ["A n.txt", "ok: 1 file"], after: { "n.txt": "hi\n" } });
add({ name: "§6 deletion: hunks not read", stdin: L("--- a/a.txt", "+++ /dev/null", "@@ -1,9 +0,0 @@", "-not what the file holds"), files: { "a.txt": "a\n", "k.txt": "k\n" }, exit: 0, out: ["D a.txt", "ok: 1 file"], after: { "k.txt": "k\n" } });
add({ name: "§6 deleted file mode with only diff --git paths", stdin: L("diff --git a/a.txt b/a.txt", "deleted file mode 100644"), files: { "a.txt": "a\n", "k": "" }, exit: 0, out: ["D a.txt", "ok: 1 file"], after: { k: "" } });
add({ name: "§6 deletion of missing file is missing", stdin: L("--- a/q.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-q"), files: {}, exit: 1, out: ["error: missing q.txt", "failed: 1 of 1 edits"] });
add({ name: "§6 pure rename via diff --git + rename from/to", stdin: L("diff --git a/a.txt b/d/b.txt", "similarity index 100%", "rename from a.txt", "rename to d/b.txt"), files: { "a.txt": "a\n" }, exit: 0, out: ["R a.txt -> d/b.txt", "ok: 1 file"], after: { "d/b.txt": "a\n" } });
add({ name: "§6 move with hunk: applied then written at new path", stdin: L("--- a/a.txt", "+++ b/b.txt", "@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 0, out: ["R a.txt -> b.txt", "ok: 1 file"], after: { "b.txt": "A\n" } });
add({ name: "§6 move onto existing path is exists (new path named)", stdin: L("--- a/a.txt", "+++ b/b.txt", "@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\n", "b.txt": "b\n" }, exit: 1, out: ["error: exists b.txt", "failed: 1 of 1 edits"] });
add({ name: "§6 change of missing file is missing", stdin: U("z.txt", "@@ -1 +1 @@", "-a", "+A"), files: {}, exit: 1, out: ["error: missing z.txt", "failed: 1 of 1 edits"] });
add({ name: "§6 failing second hunk fails the whole section", stdin: U("a.txt", "@@ -1 +1 @@", "-a", "+A", "@@ -2 +2 @@", "-nope", "+N"), files: { "a.txt": "a\nb\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§6 path ends at tab; surrounding spaces removed", stdin: L("---  a/a.txt\t2026-01-01 00:00", "+++ b/a.txt  \t(working copy)", "@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\n" } });
add({ name: "§6 prose and code fences outside bodies ignored", stdin: L("Here is the fix:", "```diff", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-a", "+A", "```", "Done."), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\n" } });
add({ name: "§6 empty body line is empty context; trailing empty lines dropped", stdin: U("a.txt", "@@ -1,3 +1,3 @@", " a", "", "-c", "+C", "", ""), files: { "a.txt": "a\n\nc\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\n\nC\n" } });
add({ name: "§6 '---' not followed by '+++' inside a header: parse at line after", stdin: L("diff --git a/a.txt b/a.txt", "--- a/a.txt", "index 123", "@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 3"] });
add({ name: "§6 malformed @@ line is parse at its line", stdin: U("a.txt", "@@ -1 +1", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 3"] });
add({ name: "§6 hunk before any section is parse", args: ["--format=unified"], stdin: L("@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 1"] });
add({ name: "§6 malformed diff --git line is parse", stdin: L("diff --git a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 1"] });
add({ name: "§6 two sections, two edits, one failing", stdin: U("a.txt", "@@ -1 +1 @@", "-a", "+A") + U("b.txt", "@@ -1 +1 @@", "-zz", "+B"), files: { "a.txt": "a\n", "b.txt": "b\n" }, exit: 1, out: ["error: no-match b.txt", "failed: 1 of 2 edits"] });
add({ name: "§6 unsafe path named after a/ prefix removal", stdin: L("--- a/../x", "+++ b/../x", "@@ -1 +1 @@", "-a", "+A"), files: {}, exit: 1, out: ["error: unsafe ../x", "failed: 1 of 1 edits"] });
add({ name: "§6 body ends at next '---'/'+++' pair (no blank line)", stdin: L("--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-a", "+A", "--- a/b.txt", "+++ b/b.txt", "@@ -1 +1 @@", "-b", "+B"), files: { "a.txt": "a\n", "b.txt": "b\n" }, exit: 0, out: ["M a.txt", "M b.txt", "ok: 2 files"], after: { "a.txt": "A\n", "b.txt": "B\n" } });
add({ name: "§6 '--- ' as old line in body when not followed by '+++ '", stdin: U("a.txt", "@@ -1,2 +1 @@", " a", "--- x"), files: { "a.txt": "a\n-- x\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\n" } });

// ---- §7 SEARCH/REPLACE ----
const SRB = (o: string[], n: string[]) => L("<<<<<<< SEARCH", ...o, "=======", ...n, ">>>>>>> REPLACE");
add({ name: "§7 block without path takes previous block's path", stdin: sr("a.txt", ["a"], ["A"]) + SRB(["b"], ["B"]), files: { "a.txt": "a\nb\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\nB\n" } });
add({ name: "§7 first block with no path: parse at its SEARCH line", stdin: L("", "```") + SRB(["a"], ["A"]), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 3"] });
add({ name: "§7 fence lines skipped when finding the path", stdin: L("Edit this:", "a.txt", "```python") + SRB(["a"], ["A"]) + L("```"), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\n" } });
add({ name: "§7 path line trimmed of surrounding whitespace", stdin: L("   d/a.txt  ") + SRB(["a"], ["A"]), files: { "d/a.txt": "a\n" }, exit: 0, out: ["M d/a.txt", "ok: 1 file"], after: { "d/a.txt": "A\n" } });
add({ name: "§7 SEARCH without ======= then REPLACE: parse at SEARCH", stdin: L("a.txt", "x", "<<<<<<< SEARCH", "a", ">>>>>>> REPLACE"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 3"] });
add({ name: "§7 SEARCH with ======= but no REPLACE: parse at SEARCH", stdin: L("a.txt", "<<<<<<< SEARCH", "a", "=======", "A"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 2"] });
add({ name: "§7 empty old lines create the file (LF, final break)", stdin: sr("n/new.txt", [], ["x", "y"]), files: {}, exit: 0, out: ["A n/new.txt", "ok: 1 file"], after: { "n/new.txt": "x\ny\n" } });
add({ name: "§7 create onto existing file is exists", stdin: sr("a.txt", [], ["x"]), files: { "a.txt": "a\n" }, exit: 1, out: ["error: exists a.txt", "failed: 1 of 1 edits"] });
add({ name: "§7 two occurrences at the found tier is ambiguous", stdin: sr("a.txt", ["x"], ["X"]), files: { "a.txt": "x\ny\nx\n" }, exit: 1, out: ["error: ambiguous a.txt", "failed: 1 of 1 edits"] });
add({ name: "§7 overlapping occurrences count (ambiguous)", stdin: sr("a.txt", ["x", "x"], ["y"]), files: { "a.txt": "x\nx\nx\n" }, exit: 1, out: ["error: ambiguous a.txt", "failed: 1 of 1 edits"] });
add({ name: "§7 one tier-0 occurrence is not ambiguous despite tier-1 twins", stdin: sr("a.txt", ["x"], ["X"]), files: { "a.txt": "x \nx\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "x \nX\n" } });
add({ name: "§7 missing file with non-empty old is missing", stdin: sr("q.txt", ["a"], ["b"]), files: {}, exit: 1, out: ["error: missing q.txt", "failed: 1 of 1 edits"] });
add({ name: "§7 later block sees earlier block's result", stdin: sr("a.txt", ["a"], ["b"]) + sr("a.txt", ["b"], ["c"]), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "c\n" } });

// ---- §8 V4A ----
const V = (...body: string[]) => L("*** Begin Patch", ...body, "*** End Patch");
add({ name: "§8 last non-blank line not End Patch: parse lines+1", stdin: L("*** Begin Patch", "*** Add File: n", "+x", ""), files: {}, exit: 2, out: ["error: parse 5"] });
add({ name: "§8 forced v4a on empty input: parse 1", args: ["--format=v4a"], stdin: "\n\n", files: {}, exit: 2, out: ["error: parse 1"] });
add({ name: "§8 unknown line between sections: parse at it", stdin: V("*** Add File: n", "+x", "garbage"), files: {}, exit: 2, out: ["error: parse 4"] });
add({ name: "§8 Delete File section with a line: parse", stdin: V("*** Delete File: a.txt", "-a"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 3"] });
add({ name: "§8 Update with no chunk and no Move to: parse at Update line", stdin: V("*** Update File: a.txt"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 2"] });
add({ name: "§8 Add File: empty line is an empty file line; final break", stdin: V("*** Add File: n.txt", "+a", "", "+b"), files: {}, exit: 0, out: ["A n.txt", "ok: 1 file"], after: { "n.txt": "a\n\nb\n" } });
add({ name: "§8 Add File: blank lines at section end are not part of it", stdin: V("*** Add File: n.txt", "+a", "", "", "*** Add File: m.txt", "+b"), files: {}, exit: 0, out: ["A m.txt", "A n.txt", "ok: 2 files"], after: { "n.txt": "a\n", "m.txt": "b\n" } });
add({ name: "§8 Add File onto existing is exists", stdin: V("*** Add File: a.txt", "+x"), files: { "a.txt": "a\n" }, exit: 1, out: ["error: exists a.txt", "failed: 1 of 1 edits"] });
add({ name: "§8 Delete File of missing is missing", stdin: V("*** Delete File: q.txt"), files: {}, exit: 1, out: ["error: missing q.txt", "failed: 1 of 1 edits"] });
add({ name: "§8 anchor moves the cursor; chunk takes first occurrence after it", stdin: V("*** Update File: a.py", "@@ def g():", "-    return 1", "+    return 2"), files: { "a.py": "def f():\n    return 1\ndef g():\n    return 1\n" }, exit: 0, out: ["M a.py", "ok: 1 file"], after: { "a.py": "def f():\n    return 1\ndef g():\n    return 2\n" } });
add({ name: "§8 anchor matched at tier 2", stdin: V("*** Update File: a.py", "@@ class A:", "-  x = 1", "+  x = 2"), files: { "a.py": "  class A:  \n  x = 1\n" }, exit: 0, out: ["M a.py", "ok: 1 file"], after: { "a.py": "  class A:  \n  x = 2\n" } });
add({ name: "§8 anchor not found is no-match", stdin: V("*** Update File: a.txt", "@@ nothing", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§8 second chunk searches after first chunk's written lines", stdin: V("*** Update File: a.txt", "@@", "-x", "+X", "@@", "-x", "+Y"), files: { "a.txt": "x\nm\nx\nx\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "X\nm\nY\nx\n" } });
add({ name: "§8 occurrence before the cursor is not taken", stdin: V("*** Update File: a.txt", "@@ m", "-x", "+X"), files: { "a.txt": "x\nm\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§8 End of File chunk takes the occurrence ending at last line", stdin: V("*** Update File: a.txt", "-x", "+X", "*** End of File"), files: { "a.txt": "x\nm\nx\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "x\nm\nX\n" } });
add({ name: "§8 End of File chunk with empty O appends", stdin: V("*** Update File: a.txt", "+z", "*** End of File"), files: { "a.txt": "a\nb\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nb\nz\n" } });
add({ name: "§8 empty O inserts at the cursor (after anchor)", stdin: V("*** Update File: a.txt", "@@ a", "+ins"), files: { "a.txt": "a\nb\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nins\nb\n" } });
add({ name: "§8 Update keeps file's CRLF and missing final break", stdin: V("*** Update File: a.txt", "-b", "+B"), files: { "a.txt": "a\r\nb" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\r\nB" } });
add({ name: "§8 Move to existing path is exists", stdin: V("*** Update File: a.txt", "*** Move to: b.txt", "-a", "+A"), files: { "a.txt": "a\n", "b.txt": "b\n" }, exit: 1, out: ["error: exists b.txt", "failed: 1 of 1 edits"] });
add({ name: "§8 Update of missing file is missing", stdin: V("*** Update File: q.txt", "-a", "+A"), files: {}, exit: 1, out: ["error: missing q.txt", "failed: 1 of 1 edits"] });
add({ name: "§8 Move to with chunk: R line, changed content", stdin: V("*** Update File: a.txt", "*** Move to: b/c.txt", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 0, out: ["R a.txt -> b/c.txt", "ok: 1 file"], after: { "b/c.txt": "A\n" } });
add({ name: "§8 path after Add File: trimmed", stdin: V("*** Add File:   s p.txt  ", "+x"), files: {}, exit: 0, out: ["A s p.txt", "ok: 1 file"], after: { "s p.txt": "x\n" } });

// ---- §9 JSON edits ----
add({ name: "§9 create writes file_text byte for byte (no break added)", stdin: js({ command: "create", path: "c.txt", file_text: "a\r\nb" }), files: {}, exit: 0, out: ["A c.txt", "ok: 1 file"], after: { "c.txt": "a\r\nb" } });
add({ name: "§9 create onto existing is exists", stdin: js({ command: "create", path: "a.txt", file_text: "x" }), files: { "a.txt": "a\n" }, exit: 1, out: ["error: exists a.txt", "failed: 1 of 1 edits"] });
add({ name: "§9 str_replace: new_str absent is empty", stdin: js({ command: "str_replace", path: "a.txt", old_str: "b\n" }), files: { "a.txt": "a\nb\nc\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nc\n" } });
add({ name: "§9 str_replace in CRLF file reads \\r\\n as \\n and writes CRLF", stdin: js({ command: "str_replace", path: "a.txt", old_str: "a\nb", new_str: "x\ny\nz" }), files: { "a.txt": "a\r\nb\r\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "x\r\ny\r\nz\r\n" } });
add({ name: "§9 str_replace CRLF strings normalised too", stdin: js({ command: "str_replace", path: "a.txt", old_str: "a\r\nb", new_str: "B\r\n" }), files: { "a.txt": "a\r\nb\r\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "B\r\n\r\n" } });
add({ name: "§9 str_replace overlapping occurrences are ambiguous", stdin: js({ command: "str_replace", path: "a.txt", old_str: "aa", new_str: "b" }), files: { "a.txt": "aaa" }, exit: 1, out: ["error: ambiguous a.txt", "failed: 1 of 1 edits"] });
add({ name: "§9 str_replace is exact: no tiers", stdin: js({ command: "str_replace", path: "a.txt", old_str: "foo\n", new_str: "x" }), files: { "a.txt": "foo \n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§9 str_replace of missing file is missing", stdin: js({ command: "str_replace", path: "q", old_str: "a", new_str: "b" }), files: {}, exit: 1, out: ["error: missing q", "failed: 1 of 1 edits"] });
add({ name: "§9 str_replace with empty old_str is a parse fault", stdin: js({ command: "str_replace", path: "a.txt", old_str: "", new_str: "b" }), files: { "a.txt": "a" }, exit: 2, out: ["error: parse 1"] });
add({ name: "§9 insert keeps the file's (absent) final break", stdin: js({ command: "insert", path: "a.txt", insert_line: 1, new_str: "b\n" }), files: { "a.txt": "a" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nb" } });
add({ name: "§9 insert into empty file", stdin: js({ command: "insert", path: "e", insert_line: 0, new_str: "x\ny" }), files: { e: "" }, exit: 0, out: ["M e", "ok: 1 file"], after: { e: "x\ny" } });
add({ name: "§9 insert in CRLF file uses CRLF, new_str \\r stripped", stdin: js({ command: "insert", path: "a.txt", insert_line: 0, new_str: "t\r\n" }), files: { "a.txt": "a\r\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "t\r\na\r\n" } });
add({ name: "§9 insert with empty new_str changes nothing", stdin: js({ command: "insert", path: "a.txt", insert_line: 1, new_str: "" }), files: { "a.txt": "a\n" }, exit: 0, out: ["ok: 0 files"] });
add({ name: "§9 insert_line past the line count is no-match", stdin: js({ command: "insert", path: "a.txt", insert_line: 2, new_str: "x" }), files: { "a.txt": "a\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§9 negative insert_line is no-match", stdin: js({ command: "insert", path: "a.txt", insert_line: -1, new_str: "x" }), files: { "a.txt": "a\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 1 edits"] });
add({ name: "§9 non-integer insert_line is a parse fault", stdin: js({ command: "insert", path: "a.txt", insert_line: 1.5, new_str: "x" }), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 1"] });
add({ name: "§9 wrong command is a parse fault (JSON Lines: that line)", stdin: "\n" + js({ command: "create", path: "x", file_text: "" }, { command: "view", path: "a.txt" }), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 3"] });
add({ name: "§9 extra keys ignored", stdin: js({ command: "create", path: "x", file_text: "1", mode: 420, note: "hi" }), files: {}, exit: 0, out: ["A x", "ok: 1 file"], after: { x: "1" } });
add({ name: "§9 JSON Lines: invalid JSON line is parse at that line", stdin: js({ command: "create", path: "x", file_text: "" }) + "\n{oops\n", files: {}, exit: 2, out: ["error: parse 3"] });
add({ name: "§9 array with a non-object element: parse at array start", stdin: "[\n" + JSON.stringify({ command: "create", path: "x", file_text: "" }) + ",\n 5\n]\n", files: {}, exit: 2, out: ["error: parse 1"] });
add({ name: "§9 path must be a string", stdin: js({ command: "create", path: 7, file_text: "" }), files: {}, exit: 2, out: ["error: parse 1"] });
add({ name: "§9 empty array is no edit: parse 1", stdin: "[]\n", files: {}, exit: 2, out: ["error: parse 1"] });

// ---- §10 Order and atomicity ----
add({ name: "§10 later edit sees a file an earlier one created", stdin: js({ command: "create", path: "n", file_text: "a\n" }, { command: "str_replace", path: "n", old_str: "a", new_str: "b" }), files: {}, exit: 0, out: ["A n", "ok: 1 file"], after: { n: "b\n" } });
add({ name: "§10 later edit sees a file an earlier one deleted", stdin: V("*** Delete File: a.txt", "*** Update File: a.txt", "-a", "+b"), files: { "a.txt": "a\n" }, exit: 1, out: ["error: missing a.txt", "failed: 1 of 2 edits"] });
add({ name: "§10 any failure: no file written, even successful ones", stdin: js({ command: "create", path: "ok.txt", file_text: "x" }, { command: "str_replace", path: "a.txt", old_str: "zz", new_str: "y" }), files: { "a.txt": "a\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 2 edits"] });
add({ name: "§10 a failed edit changes nothing; later edits use the unchanged tree", stdin: sr("a.txt", ["a", "nope"], ["X"]) + sr("a.txt", ["a"], ["Y"]), files: { "a.txt": "a\n" }, exit: 1, out: ["error: no-match a.txt", "failed: 1 of 2 edits"] });

// ---- extra corners ----
add({ name: "§6 diff --git paths with spaces (no ---/+++)", stdin: L("diff --git a/my file.txt b/my file.txt", "new file mode 100644", "@@ -0,0 +1 @@", "+hi"), files: {}, exit: 0, out: ["A my file.txt", "ok: 1 file"], after: { "my file.txt": "hi\n" } });
add({ name: "§6 Index: and index lines ignored", stdin: L("Index: a.txt", "===================================================================", "--- a.txt", "+++ a.txt", "@@ -1 +1 @@", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\n" } });
add({ name: "§6 @@ header with trailing text accepted", stdin: U("a.txt", "@@ -1,2 +1,2 @@ def f():", " a", "-b", "+B"), files: { "a.txt": "a\nb\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nB\n" } });
add({ name: "§6 @@ header missing space before closing @@ is parse", stdin: U("a.txt", "@@ -1 +1@@", "-a", "+A"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 3"] });
add({ name: "§6 tier-2 hunk re-indents + lines, keeps context", stdin: U("a.py", "@@ -1,2 +1,2 @@", " if x:", "-    y()", "+    z()"), files: { "a.py": "\tif x:\n\t    y()\n" }, exit: 0, out: ["M a.py", "ok: 1 file"], after: { "a.py": "\tif x:\n\t    z()\n" } });
add({ name: "§6 second section on same file sees the first's result", stdin: U("a.txt", "@@ -1 +1 @@", "-a", "+b") + U("a.txt", "@@ -1 +1 @@", "-b", "+c"), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "c\n" } });
add({ name: "§6 move of missing old path is missing (old path named)", stdin: L("--- a/x.txt", "+++ b/y.txt", "@@ -1 +1 @@", "-a", "+A"), files: {}, exit: 1, out: ["error: missing x.txt", "failed: 1 of 1 edits"] });
add({ name: "§6 no-op change is not listed", stdin: U("a.txt", "@@ -1 +1 @@", "-a", "+a"), files: { "a.txt": "a\n" }, exit: 0, out: ["ok: 0 files"] });
add({ name: "§7 prose line before SEARCH is taken as the path", stdin: L("Change this in a.txt:") + SRB(["a"], ["A"]), files: { "a.txt": "a\n" }, exit: 1, out: ["error: missing Change this in a.txt:", "failed: 1 of 1 edits"] });
add({ name: "§7 whitespace-only line is blank, skipped for the path", stdin: L("a.txt", "   \t") + SRB(["a"], ["A"]), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\n" } });
add({ name: "§7 tier-2 SR deletion of lines", stdin: sr("a.txt", ["b", "c"], []), files: { "a.txt": "a\n  b\n  c\nd\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "a\nd\n" } });
add({ name: "§8 Move to an unsafe path is unsafe", stdin: V("*** Update File: a.txt", "*** Move to: ../b.txt"), files: { "a.txt": "a\n" }, exit: 1, out: ["error: unsafe ../b.txt", "failed: 1 of 1 edits"] });
add({ name: "§8 update whose result equals the original is not listed", stdin: V("*** Update File: a.txt", "-a", "+a"), files: { "a.txt": "a\n" }, exit: 0, out: ["ok: 0 files"] });
add({ name: "§8 later edit sees a moved file at its new path", stdin: V("*** Update File: a.txt", "*** Move to: b.txt", "*** Update File: b.txt", "-a", "+B"), files: { "a.txt": "a\n" }, exit: 0, out: ["R a.txt -> b.txt", "ok: 1 file"], after: { "b.txt": "B\n" } });
add({ name: "§8 End Patch with surrounding whitespace and trailing blank lines", stdin: "*** Begin Patch\n*** Add File: n\n+x\n  *** End Patch \n\n\n", files: {}, exit: 0, out: ["A n", "ok: 1 file"], after: { n: "x\n" } });
add({ name: "§8 Update File in CRLF patch", stdin: V("*** Update File: a.txt", "-a", "+A").replace(/\n/g, "\r\n"), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "A\n" } });
add({ name: "§9 pretty-printed single object is JSON Lines: parse 1", stdin: "{\n  \"command\": \"create\",\n  \"path\": \"x\",\n  \"file_text\": \"\"\n}\n", files: {}, exit: 2, out: ["error: parse 1"] });
add({ name: "§9 array spanning lines applies every edit", stdin: "[\n  " + JSON.stringify({ command: "create", path: "p", file_text: "1" }) + ",\n  " + JSON.stringify({ command: "create", path: "q", file_text: "2" }) + "\n]\n", files: {}, exit: 0, out: ["A p", "A q", "ok: 2 files"], after: { p: "1", q: "2" } });
add({ name: "§9 file_text must be a string", stdin: js({ command: "create", path: "x", file_text: 5 }), files: {}, exit: 2, out: ["error: parse 1"] });
add({ name: "§9 str_replace whole-file replace keeps CRLF rule", stdin: js({ command: "str_replace", path: "a.txt", old_str: "a\nb\n", new_str: "" }), files: { "a.txt": "a\r\nb\r\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "" } });
add({ name: "§2 --check with a parse error still exits 2", args: ["--check"], stdin: L("a.txt", "<<<<<<< SEARCH", "a"), files: { "a.txt": "a\n" }, exit: 2, out: ["error: parse 2"] });
add({ name: "§1 --strict and --check together", args: ["--strict", "--check"], stdin: sr("a.txt", ["a"], ["A"]), files: { "a.txt": "a\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"] });
add({ name: "§1 --format=search-replace forced", args: ["--format=search-replace"], stdin: P1, files: { "a.txt": "one\n" }, exit: 0, out: ["M a.txt", "ok: 1 file"], after: { "a.txt": "ONE\n" } });

// ---- main ----
if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const filter = process.argv[2] ?? "";
  let pass = 0, fail = 0;
  for (const c of cases) {
    if (filter && !c.name.includes(filter)) continue;
    const err = runCase(c);
    if (err) { fail++; console.log(`FAIL ${c.name}\n     ${err}`); } else pass++;
  }
  console.log(`spec matrix: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exitCode = fail ? 1 : 0;
}
