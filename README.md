# @isopodlabs/make

A small TypeScript library for parsing and executing Makefiles programmatically.

- Parses GNU Make–style syntax (variables, pattern rules, includes, special targets, etc.).
- Executes recipes cross‑platform using your system shell.
- Useful for IDE integrations, build tooling, or testing Makefiles in Node.js.

## ☕ Support My Work
If you use this package, consider [buying me a cup of tea](https://coff.ee/adrianstephens) to support future updates!

## Installation

```sh
npm install @isopodlabs/make
```

## Quick start

```ts
import { Makefile, execute } from '@isopodlabs/make';
import { readFile } from 'fs/promises';

async function main() {
  // Load and parse a Makefile
  const mf = await Makefile.parse(await readFile('Makefile', 'utf8'));

  // Run default goal or provide explicit goals
  const changed = await execute(mf, ['all'], {
    jobs: 4,                                  // run up to 4 jobs in parallel
    mode: 'normal',                           // 'normal' | 'dry-run' | 'question' | 'touch'
    output: s => process.stdout.write(s),     // capture stdout/stderr from recipes
  });

  console.log('did work:', changed);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

Minimal Makefile example:

```makefile
.PHONY: all build clean

all: build

build: src/app.c
    @echo compiling $<
    @echo output -> $@

clean:
    -@rm -f build
```

## Features

- Parser and executor:
  - Makefile parsing and execution via [`Makefile`](src/parse.ts) and [`execute`](src/run.ts).
- Directives:
  - Conditionals: `ifeq`, `ifneq`, `ifdef`, `ifndef`, with `else`/`endif`.
  - `include`, `-include`, and `sinclude` with search over include dirs.
  - `export`/`unexport` and `.EXPORT_ALL_VARIABLES`.
  - `.DEFAULT_GOAL` is honored.
- Targets and rules:
  - Static, pattern, and double-colon rules; grouped targets; order-only prerequisites.
  - Pseudo prerequisite “.WAIT” for sequencing segments of a prerequisite list.
  - Legacy suffix rules are recognized and converted; you can also add your own.
- Variables:
  - Recursive (=), simple (:=), conditional (?=), append (+=), shell assignment (!=).
  - Target- and pattern-specific variables.
  - Automatic variables: `$@`, `$<`, `$^` (deduped), `$+` (with duplicates), `$|`, `$?`, `$*`.
  - `.EXTRA_PREREQS` supported (added prerequisites not reflected in automatic vars).
- Functions:
  - String and list: `subst`, `patsubst`, `strip`, `findstring`, `filter`, `filter-out`, `sort`,
    `word`, `words`, `wordlist`, `firstword`, `lastword`, `join`.
  - Filename: `dir`, `notdir`, `suffix`, `basename`, `addsuffix`, `addprefix`, `wildcard`,
    `realpath`, `abspath`.
  - Conditionals/logic: `if`, `or`, `and`, `intcmp`.
  - Variables/meta: `value`, `origin`, `flavor`, `call`, `foreach`, `let`, `file`, `error`, `warning`, `info`.
  - Also provides `shell` and `eval`.
- Search paths:
  - `VPATH` and `vpath` pattern-based file resolution.
- Special targets (recognized at runtime):
  - `.PHONY`, `.SUFFIXES`, `.DEFAULT`, `.PRECIOUS`, `.INTERMEDIATE`, `.NOTINTERMEDIATE`,
    `.SECONDARY`, `.SECONDEXPANSION`, `.DELETE_ON_ERROR`, `.IGNORE`, `.LOW_RESOLUTION_TIME`,
    `.SILENT`, `.EXPORT_ALL_VARIABLES`, `.NOTPARALLEL`, `.ONESHELL`, `.POSIX`.
- Recipe flags:
  - `-` ignore errors, `@` silent, `+` force execution.
  - `.ONESHELL` or per-call option to run a whole recipe in a single shell.
- Execution modes:
  - `normal`, `dry-run` (print commands), `question` (returns true if any rebuild is needed), `touch` (create missing files and update timestamps).
- Parallelism:
  - `jobs` option to control concurrency.
  - `.NOTPARALLEL` serializes prerequisites for affected targets.

## API

Entry points are re-exported from [src/index.ts](src/index.ts).

- Classes and types:
  - [`Makefile`](src/parse.ts)
  - [`ParseOptions`](src/parse.ts)
  - [`Variables`](src/variables.ts)
  - [`Expander`](src/variables.ts)
  - [`Function`](src/variables.ts)
- Execution:
  - [`execute`](src/run.ts)
  - [`ExecuteOptions`](src/run.ts)

### Makefile

Create and parse:

```ts
import { Makefile } from '@isopodlabs/make';

// Parse from text
const mf = await Makefile.parse(text, {
  includeDirs: ['.vscode', 'config/includes'],   // search paths for include/sinclude
});

// Or load directly from a path (sets CURDIR/MAKEFILE_LIST appropriately)
const mf2 = await Makefile.load('path/to/Makefile');
```

Execution:

```ts
import { execute } from '@isopodlabs/make';

const changed = await execute(mf, ['target'], {
  jobs: 2,
  mode: 'question', // returns true if any rebuild would occur
  output: s => process.stdout.write(s),
});
```

Shell integration:

```ts
// Run a shell command in the Makefile’s context (captures exit code to .SHELLEXIT)
const out = await mf.shellCommand('echo hello && exit 0');
```

Custom functions:

```ts
// Add a $(myfunc ...) expansion function
mf.setFunction('myfunc', async (_exp, text: string) => text.toUpperCase());
```

Path resolution:

```ts
// Resolve a file using VPATH / vpath rules
const resolved = await mf.getPath('foo.o');
```

Suffix rules:

```ts
// Add a new suffix rule: %.o: %.c
mf.addSuffixRule('c', 'o', [
  '$(CC) $(CFLAGS) -c $< -o $@'
]);
```

### Execute options

See [`ExecuteOptions`](src/run.ts):

- `mode`: `'normal' | 'dry-run' | 'question' | 'touch'`
- `jobs`: number (default 1)
- `output`: `(chunk: string) => void` to capture stdout/stderr
- `ignoreErrors`, `silent`, `noSilent`, `oneshell`
- Special targets like `.SILENT`, `.ONESHELL`, `.IGNORE`, `.NOTPARALLEL` influence behavior per target (and globally if declared with no prerequisites).

## Behavior notes

- Grouped targets: a single recipe can build multiple outputs. They share timestamps and are scheduled as a unit.
- Order-only prerequisites after a pipe `|` do not trigger rebuilds when they change.
- `.WAIT` splits a prerequisite list into serial segments:
  - `A: p1 p2 .WAIT p3 p4` runs p1/p2 (in parallel), then p3/p4 (in parallel).
- `.ONESHELL` runs all recipe lines for a rule in a single shell; otherwise, each line runs in its own shell.
- `.SECONDEXPANSION`: prerequisite lists are expanded twice; the second pass runs with `$@` and `$*` set.
- Environment export: `export`, `unexport`, and `.EXPORT_ALL_VARIABLES` control which variables are passed to each recipe’s environment.

## Limitations

- No archive member support (`lib.a(member.o)`, `$%`), and no jobserver.
- No built-in implicit rule database (only what you define, plus suffix rule helpers).
- Special targets with lifecycle semantics are recognized but not fully implemented: `.PRECIOUS`, `.INTERMEDIATE`, `.NOTINTERMEDIATE`, `.SECONDARY`, `.LOW_RESOLUTION_TIME`.
- CLI flags/MAKEFLAGS are not parsed; pass options via `ExecuteOptions`.
- `.RECIPEPREFIX` is not supported (recipes must start with TAB or four spaces).
