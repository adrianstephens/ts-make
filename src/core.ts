type VariableOrigin	= 'undefined'| 'default' | 'environment' | 'environment override' | 'file' | 'command line' | 'override' | 'automatic';

export interface VariableValue {
	value:			string;
	origin?: 		VariableOrigin;
	recurse?:		boolean;
	priv?:			boolean;
	export?:		boolean;
	builtin?:		boolean;
};

export type Variables = Map<string, VariableValue>;

export interface Expander {
	expand(input: string): Promise<string>;
	get(name: string): VariableValue | undefined;
	with(context: Record<string, VariableValue> | Map<string, VariableValue> | undefined): Expander;
	withoutPrivate(): Expander;
	exports(all: boolean): Record<string, string>;
}

export interface Function {
	(exp: Expander, ...args: any[]): string | Promise<string>;
	raw?:		boolean;
}

export type SearchPath = (file: string, paths: string[], cwd: string) => Promise<string | undefined>;
export type IncludeFiles = (files: string[]) => Promise<string[]>;

//-----------------------------------------------------------------------------
// functions
//-----------------------------------------------------------------------------

export function escape(input: string): string {
	return input
		.replaceAll('$', '$$')
		.replaceAll('\\', '\\\\')
		.replaceAll('#', '\\#');
}
export function unescape(input: string): string {
	return input
		.replaceAll('$$', '$')
		.replaceAll('\\\\', '\\')
		.replaceAll('\\#', '#');
}

export function toWords(text: string) {
	text = text.trim();
	return text ? text.split(/\s+/) : [];
}
export function fromWords(text: string[]) {
	return text.filter(Boolean).join(' ');
}

export function anchored(pattern: string) {
	return new RegExp('^' + pattern + '$');
}

export function escapeRe(pattern: string) {
	return pattern.replace(/[*?.+^${}()|[\]\\]/g, '\\$&'); // Escape regex chars
}

function fixPatterns(patterns: string[]) {
	return new RegExp(patterns.map(i => escapeRe(i).replace('%', '.*?')).join('|'));
}

export function applyWords(names: string, func: (word: string)=>string) {
	return fromWords(toWords(names).map(func));
}
export async function applyWordsAsync(names: string, func: (word: string)=>Promise<string>) {
	return fromWords(await Promise.all(toWords(names).map(func)));
}

function patsubst(pattern: string, replacement: string, text: string) {
	const re = anchored(escapeRe(pattern).replace('%', '(.*?)'));
	replacement = replacement.replace('%', '$1');
	return applyWords(text, word => word.replace(re, replacement));
}

function raw<F extends(exp: Expander, ...args: any[]) => any>(fn: F): Function {
	return Object.assign(fn, {raw: true});
}

export function makeWordFunction(fn: (name: string) => string): Function {
	return (exp, names) => applyWords(names, fn);
}

export const defaultFunctions: Record<string, Function> = {
// Functions for String Substitution and Analysis
	subst:		(exp, pattern: string, replacement: string, text: string) => text.replace(new RegExp(pattern, 'g'), replacement),
	patsubst:	(exp, pattern: string, replacement: string, text: string) => patsubst(pattern, replacement, text),
	strip:		(exp, text: string) =>						fromWords(toWords(text)),
	findstring:	(exp, find: string, text: string) =>		text.includes(find) ? find : '',
	filter:		(exp, patterns: string, text: string) => {
		const re = fixPatterns(toWords(patterns));
		return fromWords(toWords(text).filter(word => re.test(word)));
	},
	'filter-out': (exp, patterns: string, text: string) => {
		const re = fixPatterns(toWords(patterns));
		return fromWords(toWords(text).filter(word => !re.test(word)));
	},
	sort:		(exp, text: string) =>						fromWords([...new Set(toWords(text))].sort()),
	word:		(exp, index: string, text: string) => 		toWords(text)[+index - 1] || '',
	words:		(exp, text: string) => 						toWords(text).length.toString(),
	wordlist:	(exp, s: string, e: string, text: string)=> toWords(text).slice(+s - 1, +e).join(' '),
	firstword:	(exp, names: string) =>						toWords(names)[0] || '',
	lastword:	(exp, names: string) =>						toWords(names).at(-1) || '',

	addsuffix:	(exp, suffix: string, names: string) => 	applyWords(names, name => name + suffix),
	addprefix:	(exp, prefix: string, names: string) => 	applyWords(names, name => prefix + name),
	join: (exp, list1: string, list2: string) => {
		const a = toWords(list1);
		const b = toWords(list2);
		return fromWords(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? '') + (b[i] ?? '')));
	},

