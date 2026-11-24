# mend-hsc01-r1

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/romafitos/mend-hsc01-r1/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/romafitos/mend-hsc01-r1/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` takes an edit written by an AI model and applies it to a directory of text files — every file changes, or none
does. It reads the four shapes models actually produce:

- **unified diffs**, including ones with stale `@@` line numbers, prose around them and code fences;
- **SEARCH/REPLACE blocks** (aider style);
- **V4A patches** (`*** Begin Patch` … `*** End Patch`);
- **JSON text-editor tool calls** (`create`, `str_replace`, `insert`), as an array or JSON Lines.

`SPEC.md` is the full contract; `main.ts` implements it with Node 22 and nothing outside its standard library.

## Usage

    node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]

With no PATCH (or `-`) the patch comes from stdin. `--check` is a dry run with identical output, `--strict` turns off
whitespace-tolerant matching.

Each edit is located at the first tier that finds it: the exact lines, then the lines compared without trailing spaces
and tabs, then without leading and trailing spaces and tabs (re-indenting the new lines to the file's indentation).
A unified hunk picks the match nearest its `@@` line number, a V4A chunk the first one after its cursor, and a
SEARCH/REPLACE block or JSON `str_replace` that matches twice is refused as ambiguous. Every failed edit is named on
stdout with its reason, and then nothing on disk changes.

## Run it

```sh
# apply a patch from a file, or pipe one in on stdin
node main.ts fix.patch
cat fix.patch | node main.ts --check

# the practice checks shipped with the kit
node check.ts practice.json
```

`tests/spec_matrix.ts` holds extra cases written against individual sentences of `SPEC.md`:
`node tests/spec_matrix.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qeky27wz&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
