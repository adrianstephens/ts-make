import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { VariablesClass, VariableValue, Variables, Expander, Function, fromWords, toWords, anchored, escapeRe, scanBalanced, defaultFunctions, unescape } from './variables';
import { execute, ExecuteOptions } from './run';

//Automatic variables
//--------------------------
//$@				x		The file name of the target.
//$%				x		The target member name, when the target is an archive member.
//$<				x		The name of the first prerequisite.
//$?				x		The names of all the prerequisites that are newer than the target, with spaces between them. For prerequisites which are archive members, only the named member is used
//$^,$+				x		The names of all the prerequisites, with spaces between them. For prerequisites which are archive members, only the named member is used
//$*				x		The stem with which an implicit rule matches
//$(.D),$(.F)		x		The directory part and the file-within-directory part of $..

// Built-in Vars
//--------------------------
//MAKEFILES					Makefiles to be read on every invocation of make.
//VPATH				x		Directory search path for files not found in the current directory.
//SHELL				x		The name of the system default command interpreter, usually /bin/sh. You can set SHELL in the makefile to change the shell used to run recipes. 
//MAKESHELL			x		On MS-DOS only, the name of the command interpreter that is to be used by make. This value takes precedence over the value of SHELL. 
//MAKE						The name with which make was invoked. Using this variable in recipes has special meaning. 
//MAKE_VERSION				The built-in variable ‘MAKE_VERSION’ expands to the version number of the GNU make program.
//MAKE_HOST					The built-in variable ‘MAKE_HOST’ expands to a string representing the host that GNU make was built to run on.
//MAKELEVEL					The number of levels of recursion (sub-makes).
//MAKEFLAGS					The flags given to make. You can set this in the environment or a makefile to set flags.
//GNUMAKEFLAGS				Other flags parsed by make. You can set this in the environment or a makefile to set make command-line flags. GNU make never sets this variable itself. This variable is only needed if you’d like to set GNU make-specific flags in a POSIX-compliant makefile. This variable will be seen by GNU make and ignored by other make implementations. It’s not needed if you only use GNU make; just use MAKEFLAGS directly. 
//MAKECMDGOALS				The targets given to make on the command line. Setting this variable has no effect on the operation of make.
//CURDIR			x		Set to the absolute pathname of the current working directory (after all -C options are processed, if any). Setting this variable has no effect on the operation of make.
//SUFFIXES			x		The default list of suffixes before make reads any makefiles.
//.LIBPATTERNS				Defines the naming of the libraries make searches for, and their order.

//Other Special Variables
//--------------------------
//MAKEFILE_LIST		x		Contains the name of each makefile that is parsed by make, in the order in which it was parsed
//.DEFAULT_GOAL				Sets the default goal to be used if no targets were specified on the command line
//MAKE_RESTARTS				This variable is set only if this instance of make has restarted (see How Makefiles Are Remade): it will contain the number of times this instance has restarted
//MAKE_TERMOUT	
//MAKE_TERMERR				When make starts it will check whether stdout and stderr will show their output on a terminal. If so, it will set MAKE_TERMOUT and MAKE_TERMERR, respectively, to the name of the terminal device (or true if this cannot be determined
//.RECIPEPREFIX				The first character of the value of this variable is used as the character make assumes is introducing a recipe line
//.VARIABLES		x		Expands to a list of the names of all global variables defined so far
//.FEATURES			x		Expands to a list of special features supported by this version of make
//.INCLUDE_DIRS		x		Expands to a list of directories that make searches for included makefiles
//.EXTRA_PREREQS	x		Each word in this variable is a new prerequisite which is added to targets for which it is set. These prerequisites do not appear in any of the automatic variables, allowing prerequisites to be defined which do not impact the recipe