// (Functions for File Names moved to index)

// Functions for Conditionals
	if:		(exp, condition: string, then: string, else_: string) => condition.trim() ? then : else_,
	or:		(exp, ...args: string[]) => args.find(arg => arg.trim()) ?? '',
	and:	(exp, ...args: string[]) => args.find(arg => !arg.trim()) ?? args.at(-1) ?? '',
	intcmp: (exp, lhs: string, rhs: string, lt: string, eq: string, gt: string) => +lhs < +rhs ? lt : +lhs === +rhs ? eq : gt,

	
// Functions for Variables
	value:	(exp, v: string) => exp.get(v)?.value ?? '',
	origin:	(exp, v: string) => exp.get(v)?.origin ?? 'undefined',
	flavor:	(exp, v: string) => exp.get(v)?.recurse ? 'recursive' : 'simple',

// Others

//$(let var [var ...],words,text)					Evaluate text with the exp bound to the words in words.
	let: raw(async (exp, names: string, values: string, text: string) => {
		const varsList 		= toWords(await exp.expand(names));
		const valuesList	= toWords(await exp.expand(values));
		const lets: Record<string, VariableValue> = Object.fromEntries(varsList.map((name, i) => [name, {value: valuesList[i] ?? ''}]));

		const nvars = varsList.length;
		if (valuesList.length > nvars)
			lets[varsList[nvars - 1]] = {value: valuesList.slice(nvars).join(' ')};

		return exp.with(lets).expand(text);
	}),

//$(foreach var,words,text)							Evaluate text with var bound to each word in words, and concatenate the results.
	foreach: raw(async (exp, name: string, values: string, text: string) => {
		name	= await exp.expand(name);
		values	= await exp.expand(values);
		return applyWordsAsync(values, async value => await exp.with({[name]: { value }}).expand(text));
	}),

//$(call var,param,...)								Evaluate the variable var replacing any references to $(1), $(2) with the first, second, etc. param values.
	call: (exp, name: string,...args: string[]) => {
		const v	= exp.get(name);
		return v
			? exp.with({ '0': v!, ...Object.fromEntries(args.map((value, i) => [(i + 1).toString(), { value }] )) }).expand(v.value)
			: '';
		//throw new Error(`Unknown variable: ${name}`);
	},

	error:		(exp, message: string) => { throw new Error(message); },
	warning:	(exp, message: string) => { console.warn(message); return ''; },
	info:		(exp, message: string) => { console.info(message); return ''; },
};


//-----------------------------------------------------------------------------
// Expander
//-----------------------------------------------------------------------------

function nextChar(input: string, i: number) {
	const c = input[i];

	if (c === '\\') {
		++i;

	} else if (c === '$' && i < input.length) {
		const n = input[i + 1];
		if (n === '$')
			++i;
		else if (n === '(' || n === '{')
			i = scanBalanced(input, i + 2, n === '(' ? ')' : '}');
	}
	return i;
}

export function scanBalanced(input: string, i: number, ch: string) {
	for (; i < input.length; i++) {
		if (input[i] === ch)
			break;

		i = nextChar(input, i);
	}
	return i;
}

