#!/usr/bin/env node

import { Makefile, RunOptions, VariableValue, RuleEntry, getEnvironmentVariables } from './index';
import * as fs from 'fs';
import * as path from 'path';

import { defaultFunctions } from './core';
import { RunDebug } from './run';

const builtinVars: Record<string, string> = {
	'.LIBPATTERNS':		'lib%.so lib%.a',
	'AR':				'ar',
	'ARFLAGS':			'rv',
	'AS':				'as',
	'CC':				'cc',
	'CHECKOUT,v':		'+$(if $(wildcard $@),,$(CO) $(COFLAGS) $< $@)',
	'CO':				'co',
	'COFLAGS':			'',
	'COMPILE.c':		'$(CC) $(CFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -c',
	'COMPILE.C':		'$(COMPILE.cc)',
	'COMPILE.cc':		'$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -c',
	'COMPILE.cpp':		'$(COMPILE.cc)',
	'COMPILE.def':		'$(M2C) $(M2FLAGS) $(DEFFLAGS) $(TARGET_ARCH)',
	'COMPILE.F':		'$(FC) $(FFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -c',
	'COMPILE.f':		'$(FC) $(FFLAGS) $(TARGET_ARCH) -c',
	'COMPILE.m':		'$(OBJC) $(OBJCFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -c',
	'COMPILE.mod':		'$(M2C) $(M2FLAGS) $(MODFLAGS) $(TARGET_ARCH)',
	'COMPILE.p':		'$(PC) $(PFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -c',
	'COMPILE.r':		'$(FC) $(FFLAGS) $(RFLAGS) $(TARGET_ARCH) -c',
	'COMPILE.s':		'$(AS) $(ASFLAGS) $(TARGET_MACH)',
	'COMPILE.S':		'$(CC) $(ASFLAGS) $(CPPFLAGS) $(TARGET_MACH) -c',
	'CPP':				'$(CC) -E',
	'CTANGLE':			'ctangle',
	'CWEAVE':			'cweave',
	'CXX':				'g++',
	'F77':				'$(FC)',
	'F77FLAGS':			'$(FFLAGS)',
	'FC':				'f77',
	'GET':				'echo no sccs get',
	'LD':				'ld',
	'LEX.l':			'$(LEX) $(LFLAGS) -t',
	'LEX.m':			'$(LEX) $(LFLAGS) -t',
	'LEX':				'lex',
	'LINK.c':			'$(CC) $(CFLAGS) $(CPPFLAGS) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.C':			'$(LINK.cc)',
	'LINK.cc':			'$(CXX) $(CXXFLAGS) $(CPPFLAGS) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.cpp':			'$(LINK.cc)',
	'LINK.F':			'$(FC) $(FFLAGS) $(CPPFLAGS) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.f':			'$(FC) $(FFLAGS) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.m':			'$(OBJC) $(OBJCFLAGS) $(CPPFLAGS) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.o':			'$(CC) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.p':			'$(PC) $(PFLAGS) $(CPPFLAGS) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.r':			'$(FC) $(FFLAGS) $(RFLAGS) $(LDFLAGS) $(TARGET_ARCH)',
	'LINK.S':			'$(CC) $(ASFLAGS) $(CPPFLAGS) $(LDFLAGS) $(TARGET_MACH)',
	'LINK.s':			'$(CC) $(ASFLAGS) $(LDFLAGS) $(TARGET_MACH)',
	'LINT.c':			'$(LINT) $(LINTFLAGS) $(CPPFLAGS) $(TARGET_ARCH)',
	'LINT':				'lint',
	'M2C':				'm2c',
	'MAKE':				'$(MAKE_COMMAND)',
	'MAKEINFO':			'makeinfo',
	'OBJC':				'cc',
	'OUTPUT_OPTION':	'-o $@',
	'PC':				'pc',
	'PREPROCESS.F':		'$(FC) $(FFLAGS) $(CPPFLAGS) $(TARGET_ARCH) -F',
	'PREPROCESS.r':		'$(FC) $(FFLAGS) $(RFLAGS) $(TARGET_ARCH) -F',
	'PREPROCESS.S':		'$(CC) -E $(CPPFLAGS)',
	'RM':				'rm -f',
	'TANGLE':			'tangle',
	'TEX':				'tex',
	'TEXI2DVI':			'texi2dvi',
	'WEAVE':			'weave',
	'YACC.m':			'$(YACC) $(YFLAGS)',
	'YACC.y':			'$(YACC) $(YFLAGS)',
	'YACC':				'yacc',

	//mac
//GET = get
//CXX = c++
};

