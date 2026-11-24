# mend-hsc01-r1

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
