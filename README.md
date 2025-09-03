# @isopodlabs/make
[![npm version](https://img.shields.io/npm/v/@isopodlabs/make.svg)](https://www.npmjs.com/package/@isopodlabs/make)
[![GitHub stars](https://img.shields.io/github/stars/adrianstephens/ts-make.svg?style=social)](https://github.com/adrianstephens/ts-make)
[![License](https://img.shields.io/npm/l/@isopodlabs/make.svg)](LICENSE)

> A robust TypeScript parser and executor for GNU Makefiles.  
> [View on npm](https://www.npmjs.com/package/@isopodlabs/make) • [View on GitHub](https://github.com/adrianstephens/ts-make)

@isopodlabs/make is a small TypeScript-native library for parsing and executing Makefiles programmatically in Node.js.  

- Parses GNU Make–style syntax.
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
import { Makefile } from '@isopodlabs/make';
import { readFile } from 'fs/promises';

async function main() {
  // Load and parse a Makefile
  const mf = await Makefile.parse(await readFile('Makefile', 'utf8'));

  // Run default goal or provide explicit goals
  const changed = await mf.run(['all'], {
    jobs: 4,                                  // run up to 4 jobs in parallel
    mode: 'normal',                           // 'normal' | 'dry-run' | 'question' | 'touch'
    output: s => process.stdout.write(s),     // capture stdout/stderr from recipes
  });

  console.log('did work:', changed);
}

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
  - Makefile parsing and execution.
- Directives:
  - Conditionals: `ifeq`, `ifneq`, `ifdef`, `ifndef`, with `else`/`endif`.
  - `include`, `-include`, and `sinclude` with search over include dirs.
  - `export`/`unexport` and `.EXPORT_ALL_VARIABLES`.
  - `undefine`
  - `vpath`
- Targets and rules:
  - Static, pattern, and double-colon rules; grouped targets; order-only prerequisites.
  - Legacy suffix rules are recognized and converted.
- Variables:
  - Recursive (=), simple (:=), conditional (?=), append (+=), shell assignment (!=).
  - Target- and pattern-specific variables.
  - Automatic variables: `$@`, `$<`, `$^` (deduped), `$+` (with duplicates), `$|`, `$?`, `$*`.
  - `.EXTRA_PREREQS` supported (added prerequisites not reflected in automatic vars).
- Functions:
  - String and list: `subst`, `patsubst`, `strip`, `findstring`, `filter`, `filter-out`, `sort`,
    `word`, `words`, `wordlist`, `firstword`, `lastword`, [`join`][join].
  - Filename: `dir`, `notdir`, `suffix`, [`basename`][basename], `addsuffix`, `addprefix`, `wildcard`,
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
  - `normal`, `dry-`[`run`][run] (print commands), `question` (returns true if any rebuild is needed), `touch` (create missing files and update timestamps).
- Parallelism:
  - `jobs` option to control concurrency.
  - `.NOTPARALLEL` serializes prerequisites for affected targets.
  - `.WAIT` is a pseudo-prerequisite that splits a prerequisite list into serial segments:
    - `A: p1 p2 .WAIT p3 p4` runs p1/p2 (in parallel), then p3/p4 (in parallel).

## API

- Classes and types:
  - [`Makefile`][Makefile]
  - [`CreateOptions`][CreateOptions]
  - [`RunOptions`][RunOptions]
  - [`RunOptionsDirect`][RunOptionsDirect]
  - [`RuleEntry`][RuleEntry]


### Makefile

This class encapsulates a makefile. It provides direct access to these builtin variables:
- `CURDIR`
- `RECIPEPREFIX`
- `VARIABLES`
- `FEATURES`
- `INCLUDE_DIRS`
- `VPATH`
- `SUFFIXES`
- `DEFAULT_GOAL`

#### Construction
 - `new `[`Makefile`][Makefile]`(options?:`[`CreateOptions`][CreateOptions]`)` 

 	Creates an empty makefile with *only* the provided variables (plus `SHELL`, `MAKESHELL`, `MAKE_VERSION`, `MAKE_HOST`) and rules.

 - [`Makefile`][Makefile]`.`[`parse`][parse]`(text: string, options?:`[`CreateOptions`][CreateOptions]`)`

 	As above, but also parses the text into the makefile.

 - [`Makefile`][Makefile]`.load(filePath: string, options?:`[`CreateOptions`][CreateOptions]`)`

 	Creates a makefile from a file. If options.variables is undefined, the environment variables will be used. Also sets `CURDIR` and `MAKEFILE_LIST`.

#### Methods
 - `get(name: string)`

    Lookup a variable.
 
 - `setVariable(name: string, op: string, value: string, origin: VariableOrigin)`

    Set a variable.

 - `setFunction(name: string, fn: `[`Function`][Function]`)`

    Override (or add) a function.

 - `addRule(rule: `[`RuleEntry`][RuleEntry]`)`

    Add a rule.

 - [`parse`][parse]`(text: string, file?: string)`

    Parse additional text into the makefile (`file` is used to improve error messages).

 - [`run`][run]`(goals?: string[], options?: `[`RunOptions`][RunOptions]`)`
 
    Make goals using provided options.

  - `runDirect(goals: string[] = [], options: `[`RunOptionsDirect`][RunOptionsDirect]`)`
  
    Make goals using low-level options.

### Create options

See [`CreateOptions`][CreateOptions]
- `variables`: `Record<string, `[`VariableValue`][VariableValue]`>` initial variables.
- `functions`: `Record<string, `[`Function`][Function]`>` functions to override or augment the standard make functions
- `rules`: [`RuleEntry`][RuleEntry]`[]` initial ruleset; also used to generate `.SUFFIXES`.
- `includeDirs`: `string[]` search paths for include.
- `envOverrides`	whether environment variables take precedence.
- `warnUndef` 	warn when an undefined variable is accessed.


```ts
import { Makefile, environmentVariables } from '@isopodlabs/make';

// Parse from text
const mf = await Makefile.parse(text, {
  variables: environmentVariables(),
  includeDirs: ['.vscode', 'config/includes'],   // search paths for include
});

// Or load directly from a path (sets CURDIR/MAKEFILE_LIST appropriately)
const mf2 = await Makefile.load('path/to/Makefile');
```

### Run options

See [`RunOptions`][RunOptions]:

- `mode` one of `normal`, `dry-`[`run`][run], `question`, `touch`
- `jobs` number of simultaneous jobs (default 1)
- `output` to capture stdout/stderr
- `ignoreErrors`, `silent`, `noSilent`, `oneshell`
- `keepGoing`, `checkSymlink`, `printDirectory`:
- `always`, `assumeOld`, `assumeNew`: override timestamp checks
- Special targets like `.SILENT`, `.ONESHELL`, `.IGNORE`, `.NOTPARALLEL` influence behavior per target (and globally if declared with no prerequisites).

```ts
const changed = await mf.run(['target'], {
  jobs: 2,
  mode: 'question', // returns true if any rebuild would occur
  output: s => process.stdout.write(s),
});
```

See [`RunOptionsDirect`][RunOptionsDirect] for lower-level control over execution.

### Rules
See [`RuleEntry`][RuleEntry]:
- `targets`		    whitespace-separated list of targets
- `prerequisites` whitespace-separated list of prerequisites
- `recipe` optional array of strings containing the recipe
- `doubleColon`	true if it's a doubleColon rule
- `grouped` true if the rule is a grouped rule
- `builtin` true if the rule is a builtin rule
- `file`, `lineNo` location of definition

## CLI
This is an optional sub-module, which:
- Provides a gnumake-compatible command line interface.
- Is automatically invoked if run directly from command line.
- Optionally supplies builtin rules and variables.
- Can be run programmatically, but note that the first two arguments should be the node executable and the path to the make/cli module.

```ts
import { cli } from '@isopodlabs/make/cli';

await cli(process.argv);
```

Using the [`cli`][cli] module's [`builtinRules`][builtinRules] and [`builtinVariables`][builtinVariables]:

```ts
import { Makefile, environmentVariables } from '@isopodlabs/make';
import { builtinRules, builtinVariables } from '@isopodlabs/make/cli';

const mf = await Makefile.load('path/to/Makefile', {
	variables: {...builtinVariables(), ...environmentVariables()},
	rules: builtinRules(),
});
mf.run(['all'], {jobs: 6})
```

## Limitations

- No archive member support (`lib.a(member.o)`, `$%`), and no jobserver.
- All rules and variables must be passed to the Makefile constructor (or via Makefile.parse or Makefile.load). The typical rules and variables can be obtained from the CLI component. In particular, variables such as MAKE and MAKEFLAGS are only available if manually provided or when run from the CLI.
- Special targets with lifecycle semantics are recognized but not fully implemented: `.PRECIOUS`, `.INTERMEDIATE`, `.NOTINTERMEDIATE`, `.SECONDARY`, `.LOW_RESOLUTION_TIME`.
- Requires Node.js, *however* only index.ts (and the optional cli) rely on any external modules (specifically, path, fs, os, and child_process), so parsing and running makefiles is possible without Node.js.

## Contributing

Contributions, bug reports, and feature requests are welcome!  
Open an issue or pull request on [GitHub](https://github.com/adrianstephens/ts-make).

## License

MIT © Adrian Stephens

<!-- Type References -->
[join]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/miniPath.ts#L49
[basename]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/miniPath.ts#L91
[run]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/run.ts#L102
[Makefile]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/index.ts#L423
[CreateOptions]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/index.ts#L402
[RunOptions]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/index.ts#L413
[RunOptionsDirect]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/run.ts#L32
[RuleEntry]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/core.ts#L369
[parse]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/parse.ts#L80
[Function]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/core.ts#L22
[VariableValue]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/core.ts#L3
[cli]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/cli.ts#L246
[builtinRules]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/cli.ts#L216
[builtinVariables]: https://github.com/adrianstephens/ts-make/blob/HEAD/src/cli.ts#L85