function fixBuiltinVars(v: Record<string, string>) {
	return Object.fromEntries(Object.entries(v).map(([key, val]) => [key, {value: val, origin: 'default'} as VariableValue] ));
}

export function builtinVariables() { return fixBuiltinVars(builtinVars); }

const builtinRuletable: [string, string?, string?][] = [
	//implicit rules
	["%.o",				"%.c",			"$(CC) $(CFLAGS) -c $< -o $@"],
	["%.out"],
	["%.a"],
	["%.ln"],
	["%.o"],
	["%",				"%.o",			"$(LINK.o) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.c"],
	["%",				"%.c",			"$(LINK.c) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.ln",			"%.c",			"$(LINT.c) -C$* $<"],
	["%.o",				"%.c",			"$(COMPILE.c) $(OUTPUT_OPTION) $<"],
	["%.cc"],
	["%",				"%.cc",			"$(LINK.cc) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.cc",			"$(COMPILE.cc) $(OUTPUT_OPTION) $<"],
	["%.C"],
	["%",				"%.C",			"$(LINK.C) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.C",			"$(COMPILE.C) $(OUTPUT_OPTION) $<"],
	["%.cpp"],
	["%",				"%.cpp",		"$(LINK.cpp) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.cpp",		"$(COMPILE.cpp) $(OUTPUT_OPTION) $<"],
	["%.p"],
	["%",				"%.p",			"$(LINK.p) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.p",			"$(COMPILE.p) $(OUTPUT_OPTION) $<"],
	["%.f"],
	["%",				"%.f",			"$(LINK.f) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.f",			"$(COMPILE.f) $(OUTPUT_OPTION) $<"],
	["%.F"],
	["%",				"%.F",			"$(LINK.F) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.F",			"$(COMPILE.F) $(OUTPUT_OPTION) $<"],
	["%.f",				"%.F",			"$(PREPROCESS.F) $(OUTPUT_OPTION) $<"],
	["%.m"],
	["%",				"%.m",			"$(LINK.m) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.m",			"$(COMPILE.m) $(OUTPUT_OPTION) $<"],
	["%.r"],
	["%",				"%.r",			"$(LINK.r) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.r",			"$(COMPILE.r) $(OUTPUT_OPTION) $<"],
	["%.f",				"%.r",			"$(PREPROCESS.r) $(OUTPUT_OPTION) $<"],
	["%.y"],
	["%.ln",			"%.y",			"$(YACC.y) $<\n$(LINT.c) -C$* y.tab.c\n$(RM) y.tab.c"],
	["%.c",				"%.y",			"$(YACC.y) $<\nmv -f y.tab.c $@"],
	["%.l"],
	["%.ln",			"%.l",			"@$(RM) $*.c\n$(LEX.l) $< > $*.c\n$(LINT.c) -i $*.c -o $@\n$(RM) $*.c"],
	["%.c",				"%.l",			"@$(RM) $@\n$(LEX.l) $< > $@"],
	["%.r",				"%.l",			"$(LEX.l) $< > $@\nmv -f lex.yy.r $@"],
	["%.ym"],
	["%.m",				"%.ym",			"$(YACC.m) $<\nmv -f y.tab.c $@"],
	["%.yl"],
	["%.s"],
	["%",				"%.s",			"$(LINK.s) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.s",			"$(COMPILE.s) -o $@ $<"],
	["%.S"],
	["%",				"%.S",			"$(LINK.S) $^ $(LOADLIBES) $(LDLIBS) -o $@"],
	["%.o",				"%.S",			"$(COMPILE.S) -o $@ $<"],
	["%.s",				"%.S",			"$(PREPROCESS.S) $< > $@"],
	["%.mod"],
	["%",				"%.mod",		"$(COMPILE.mod) -o $@ -e $@ $^"],
	["%.o",				"%.mod",		"$(COMPILE.mod) -o $@ $<"],
	["%.sym"],
	["%.def"],
	["%.sym",			"%.def",		"$(COMPILE.def) -o $@ $<"],
	["%.h"],
	["%.info"],
	["%.dvi"],
	["%.tex"],
	["%.dvi",			"%.tex",		"$(TEX) $<"],
	["%.texinfo"],
	["%.info",			"%.texinfo",	"$(MAKEINFO) $(MAKEINFO_FLAGS) $< -o $@"],
	["%.dvi",			"%.texinfo",	"$(TEXI2DVI) $(TEXI2DVI_FLAGS) $<"],
	["%.texi"],
	["%.info",			"%.texi",		"$(MAKEINFO) $(MAKEINFO_FLAGS) $< -o $@"],
	["%.dvi",			"%.texi",		"$(TEXI2DVI) $(TEXI2DVI_FLAGS) $<"],
	["%.txinfo"],
	["%.info",			"%.txinfo",		"$(MAKEINFO) $(MAKEINFO_FLAGS) $< -o $@"],
	["%.dvi",			"%.txinfo",		"$(TEXI2DVI) $(TEXI2DVI_FLAGS) $<"],
	["%.w"],
	["%.c",				"%.w",			"$(CTANGLE) $< - $@"],
	["%.tex",			"%.w",			"$(CWEAVE) $< - $@"],
	["%.ch"],
	["%.web"],
	["%.p",				"%.web",		"$(TANGLE) $<"],
	["%.tex",			"%.web",		"$(WEAVE) $<"],
	["%.sh"],
	["%",				"%.sh",			"cat $< >$@\nchmod a+x $@"],
	["%.elc"],
	["%.el"],
	["%.out",			"%",			"@rm -f $@\ncp $< $@"],
	["%.c",				"%.w %.ch",		"$(CTANGLE) $^ $@"],
	["%.tex",			"%.w %.ch",		"$(CWEAVE) $^ $@"],

	["<terminal>",		"%,v",			"$(CHECKOUT,v)"],//terminal
	["<terminal>",		"RCS/%,v",		"$(CHECKOUT,v)"],//terminal
	["<terminal>",		"RCS/%",		"$(CHECKOUT,v)"],//terminal
	["<terminal>",		"s.%",			"$(GET) $(GFLAGS) $(SCCS_OUTPUT_OPTION) $<"],//terminal
	["<terminal>",		"SCCS/s.%",		"$(GET) $(GFLAGS) $(SCCS_OUTPUT_OPTION) $<"],//terminal

	["%.m",				"%.lm",			"@$(RM) $@\n$(LEX.m) $< > $@"],

	//suffix rules
	//provided solely to recognize certain file names so that non-terminal match-anything rules will not be considered
	["%",				"%.dvi"],
	["%",				"%.ym"],
	["%",				"%.l"],
	["%",				"%.ln"],
	["%",				"%.y"],
	["%",				"%.a"],
	["%",				"%.yl"],
	["%",				"%.ch"],
	["%",				"%.def"],
	["%",				"%.elc"],
	["%",				"%.out"],
	["%",				"%.el"],
	["%",				"%.texinfo"],
	["%",				"%.DEFAULT"],
	["%",				"%.h"],
	["%",				"%.texi"],
	["%",				"%.txinfo"],
	["%",				"%.tex"],
	["%",				"%.w"],
	["%",				"%.web"],
	["%",				"%.sym"],
	["%",				"%.info"],

	["(%)",				"%",			"$(AR) $(ARFLAGS) $@ $<"],
	["makefile"],
	["Makefile"],
	["GNUmakefile"],
];