export class ExpanderClass implements Expander {
	private async expandOne(body: string): Promise<string> {
		let end = 0;
		while (end < body.length && body[end] !== ' ' && body[end] !== ':')
			end = nextChar(body, end) + 1;

		const name	= await this.expand(body.slice(0, end));

		if (body[end] === ':') {
			const eq	= scanBalanced(body, end + 1, '=');
			if (eq < body.length) {
				const [pattern, replacement, text] = await Promise.all([
					this.expand(body.slice(end + 1, eq).trim()),
					this.expand(body.slice(eq + 1).trim()),
					this.expand(this.get(name)?.value ?? '')
				]);
				return pattern.includes('%')
					? patsubst(pattern, replacement, text)
					: patsubst('%' + pattern, '%' + replacement, text);
			}
		}

		if (end < body.length) {
			const fn	= this.functions[name];
			if (!fn)
				throw new Error(`Unknown function: ${name}`);

			const raw = fn.raw ?? false;
			const args: (string|Promise<string>)[] = [];
			for (let j = end; j < body.length; ++j) {
				const j0 = j;
				j = scanBalanced(body, j, ',');
				const arg = body.slice(j0, j).trim();
				args.push(raw ? arg : this.expand(arg));
			}

			try {
				return fn(this, ...await Promise.all(args));
			} catch (error) {
				console.log(`Error expanding $(${body}): ${error}`);
				return '';
			}
		}

/*
		if (!this.variables.get(name) && name.length === 2 && (name[1] === 'D' || name[1] === 'F')) {
			const base = this.get(name)?.value;
			if (base)
				return name[1] === 'D' ? path.dirname(base) : path.basename(base);
		}
*/
		const val	= this.get(name)?.value ?? '';
		return this.get(name)?.recurse
			? this.expand(val)
			: val;
	}

	constructor(public variables: Variables, public functions: Record<string, Function>, private depth: number, private warnUndef: boolean) {
	}

	get(name: string): VariableValue | undefined {
		if (this.warnUndef && !this.variables.has(name))
			console.log(`Unknown variable: ${name}`);
		return this.variables.get(name);
	}

	async expand(input: string): Promise<string> {
		//return expandVariables(input, this.variables, this.functions);
		if (this.depth > 50) {
			console.warn(`Potential infinite recursion detected: ${input}`);
			return input;
		}

		++this.depth;
		const chunks: (string|Promise<string>)[] = [];
		for (let i = 0; i < input.length; i++) {
			const d = input.indexOf('$', i);
			if (d < 0) {
				chunks.push(input.slice(i));
				break;
			}

			const n = input[d + 1];

			if (n === '$') {
				chunks.push(input.slice(i, d + 1));
				i = d + 1;
			} else {
				chunks.push(input.slice(i, d));

				if (n === '(' || n === '{') {
					i = scanBalanced(input, d + 2, n === '(' ? ')' : '}');
					chunks.push(this.expandOne(input.slice(d + 2, i).trim()));

				} else {
					//if (!this.get(n))
					//	console.log(`Unknown variable: ${n}`);
					chunks.push(this.get(n)?.value ?? '');
					i = d + 1;
				}
			}
		}
		--this.depth;
		return (await Promise.all(chunks)).join('');
	}

	with(context: Record<string, VariableValue> | Map<string, VariableValue> | undefined): Expander {
		return context ? new ExpanderClass(
			new Map([...this.variables, ...(context instanceof Map ? context : Object.entries(context))]),
			this.functions, this.depth, this.warnUndef
		) : this;
	}

	withoutPrivate(): Expander {
		return new ExpanderClass(
			new Map([...this.variables].filter(([_, v]) => !v.priv)),
			this.functions, this.depth, this.warnUndef
		);
	}
	
	exports(all: boolean) {
		const exp = all ? [...this.variables.entries()] : [...this.variables.entries()].filter(([, value]) => value.export);
		return Object.fromEntries(exp.map(([k, v]) => [k, v.value]));
	}

}

//-----------------------------------------------------------------------------
// MakefileCore
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

