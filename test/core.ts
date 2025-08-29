import { Variables, VariableValue, Function, VariablesClass, fromWords, toWords, defaultFunctions, escapeRe } from "./variables";
import * as path from 'path';
import * as fs from 'fs';

export interface SuffixRule {
	from:	string;
	to?:	string;
	recipe:	string[];
}

export interface RuleEntry {
	targets:		string;
	prerequisites:	string;
	recipe?:		string[];
	file?:			string;
	lineNo?:		number;		// line of the rule header (1-based)
	doubleColon?:	boolean;	// means 'terminal' on pattern rules
	grouped?:		boolean;	// true if the rule is a grouped rule
}

export interface DeferredInclude {
	file:			string;
	lineNo:			number;
	noError:		boolean;
}

export interface CreateOptions {
	variables?:		Record<string, VariableValue>;
	functions?:		Record<string, Function>;
	rules?:			RuleEntry[];
	includeDirs?:	string[];
	envOverrides?:	boolean;
	warnUndef?: 	boolean;
}

//-----------------------------------------------------------------------------
// Makefile
//-----------------------------------------------------------------------------

//const suffixes = ['out', 'a', 'ln', 'o', 'c', 'cc', 'C', 'cpp', 'p', 'f', 'F', 'm', 'r', 'y', 'l', 'ym', 'lm', 's', 'S', 'mod', 'sym', 'def', 'h', 'info', 'dvi', 'tex', 'texinfo', 'texi', 'txinfo', 'w', 'ch', 'web', 'sh', 'elc', 'el'];
const features = 'else-if extra-prereqs grouped-target oneshell order-only second-expansion shell-export shortest-stem target-specific undefine';
//'.FEATURES':		'target-specific order-only second-expansion else-if shortest-stem undefine oneshell archives jobserver output-sync load',

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
	'CURDIR',
] as const;

type BuiltinVar		= typeof dotNames[number] | typeof plainNames[number];
type BuiltinVars	= { [K in BuiltinVar]: string };
/*
function makeBuiltinValue(obj: any, name: string, old?: VariableValue) {
	let desc: PropertyDescriptor | undefined;
	while (obj && !(desc = Object.getOwnPropertyDescriptor(obj, name)))
		obj = Object.getPrototypeOf(obj);

	const v			= {builtin: true};
	const direct	= desc?.value !== undefined;
	Object.defineProperty(v, 'value', {
		get: direct ? () => obj[name] : desc?.get?.bind(obj),
		set: direct ? (v: string) => obj[name] = v : desc?.set?.bind(obj)
	});

	const vv	= v as VariableValue;
	if (old && (direct || desc?.set))
		vv.value = old.value;

	return vv;
}
*/
export class MakefileCore extends VariablesClass implements BuiltinVars {
	rules:			RuleEntry[]					= [];
	scopes:			Record<string, Variables>	= {};
	suffixes: 		Set<string>;

	vpath:			Record<string, { re: RegExp, paths: string[] }>	= {};
	vpathAll:		string[]					= [];

	includeDirs:	string[]					= [];
	deferredIncludes:	DeferredInclude[]		= [];
	
	exportAll		= false;
	defaultGoal		= '';
	recipeRe		= /^(?:\t| {4})/;

	CURDIR			= '';

	set RECIPEPREFIX(val: string)	{
		this.recipeRe	= val ? new RegExp('^' + escapeRe(val[0])) : /^(?:\t| {4})/;
	}
	get VARIABLES()			{ return fromWords(Array.from(this.variables.keys())); }
	get FEATURES()			{ return features; }
	get INCLUDE_DIRS()		{ return fromWords(this.includeDirs.map(v => path.relative(this.CURDIR, v))); }
	get VPATH()				{ return fromWords(this.vpathAll); }
	get SUFFIXES()			{ return fromWords(Array.from(this.suffixes).map(s => '.' + s)); }
	get DEFAULT_GOAL()		{
		if (!this.defaultGoal)
			this.defaultGoal = toWords(this.rules.find(r => !r.targets.startsWith('.'))?.targets ?? '')[0];
		return this.defaultGoal;
	}
	set DEFAULT_GOAL(val)	{ this.defaultGoal = val; }

	private makeBuiltinValue(name: BuiltinVar, varname: string) {
		let obj: any = this;
		let desc: PropertyDescriptor | undefined;
		while (obj && !(desc = Object.getOwnPropertyDescriptor(obj, name)))
			obj = Object.getPrototypeOf(obj);

		const v			= {builtin: true};
		const direct	= desc?.value !== undefined;
		Object.defineProperty(v, 'value', {
			get: direct ? () => this[name] : desc?.get?.bind(this),
			set: direct ? (v: string) => (this as any)[name] = v : desc?.set?.bind(this)
		});

		const vv	= v as VariableValue;
		const old	= this.variables.get(varname);
		if (old && (direct || desc?.set))
			vv.value = old.value;

		this.variables.set(varname, vv);
	}
	constructor(options?: CreateOptions) {
		super(
			new Map(Object.entries({
				SHELL: 			{ value: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'},
				MAKESHELL: 		{ value: process.env.COMSPEC || 'cmd.exe' },
				MAKE_VERSION: 	{ value: '1.0'},
				MAKE_HOST: 		{ value: process.platform },
				//...Object.fromEntries(dotNames.map(i => [i, makeBuiltinValue(this, i, variables?.[i])])),
				//...Object.fromEntries(plainNames.map(i => ['.' + i, makeBuiltinValue(this, i, variables?.['.' + i])])),
				...options?.variables
			})),
			options?.functions ?? defaultFunctions,
			options?.warnUndef ?? false,
			options?.envOverrides ?? false
		);


		this.rules		= options?.rules ?? [];
		this.suffixes	= new Set(this.rules.filter(({targets, prerequisites}) => targets === '%' && prerequisites.startsWith('%.') && !prerequisites.includes(' ')).map(rule => rule.prerequisites.slice(1)));

		for (const i of dotNames)
			this.makeBuiltinValue(i, '.' + i);
		for (const i of plainNames)
			this.makeBuiltinValue(i, i);

		if (options?.includeDirs)
			this.includeDirs.push(...options.includeDirs.map(i => path.resolve(this.CURDIR, i)));
	}

	shell() {
		return (process.platform === 'win32' && this.get('MAKESHELL')?.value) || this.get('SHELL')?.value;
	}
	isSuffix(name: string): boolean {
		return this.suffixes.has(name);
	}

}

export async function searchPath(target: string, paths: string[]): Promise<string|undefined> {
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

export async function getPaths(files: string[], paths: string[]) {
	return files.map(async file => {
		const filepath = await searchPath(file, paths);
		return { file, filepath, promise: filepath ? fs.promises.readFile(filepath, 'utf8') : undefined };
	});
}