export function builtinRules() {
	return builtinRuletable.map((args: [string, string?, string?]): RuleEntry => {
		const doubleColon = args[0] === '<terminal>';
		return { targets: doubleColon ? '%' : args[0], prerequisites: args[1] ?? '', recipe: args[2]?.split('\n'), doubleColon, builtin: true };
	});
}

//-----------------------------------------------------------------------------
// cli
//-----------------------------------------------------------------------------

interface Option {
	names:			string[];
	description:	string;
	process:		((arg: string) => void) | (() => void);
	passdown?:		boolean;
}

const MakeRunDebug: Record<string, Partial<RunDebug>> = {
	a: {level: 2, implicit: true, jobs: true, makefile: true, recipe: true, why: true},
	b: {level: 1},
	v: {level: 2},
	i: {implicit: true},
	j: {jobs: true},
	m: {makefile: true},
	p: {recipe: true},
	w: {why: true},
	n: {level: 0, implicit: false, jobs: false, makefile: false, recipe: false, why: false},
} as const;

export async function cli(args: string[], output: (s: string)=>void = s => process.stdout.write(s)): Promise<number> {
	const	variables		= getEnvironmentVariables();
	const	run:			RunOptions 		= {output};
    const	goals:			string[]		= [];
	const	filenames:		string[]		= [];
	const	includeDirs:	string[]		= ['.'];
    let		evals			= '';
	let		directory		= process.cwd();
	let		noBuiltinRules	= false;
	let		noBuiltinVars	= false;
	let		envOverrides	= false;
	let		warnUndef		= false;
	let		printDirectory: boolean|undefined;

	const options: Option[] = [
		{
			names: ['b', 'm'],
			description: 'Ignored for compatibility.',
			process: () => {}
		},
		{
			names: ['B', 'always-make'],
			description: 'Consider all targets out-of-date.',
			process: () => run.always = true
		},
		{
			names: ['C', 'directory'],
			description: 'Change to directory dir before reading the makefiles.',
			process: arg => { directory = path.resolve(directory, arg); printDirectory ??= true; },
			passdown: false
		},
		{
			names: ['d'],
			description: 'Print debugging information in addition to normal processing.',
			process: () => run.debug = MakeRunDebug.a
		},
		{
			names: ['debug'],
			description: 'Print debugging information in addition to normal processing.',
			process: arg => run.debug = arg.split(',').map(i => i[0]).reduce((acc, curr) => ({...acc, ...MakeRunDebug[curr]}), run.debug ?? MakeRunDebug.n)
		},
		{
			names: ['e', 'environment-overrides'],
			description: 'Give variables taken from the environment precedence over variables from makefiles.',
			process: () => envOverrides = true
		},
		{
			names: ['E', 'eval'],
			description: 'Evaluate string as makefile syntax.',
			process: arg => evals += arg + '\n'
		},
		{
			names: ['f', 'file', 'makefile=file'],
			description: 'Read the file named file as a makefile.',
			process: arg => filenames.push(arg),
			passdown: false
		},
		{
			names: ['h', 'help'],
			description: 'Print a summary of the command-line options.',
			process: () => options.forEach(opt => output(`${opt.names.map(i => (i.length === 1 ? '-' : '--') + i).join(', ')}\n\t${opt.description}\n`))
		},
		{
			names: ['i', 'ignore-errors'],
			description: 'Ignore all errors in recipes executed to remake files.',
			process: () => run.ignoreErrors = true
		},
		{
			names: ['I', 'include-dir'],
			description: 'Specifies a directory dir to search for included makefiles.',
			process: arg => includeDirs.push(arg)
		},
		{
			names: ['j', 'jobs'],
			description: 'Specifies the number of recipes (jobs) to run simultaneously. With no argument, make runs as many recipes simultaneously as possible.',
			process: arg => run.jobs = arg ? parseInt(arg, 10) : Infinity
		},
		{
			names: ['jobserver-style'],
			description: 'Chooses the style of jobserver to use.',
			process: _arg => {}
		},
		{
			names: ['k', 'keep-going'],
			description: 'Continue as much as possible after an error.',
			process: () => run.keepGoing = true
		},
		{
			names: ['l', 'load-average', 'max-load'],
			description: 'Specifies that no new recipes should be started if there are other recipes running and the load average is at least load (a floating-point number). With no argument, removes a previous load limit.',
			process: arg => run.maxLoad = arg ? parseFloat(arg) : undefined
		},
		{
			names: ['L', 'check-symlink-times'],
			description: 'On systems that support symbolic links, this option causes make to consider the timestamps on any symbolic links in addition to the timestamp on the file referenced by those links.',
			process: () => run.checkSymlink = true
		},
		{
			names: ['n', 'just-print', 'dry-run', 'recon'],
			description: 'Print the recipe that would be executed, but do not execute it (except in certain circumstances).',
			process: () => run.mode = 'dry-run'
		},
		{
			names: ['o', 'old-file', 'assume-old'],
			description: 'Do not remake the file file even if it is older than its prerequisites, and do not remake anything on account of changes in file.',
			process: arg => (run.assumeOld ??= []).push(arg),
			passdown: false
		},
		{
			names: ['O', 'output-sync[=type]'],
			description: 'Ensure that the complete output from each recipe is printed in one uninterrupted sequence.',
			process: arg => run.outputSync
				= !arg ? 'target'
				: arg === 'target' || arg === 'line' || arg === 'recurse' ? arg
				: arg === 'none' ? undefined : undefined
		},
		{
			names: ['p', 'print-data-base'],
			description: 'Print the data base (rules and variable values) that results from reading the makefiles; then execute as usual or as otherwise specified.',
			process: () => {}
		},
		{
			names: ['q', 'question'],
			description: 'Question mode. Do not run any recipes, or print anything; just return an exit status that is zero if the specified targets are already up to date, one if any remaking is required, or two if an error is encountered.',
			process: () => run.mode = 'question'
		},
		{
			names: ['r', 'no-builtin-rules'],
			description: 'Eliminate use of the built-in implicit rules.',
			process: () => noBuiltinRules = true
		},
		{
			names: ['R', 'no-builtin-variables'],
			description: 'Eliminate use of the built-in rule-specific variables.',
			process: () => noBuiltinVars = true
		},
		{
			names: ['s', 'silent', 'quiet'],
			description: 'Silent operation; do not print the recipes as they are executed.',
			process: () => run.silent = true
		},
		{
			names: ['S', 'no-keep-going', 'stop'],
			description: 'Cancel the effect of the -k option.',
			process: () => run.keepGoing = false
		},
		{
			names: ['shuffle'],
			description: 'This option enables a form of fuzz-testing of prerequisite relationships.',
			process: arg => run.shuffle
				= arg === 'reverse' ? arg
				: arg === 'random'	? 42 
				: arg === 'none'	? undefined
				: parseInt(arg, 10)
		},
		{
			names: ['trace'],
			description: 'Show tracing information for make execution. (shorthand for --debug=print,why)',
			process: () => run.debug = {...(run.debug ?? MakeRunDebug.n), recipe: true, why: true, level: 2}
		},
		{
			names: ['t', 'touch'],
			description: 'Touch files (mark them up to date without really changing them) instead of running their recipes.',
			process: () => run.mode = 'touch'
		},
		{
			names: ['v', 'version'],
			description: 'Print the version of the make program plus a copyright, a list of authors, and a notice that there is no warranty; then exit.',
			process: () => output("version 1.0.0\n")
		},
		{
			names: ['w', 'print-directory'],
			description: 'Print a message containing the working directory both before and after executing the makefile.',
			process: () => printDirectory = true
		},
		{
			names: ['no-print-directory'],
			description: 'Disable printing of the working directory under -w.',
			process: () => printDirectory = false
		},
		{
			names: ['W', 'what-if', 'new-file', 'assume-new'],
			description: 'Pretend that the target file has just been modified.',
			process: arg => (run.assumeNew ??= []).push(arg),
			passdown: false
		},
		{
			names: ['warn-undefined-variables'],
			description: 'Issue a warning message whenever make sees a reference to an undefined variable.',
			process: () => warnUndef = true
		}
	];

	let flags = '';
	const longFlags: string[] = [];

	if (variables.MAKEFLAGS) {
		const makeflags = ('-' + variables.MAKEFLAGS.value).split(' ');
		args = makeflags.concat(args);
	}

	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		const eq = arg.indexOf('=');

		if (arg[0] === '-') {
			const name = arg[1] === '-' ? (eq > 0 ? arg.slice(2, eq) : arg.slice(2)) : arg[1];
			const option = options.find(opt => opt.names.includes(name));
			if (option) {
				const long = option.names[0].length > 1;
				if (option.process?.length) {
					//with argument
					const value = arg[1] === '-' ? (eq > 0 ? arg.slice(eq + 1) : '') : arg.length > 2 ? arg[2] : args[++i];
					option.process?.(value);
					if (option.passdown !== false)
						longFlags.push(long ? `--${option.names[0]}=${value}` : `-${option.names[0]}${value}`);

				} else if (name.length > 1) {
					//long without argument
					option.process?.('');
					if (option.passdown !== false) {
						if (long)
							longFlags.push(`--${option.names[0]}`);
						else
							flags += `-${option.names[0]}`;
					}
				} else {
					//short without argument (iterate over characters)
					for (let i = 1; i < arg.length; i++) {
						const name	= arg[i];
						const option = options.find(opt => opt.names.includes(name));
						if (!option || option.process?.length) {
							output(`Warning: ignoring invalid option: -${name}\n`);
						} else {
							option.process?.('');
							if (option.passdown !== false)
								flags += option.names[0];
						}
					}
				}
			} else {
				output(`Warning: ignoring unsupported option: ${arg}\n`);
			}

		} else if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, eq))) {
			// Variable assignment: VAR=VALUE
			const name	= arg.slice(0, eq);
			const value	= arg.slice(eq + 1);
			variables[name] = { value, origin: 'command line' };
			continue;
		} else {
	        // Otherwise, treat as a goal
	        goals.push(arg);
		}
	}

	if (!filenames.length) {
		for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
			const candidate = path.resolve(directory, name);
			if (await fs.promises.access(candidate).then(() => true).catch(() => false)) {
				filenames.push(candidate);
				break;
			}
		}
		if (!filenames.length) {
			output('make: *** No targets specified and no makefile found. Stop.');
			return 2;
		}
	} else {
		for (const i in filenames)
			filenames[i] = path.resolve(directory, filenames[i]);
	}

	variables.MAKE			= { value: args.slice(0, 2).join(' '), export: true };
	variables.MAKEOVERRIDES	= { value: Object.entries(variables).map(([k, v]) => `${k}=${v.value}`).join(' ') };
	variables.MFLAGS		= { value: ['-' + flags, ...longFlags].join(' '), export: true };