//Features	
//--------------------------
//archives					Supports ar (archive) files using special file name syntax
//check-symlink				Supports the -L (--check-symlink-times) flag
//else-if			x		Supports 'else if' non-nested conditionals
//extra-prereqs		x		Supports the .EXTRA_PREREQS special target
//grouped-target	x		Supports grouped target syntax for explicit rules
//guile						Has GNU Guile available as an embedded extension language
//jobserver					Supports “job server” enhanced parallel builds
//jobserver-fifo			Supports “job server” enhanced parallel builds using named pipes
//load						Supports dynamically loadable objects for creating custom extensions
//notintermediate			Supports the .NOTINTERMEDIATE special target
//oneshell			x		Supports the .ONESHELL special target
//order-only		x		Supports order-only prerequisites
//output-sync				Supports the --output-sync command line option
//second-expansion	x		Supports secondary expansion of prerequisite lists
//shell-export		x		Supports exporting make variables to shell functions
//shortest-stem		x		Uses the “shortest stem” method of choosing which pattern, of multiple applicable options, will be used
//target-specific	x		Supports target-specific and pattern-specific variable assignments
//undefine			x		Supports the undefine directive

export interface SuffixRule {
	from:	string;
	to?:	string;
	recipe:	string[];
}

export interface ParseOptions {
	variables?:		Record<string, VariableValue>;
	functions?:		Record<string, Function>;
	includeDirs?:	string[];
	suffixRules?:	SuffixRule[];
	nmake?:			boolean;
}

export interface RuleEntry {
	targets:		string;//[];
	prerequisites:	string;//[];
//	orderOnly:		string[];
	recipe:			string[];
	file?:			string;
	lineNo?:		number;		// line of the rule header (1-based)
	doubleColon?:	boolean;	// true if the rule is a double-colon rule
	grouped?:		boolean;	// true if the rule is a grouped rule
}

export interface DeferredInclude {
	file:			string;
	lineNo:			number;
	noError:		boolean;
}

//-----------------------------------------------------------------------------
// search
//-----------------------------------------------------------------------------

async function searchPath(target: string, paths: string[]): Promise<string|undefined> {
	if (path.isAbsolute(target))
		return fs.promises.access(target).then(() => target).catch(() => undefined);

	const promises = paths.map(i => {
		const fullpath = path.resolve(i, target);
		return fs.promises.access(fullpath).then(() => fullpath).catch(() => undefined);
	});
	for (const p of promises) {
		const result = await p;
		if (result)
			return result;
	}
}

//-----------------------------------------------------------------------------
// variable assignment
//-----------------------------------------------------------------------------

interface VariableAssignment {
	name:			string;
	op?:			string;
	value?:			string;
	prefix:			string;
	define:			boolean;
}