function makeBuiltinValue(obj: any, name: string, old?: VariableValue) {
	let desc: PropertyDescriptor | undefined;
	for (let p = obj; p && !(desc = Object.getOwnPropertyDescriptor(p, name)); p = Object.getPrototypeOf(p))
		;

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
export interface RuleEntry {
	targets:		string;
	prerequisites:	string;
	recipe?:		string[];
	file?:			string;
	lineNo?:		number;		// line of the rule header (1-based)
	doubleColon?:	boolean;	// means 'terminal' on pattern rules
	grouped?:		boolean;	// true if the rule is a grouped rule
	builtin?:		boolean;	// true if the rule is a builtin rule
}

export interface DeferredInclude {
	file:			string;
	lineNo:			number;
	noError:		boolean;
}

export class MakefileCore extends ExpanderClass implements BuiltinVars {
	scopes:			Record<string, Variables>	= {};
	suffixes: 		Set<string>;

	vpath:			Record<string, { re: RegExp, paths: string[] }>	= {};
	vpathAll:		string[]					= [];

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
	get INCLUDE_DIRS()		{ return fromWords(this.includeDirs); }
	get VPATH()				{ return fromWords(this.vpathAll); }
	get SUFFIXES()			{ return fromWords(Array.from(this.suffixes).map(s => '.' + s)); }
	get DEFAULT_GOAL()		{
		if (!this.defaultGoal)
			this.defaultGoal = toWords(this.rules.find(r => !r.builtin && !r.targets.includes('%') && !r.targets.startsWith('.'))?.targets ?? '')[0];
		return this.defaultGoal;
	}
	set DEFAULT_GOAL(val)	{ this.defaultGoal = val; }

	constructor(
		variables: Record<string, VariableValue>,
		functions: Record<string, Function>,
		public rules: RuleEntry[],
		public includeDirs: string[],
		warnUndef: boolean, public envOverrides: boolean
	) {
		super(new Map(Object.entries(variables)), functions, 0, warnUndef);

		for (const i of '?@*%^+<') {
			this.variables.set(i + 'D', { value: `$(patsubst %/,%,$(patsubst %\\,%,$(dir $${i})))`, origin: 'automatic', recurse: true });
			this.variables.set(i + 'F', { value: `$(notdir $${i})`, origin: 'automatic', recurse: true });
		}

		this.suffixes	= new Set(this.rules.filter(({targets, prerequisites}) => targets === '%' && prerequisites.startsWith('%.') && !prerequisites.includes(' ')).map(rule => rule.prerequisites.slice(1)));

		for (const i of dotNames)
			this.variables.set('.' + i, makeBuiltinValue(this, i, this.variables.get('.' + i)));
		for (const i of plainNames)
			this.variables.set(i, makeBuiltinValue(this, i, this.variables.get(i)));
	}

	async setVariable(name: string, op: string, value: string, origin: VariableOrigin, scope?: Variables, priv?: boolean) {
		const exp = this.with(scope);
		if (!scope)
			scope = this.variables;

		const old = scope.get(name);
		if (old?.origin === 'command line' && origin !== 'override')
			return;
		if (old?.origin === 'environment') {
			if (origin === 'override')
				origin = 'environment override';
			else if (this.envOverrides)
				return;
		}

		switch (op) {
			case ':':
			case '::':		// immediate expansion
				scope.set(name, {value: await exp.expand(value), origin, priv});
				break;

			case ':::':		// immediate-with-escape
				scope.set(name, {value: escape(await exp.expand(value)), origin, priv, recurse: true});
				break;

			case '?':		// conditional deferred
				if (!scope.has(name))
					scope.set(name, { value, origin, recurse: true });
				break;

			case '+':
				if (!scope.has(name))
					scope.set(name, { value, origin, priv, recurse: true });
				else
					scope.get(name)!.value += ' ' + (scope.get(name)!.recurse ? await exp.expand(value) : value);
				break;

			case '!':
				value = await this.functions.shell(this, value);
				//fallthrough
			default:
				if (old?.builtin) {
					[old.value, old.origin] = [value, origin];
				} else {
					scope.set(name, { value, origin, priv, recurse: true });
				}
				break;
		}
	}

	addRule(rule: RuleEntry) {
		this.rules.push(rule);
	}
	addRecipeLine(line: string) {
		if (this.rules.length)
			(this.rules.at(-1)!.recipe ??= []).push(line);
	}

	setVPath(pattern: string, dirs?: string[]) {
		if (pattern) {
			if (dirs)
				this.vpath[pattern] = { re: anchored(escapeRe(pattern).replace('%', '.*?')), paths: dirs };
			else
				delete this.vpath[pattern];
		} else {
			if (dirs)
				this.vpathAll.push(...dirs);
			else
				this.vpath = {};
		}
	}

}