//	variables.MAKEFLAGS		= { value: [flags, ...longFlags, ...Object.entries(variables).map(([k, v]) => `${k}=${v.value}`)].join(' '), export: true };
	variables.MAKEFLAGS		= { value: [flags, ...longFlags, '${MAKEOVERRIDES}'].join(' '), export: true };
	variables.MAKECMDGOALS	= { value: goals.join(' ') };
	variables.CURDIR		= { value: directory };

	if (variables.MAKELEVEL) {
		variables.MAKELEVEL.value = String(Number(variables.MAKELEVEL.value) + 1);
	} else {
		variables.MAKELEVEL = { value: '1' };
	}

	const mf 	= new Makefile({
		variables:	noBuiltinVars ? variables : {...builtinVariables(), ...variables},
		functions:	defaultFunctions,
		rules:		noBuiltinRules ? [] : builtinRules(),
		includeDirs,
		warnUndef,
		envOverrides
	});

	mf.parse(evals, 'command line');

	try {
		const promises = filenames.map(file => fs.promises.readFile(file, 'utf8'));

		for (const i in filenames) {
			const text	= await promises[i];
			await mf.setVariable('MAKEFILE_LIST', '+', filenames[i], 'file');
			await mf.parse(text, filenames[i]);
		}

		if (printDirectory)
			output(`make: Entering directory: ${directory}\n`);

		const result	= await mf.run(goals, run);

		if (printDirectory)
			output(`make: Leaving directory: ${directory}\n`);

		return result ? 0 : 1;

	} catch (error: any) {
		output(`${error.message} in ${filenames[0]}\n`);
		if (typeof error.code === 'number')
			return error.code;
		return error.errno || 1;
	}

}

//-----------------------------------------------------------------------------
// Auto-invoke CLI if run directly as binary
//-----------------------------------------------------------------------------

if (require.main === module) {
	cli(process.argv).then(code => process.exit(code));
}