function parseAssignment(line: string): VariableAssignment|undefined {
	let m = line.match(/^(?<prefix>(?:\s*(?:override|private))*)\s*define\s+(?<name>[^:#\s]+)\s*(?:(?<op>\+|\?|!|:{0,3})=)?\s*(?<value>.*)$/);
	const define = !!m;
	m ??= line.match(/^(?<prefix>(?:\s*(?:override|private))*)\s*(?<name>[^:#\s]+?)\s*(?<op>\+|\?|!|:{0,3})=\s*(?<value>.*)$/);
	if (m)
		return {...m.groups!, define} as VariableAssignment;
}

//-----------------------------------------------------------------------------
// conditionals
//-----------------------------------------------------------------------------

type Conditional	= 'ifeq'|'ifneq'|'ifdef'|'ifndef';
interface ConditionalLine {
	type: Conditional;
	args: string;
}

function parseConditional(line: string): ConditionalLine|undefined {
	const m = line.match(/^(ifeq|ifneq|ifdef|ifndef)\s+(.*)$/);
	if (m)
		return {type: m[1] as Conditional, args: m[2]};
}

async function doConditional(exp: Expander, condition: ConditionalLine): Promise<boolean|undefined> {
	const equality = async (args: string) => {
		if (args.startsWith('(') && args.endsWith(')')) {
			const [a, b] = await Promise.all(args.slice(1, -1).split(',').map(s => exp.expand(s.trim())));
			return a === b;

		} else if ((args.startsWith('"') || args.startsWith("'")) && (args.endsWith(args[0]))) {
			const [a, s, b] = await Promise.all(args.slice(1, -1).split(args[0]).map(s => exp.expand(s.trim())));
			if (s === '')
				return a === b;
		}
	};

	switch (condition.type) {
		case 'ifeq':	return equality(condition.args);
		case 'ifneq':	return await equality(condition.args) === false;
		case 'ifdef':	return !!exp.get(unescape(condition.args));
		case 'ifndef':	return !exp.get(unescape(condition.args));
	}
}

//-----------------------------------------------------------------------------
// Makefile
//-----------------------------------------------------------------------------

//const suffixes = ['out', 'a', 'ln', 'o', 'c', 'cc', 'C', 'cpp', 'p', 'f', 'F', 'm', 'r', 'y', 'l', 'ym', 'lm', 's', 'S', 'mod', 'sym', 'def', 'h', 'info', 'dvi', 'tex', 'texinfo', 'texi', 'txinfo', 'w', 'ch', 'web', 'sh', 'elc', 'el'];
const features = 'else-if extra-prereqs grouped-target oneshell order-only second-expansion shell-export shortest-stem target-specific undefine';

const directives = ['include', 'sinclude', '-include', 'define', 'endef', 'ifdef', 'ifndef', 'ifeq', 'ifneq', 'else', 'endif', 'export', 'unexport', 'undefine', 'vpath'] as const;
const directiveRe = new RegExp(`^(${directives.join('|')})(?:\\s+(.*))?$`);

type Directive = typeof directives[number];

function isDirective(line: string): {command: Directive, args: string}|undefined {
	const match = line.match(directiveRe);
	if (match)
		return { command: match[1] as Directive, args: match[2] || '' };
}

function assignIfExists<T extends object, K extends keyof T>(obj: T | undefined, key: K, value: T[K]) {
	if (obj)
		obj[key] = value;
}

const dotNames = [
//	'LIBPATTERNS',
	'DEFAULT_GOAL',
	'RECIPEPREFIX',
	'VARIABLES',
	'FEATURES',
	'INCLUDE_DIRS',
] as const;

const plainNames = [
	'VPATH',
	'SUFFIXES',
] as const;

type BuiltinVar = typeof dotNames[number] | typeof plainNames[number];
type BuiltinVars = { [K in BuiltinVar]: string };


export class Makefile extends VariablesClass implements BuiltinVars {
	rules:			RuleEntry[]					= [];
	scopes:			Record<string, Variables>	= {};

	vpath:			Record<string, { re: RegExp, paths: string[] }>	= {};
	vpathAll:		string[]					= [];
	includeDirs:	string[]					= [];

	deferredIncludes:	DeferredInclude[]		= [];
	
	exportAll		= false;
	defaultGoal		= '';
	suffixes		= new Set<string>();
	recipeRe		= /^(?:\t| {4})/;

	set RECIPEPREFIX(val: string)	{
		this.recipeRe	= val ? new RegExp('^' + escapeRe(val[0])) : /^(?:\t| {4})/;
	}
	get VARIABLES()		{ return fromWords(Array.from(this.variables.keys())); }
	get FEATURES()		{ return features; }
	get INCLUDE_DIRS()	{ return fromWords(this.includeDirs); }
	get VPATH()			{ return fromWords(this.vpathAll); }
	get SUFFIXES()		{ return fromWords(Array.from(this.suffixes).map(s => '.' + s)); }
	get DEFAULT_GOAL()	{
		if (!this.defaultGoal) {
			this.defaultGoal = this.rules.find(r => !r.targets[0].startsWith('.'))?.targets[0] ?? '';
		}
		return this.defaultGoal;
	}
	set DEFAULT_GOAL(val)	{ this.defaultGoal = val; }

	makeBuiltinValue(name: BuiltinVar) {
		const desc	= Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), name)!;
		const v = {builtin: true};
		Object.defineProperty(v, 'value', { get: desc.get?.bind(this), set: desc.set?.bind(this) });
		return v as VariableValue;
	}

	constructor(variables: Record<string,VariableValue>, functions: Record<string,Function>, suffixRules: SuffixRule[]) {
		super(new Map(Object.entries(variables)), functions);

		suffixRules.forEach(rule => this.addSuffixRule(rule.from, rule.to, rule.recipe));

		for (const i of dotNames)
			this.variables.set('.' + i, this.makeBuiltinValue(i));
		for (const i of plainNames)
			this.variables.set(i, this.makeBuiltinValue(i));

		this.includeDirs.push(
			this.variables.get('CURDIR')!.value
		);

		this.setFunction('eval',	(_exp, commands: string) => this.parse(commands).then(() => ''));
		this.setFunction('shell',	async (_exp, command: string) => new Promise<string>((resolve, reject) => child_process.exec(command, {
				cwd:		this.cwd(),
				shell:		this.shell(),
				encoding:	'utf8' as const,
				windowsHide: true,
				maxBuffer:	10 * 1024 * 1024
			}, (error: any, stdout: string, _stderr: string) => {
				const code = typeof error?.code === 'number' ? error.code : 0;
				this.variables.set('.SHELLEXIT', { value: String(code) });
				if (error)
					return reject(error);
				resolve(stdout.replace(/\r?\n/g, ' ').trim());
			})
		));
	}

	setFunction(name: string, fn: Function) {
		this.functions[name] = fn;
	}

	cwd() {
		return this.variables.get('CURDIR')?.value ?? process.cwd();
	}
	shell() {
		return process.platform === 'win32'
			? (this.get('SHELL')?.value || this.get('MAKESHELL')?.value || process.env.COMSPEC || 'cmd.exe')
			: (this.get('SHELL')?.value || '/bin/sh');
	}

	isSuffix(name: string): boolean {
		return this.suffixes.has(name);
	}

	addSuffixRule(from: string, to: string|undefined, recipe: string[]) {
		this.suffixes.add(from);
		if (to)
			this.suffixes.add(to);
		this.rules.push({ targets: to ? `%.${to}` : '%', prerequisites: `%.${from}`, recipe });
	}

	async getPath(target: string) {
		if (!path.isAbsolute(target)) {
			const cwd = this.cwd();
			for (const i of Object.values(this.vpath)) {
				const m = i.re.exec(target);
				if (m) {
					const result = await searchPath(target, i.paths.map(i => path.resolve(cwd, i)));
					if (result)
						return path.relative(cwd, result);
				}
			}
			const vpath = this.get('VPATH')?.value;
			if (vpath) {
				const result = await searchPath(target, toWords(vpath).map(i => path.resolve(cwd, i)));
				if (result)
					return path.relative(cwd, result);
			}
		}
		return target;
	}

	async include(files: string[]): Promise<string[]> {
		const promises = files.map(async file => {
			const filepath = await searchPath(file, this.includeDirs);
			return { file, filepath, promise: filepath ? fs.promises.readFile(filepath, 'utf8') : undefined };
		});

		const failed: string[] = [];

		for (const i of promises) {
			const { file, filepath, promise } = await i;
			if (!promise) {
				failed.push(file);
			} else {
				const text = await promise;
				const relative = path.relative(this.cwd(), filepath!);
				try {
					await this.setVariable('MAKEFILE_LIST', '+', filepath!, 'file');
					await this.parse(text, relative);
				} catch (error: any) {
					throw new Error(`${error.message} in ${filepath}`, error.options);
				}
			}
		}
		return failed;
	}

	async parse(text: string, file = '') {
		const lines		= text.split(/\r?\n/);
		const L			= lines.length;

		const setVariable = async (args: VariableAssignment, scope?: Variables) => this.setVariable(
			args.name,
			args.op ?? '',
			args.value ?? '',
			args.prefix.includes('override') ? 'override' : 'file',
			scope,
			args.prefix.includes('private')
		);

		function skipToEndif(i: number, allowElse: boolean): number {
			let depth = 1;
			while (i < L) {
				const line = lines[++i].trim();
				if (line === 'endif') {
					if (--depth === 0)
						break;
				} else if (line.startsWith('if')) {
					++depth;
				} else if (allowElse && line.startsWith('else')) {
					if (depth === 1)
						break;
				}
			}
			return i;
		}

		function readDefine(assign: VariableAssignment, i: number) {
			while (i < L) {
				const line = lines[++i];
				if (line.trim() === 'endef')
					break;
				assign.value += line + '\n';
			}
			return i;
		}

		for (let i = 0, ifdepth = 0; i < L; i++) {
			const lineNo = i + 1;

			try {
				// Recipe line
				if (this.recipeRe.test(lines[i])) {
					if (this.rules.length)
						this.rules.at(-1)!.recipe.push(lines[i].slice(1).trim());
					continue;
				}

				// Logical, non-recipe line (handle backslash continuations)
				let line = '';
				while (i < L && /\\\s*$/.test(lines[i]))
					line += lines[i++].replace(/\\\s*$/, '');
				line += lines[i];

				// Matches an unescaped # preceded by an even number of backslashes
				line = line.replace(/(^|[^\\])((?:\\\\)*)#.*$/, (_m, p1, p2) => (p1 + p2)).trim();
				//line = line.replace(/[^\\](?:\\\\)*#(.*)$/, '').trim();
				if (!line)
					continue;

				// Variable assignment
				const assign = parseAssignment(line);
				if (assign) {
					if (assign.define)
						i = readDefine(assign, i);
					await setVariable(assign);
					continue;
				}

				//directives
				const directive = isDirective(line);//line.match(/^(-?\w+)(?:\s+([^:].*))?$/);
				if (directive) {
					const {command, args} = directive;

					switch (command) {
						case 'ifeq':
						case 'ifneq':
						case 'ifdef':
						case 'ifndef':
							ifdepth++;
							for (let conditional: ConditionalLine|undefined = {type: command, args};
								conditional && !await doConditional(this, conditional);
								conditional = parseConditional(lines[i].slice(4).trim())
							) {
								i = skipToEndif(i, true);
								if (!lines[i].startsWith('else')) {
									--ifdepth;
									break;
								}
							}
							continue;

						case 'else':
							if (ifdepth == 0)
								throw new Error('Unexpected else without ifdef/ifeq/ifneq');
							else
								i = skipToEndif(i, false);
							break;

						case 'endif':
							if (ifdepth == 0)
								throw new Error('Unexpected endif without ifdef/ifeq/ifneq');
							else
								--ifdepth;
							break;

						case 'endef':
							throw new Error('Unexpected endef without define');

						case 'sinclude':
						case '-include':
						case 'include':
							if (args) {
								const files		= toWords(await this.expand(args));
								const noError	= command === 'sinclude'|| command === '-include';
								const failed	= await this.include(files);
								this.deferredIncludes.push(...failed.map(file => ({ file, noError, lineNo })));
							}
							break;

						case 'export': {
							const assign = parseAssignment(args);
							if (assign) {
								if (assign.define)
									i = readDefine(assign, i);
								await setVariable(assign);
								assignIfExists(this.variables.get(assign.name), 'export', true);
							} else {
								const vars = toWords(args);
								if (vars.length)
									vars.forEach(name => assignIfExists(this.variables.get(name), 'export', true));
								else
									this.exportAll = true;
							}
							break;
						}

						case 'unexport': {
							const vars = toWords(args);
							if (vars.length)
								vars.forEach(name => assignIfExists(this.variables.get(name), 'export', false));
							else
								this.exportAll = false;
							break;
						}

						case 'undefine':
							this.variables.delete(args);
							break;

						case 'vpath':
							if (!args) {
								this.vpath = {};
							} else {
								const parts = toWords(args);
								if (parts.length < 2) {
									delete this.vpath[args];
								} else {
									this.vpath[parts[0]] = { re: anchored(escapeRe(parts[0]).replace('%', '.*?')), paths: parts.slice(1) };
								}
							}
							break;

					}
					continue;
				}

				
				// Rule: targets: prerequisites [; recipe]
				const colon = scanBalanced(line, 0, ':');
				if (colon < line.length) {
					const grouped	= line[colon - 1] === '&';
					const left		= line.slice(0, grouped ? colon - 1 : colon).trim();

					if (left) {
						const targets		= left.trim();
						const doubleColon	= line[colon + 1] === ':';
						const right			= line.slice(colon + (doubleColon ? 2 : 1));

						// target or pattern specific variables
						const assign 	= parseAssignment(right);
						if (assign) {
							await setVariable(assign, this.scopes[left] ??= new Map<string, VariableValue>());
							continue;
						}
						const semi 			= right.indexOf(';');
						const prerequisites = (semi >= 0 ? right.slice(0, semi) : right).trim();
						const recipe		= semi >= 0 ? [right.slice(semi + 1).trim()] : [];

						if (targets.includes('.SUFFIXES')) {
							// Handle .SUFFIXES special case
							if (!prerequisites)
								this.suffixes.clear();
							else
								toWords(prerequisites).forEach(suffix => this.suffixes.add(suffix));

						} else {
							// convert (old fashioned) suffix rule
							if (!grouped && !prerequisites && !targets.includes(' ') && targets[0] === '.') {
								const suff = targets.slice(1).split('.');
								if (suff.length < 3 && this.isSuffix(suff[0]) && (suff.length < 2 || this.isSuffix(suff[1]))) {
									this.rules.push({
										targets:		suff.length < 2 ? '%' : '%.' + suff[1],
										prerequisites:	'%.' + suff[0],
										recipe,
										file, lineNo,
										doubleColon, grouped,
									});
									continue;
								}
							}

							this.rules.push({
								targets,
								prerequisites,
								recipe,
								file, lineNo,
								doubleColon, grouped,
							});
						}

						continue;
					}
				}

				line = await this.expand(line);
				if (line)
					throw new Error(`Unrecognized line: ${line}`);

			} catch (error: any) {
				if (file)
					throw new Error(`${error.message} at line ${lineNo} in included ${file}`, error.options);
				else
					throw new Error(`${error.message} at line ${lineNo}`, error.options);
			}
		}
	}

	execute(goals: string[] = [], options?: ExecuteOptions): Promise<boolean> {
		return execute(this, goals, options);
	}

	static async parse(text: string, options?: ParseOptions): Promise<Makefile> {
		const m	= new Makefile(
			options?.variables ?? {},
			options?.functions ? {...defaultFunctions, ...options.functions} : defaultFunctions,
			options?.suffixRules ?? []
		);
		if (options?.includeDirs)
			m.includeDirs.push(...options.includeDirs);
		await m.parse(text);
		return m;
	}

	static async load(filePath: string, options?: ParseOptions): Promise<Makefile> {
		try {
			const text = await fs.promises.readFile(filePath, 'utf8');
			return await this.parse(text, { ...options,
				variables: {...options?.variables,
					CURDIR: 		{ value: path.dirname(filePath) },
					MAKEFILE_LIST:	{ value: filePath },
				}
			});
		} catch (error: any) {
			throw new Error(`${error.message} in ${filePath}`, error.options);
		}
	}
}
