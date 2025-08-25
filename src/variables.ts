import * as fs from 'fs';
import * as path from 'path';

type VariableOrigin	= 'undefined'| 'default' | 'environment' | 'environment override' | 'file' | 'command line' | 'override' | 'automatic';

export interface VariableValue {
	value:			string;
	origin?: 		VariableOrigin;
	recurse?:		boolean;
	priv?:			boolean;
};

export type Variables = Map<string, VariableValue>;

export interface Expander {
	expand(input: string): Promise<string>;
	get(name: string): VariableValue | undefined;
	with(context: Record<string, VariableValue> | Map<string, VariableValue> | undefined): Expander;
	withoutPrivate(): Expander;
}

export interface Function {
	(exp: Expander, ...args: any[]): string | Promise<string>;
	raw?:		boolean;
}

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

export function _wildRe(pattern: string, pct: string) {
	return pattern
		.replace(/[*?.+^${}()|[\]\\]/g, '\\$&') // Escape regex chars
		.replace('%', pct);
}

function fixPatterns(patterns: string[]) {
	return new RegExp(patterns.map(i => _wildRe(i, '.*?')).join('|'));
}

function applyWords(names: string, func: (word: string)=>string) {
	return fromWords(toWords(names).map(func));
}
async function applyWordsAsync(names: string, func: (word: string)=>Promise<string>) {
	return fromWords(await Promise.all(toWords(names).map(func)));
}

function patsubst(pattern: string, replacement: string, text: string) {
	const re = anchored(_wildRe(pattern, '(.*?)'));
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

// Functions for File Names
	dir:		makeWordFunction((name: string) => 			path.dirname(name)),
	notdir:		makeWordFunction((name: string) => 			path.basename(name)),
	suffix:		makeWordFunction((name: string) => 			path.extname(name)),
	basename:	makeWordFunction((name: string) => 			path.format({...path.parse(name), base: '', ext: ''})),
	addsuffix:	(exp, suffix: string, names: string) => 	applyWords(names, name => name + suffix),
	addprefix:	(exp, prefix: string, names: string) => 	applyWords(names, name => prefix + name),
	join: (exp, list1: string, list2: string) => {
		const a = toWords(list1);
		const b = toWords(list2);
		return fromWords(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? '') + (b[i] ?? '')));
	},
	wildcard: async (exp, pattern: string) =>	{
		const cwd	= exp.get('CURDIR')!.value;
		const files = await Promise.all(toWords(pattern).map(async i => {
			const pattern = path.resolve(cwd, i);
			return i.includes('*') || i.includes('?')
				? await getDirs(path.dirname(pattern), globRe(path.basename(pattern)))
				: pattern;
		}));
		return fromWords([...new Set(files.flat())]); // Remove duplicates
	},
	realpath: (exp, names: string) => {
		const cwd		= exp.get('CURDIR')!.value;
		const realpath	= (n: string) => fs.promises.realpath(n).catch(() => n);
		return applyWordsAsync(names, async name => realpath(path.resolve(cwd, name)));
	},
	abspath: (exp, names: string) => {
		const cwd	= exp.get('CURDIR')!.value;
		return applyWords(names, name => path.resolve(cwd, name));
	},

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


//$(file op filename,text)							Expand the arguments, then open the file filename using mode op and write text to that file.
	file: async (exp, op_filename: string, text?: string) => {
		const m = /^(>>|>|<)\s*(.+)$/.exec(op_filename.trim());
		switch (m?.[1]) {
			case '>':
				await fs.promises.writeFile(m[2], text ?? '');
				return '';

			case '>>':
				await fs.promises.appendFile(m[2], text ?? '');
				return '';

			case '<': {
				let content = await fs.promises.readFile(m[2], 'utf8');
				if (content.endsWith('\n'))
					content = content.slice(0, -1);
				return content;
			}
			default:
				throw new Error(`Unknown file operation: ${op_filename}`);
		}
	},

	error:		(exp, message: string) => { throw new Error(message); },
	warning:	(exp, message: string) => { console.warn(message); return ''; },
	info:		(exp, message: string) => { console.info(message); return ''; },
};

//-----------------------------------------------------------------------------
// globs
//-----------------------------------------------------------------------------

function globRe(glob: string) {
	return anchored(glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex chars except * and ?
		.replace(/\*/g, '[^/]*') // * matches any chars except dir separator
		.replace(/\*\*/g, '.*') // ** matches any chars
		.replace(/\?/g, '.') // ? matches single char
	);
}

async function getDirs(dir: string, glob: RegExp): Promise<string[]> {
	const star = dir.indexOf('*');
	if (star >= 0) {
		const startDir	= dir.lastIndexOf(path.sep, star);
		const endDir	= dir.indexOf(path.sep, star);
		const dirDone	= dir.substring(0, startDir);
		const dirWild	= dir.substring(startDir + 1, endDir >= 0 ? endDir : undefined);
		const dirRest	= endDir >= 0 ? dir.substring(endDir + 1) : '';
		const entries	= await fs.promises.readdir(dirDone, { withFileTypes: true });
		
		if (dirWild === '**') {
			if (dirRest) {
				return (await Promise.all(entries.filter(i => i.isDirectory()).map(async i => [
					...await getDirs(path.join(i.parentPath, i.name, '**', dirRest), glob),
					...await getDirs(path.join(i.parentPath, i.name, dirRest), glob)
				]))).flat();
			} else {
				return (await Promise.all(entries.map(i => 
					i.isDirectory()	? getDirs(path.join(i.parentPath, i.name, '**'), glob)
					: glob.test(i.name) ? path.join(i.parentPath, i.name)
					: []
				))).flat();
			}
		} else {
			const dirGlob = globRe(dirWild);
			return (await Promise.all(entries
				.filter(i => i.isDirectory() && dirGlob.test(i.name))
				.map(i => getDirs(path.join(dirDone, i.name, dirRest), glob))
			)).flat();
		}
	} else {
		try {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			return entries
				.filter(i => !i.isDirectory() && glob.test(i.name))
				.map(i => path.join(i.parentPath, i.name));
		} catch (error) {
			console.log(`Warning: Cannot read directory ${dir}: ${error}`);
			return [];
		}
	}
}

//-----------------------------------------------------------------------------
// Expander
//-----------------------------------------------------------------------------

function nextChar(input: string, i: number) {
	const c = input[i];

	if (c === '^') {
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
				throw new Error(`Unknown function: ${name} in $(${body})`);

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

		if (!this.get(body) && body.length === 2 && (body[1] === 'D' || body[1] === 'F')) {
			const base = this.get(body[0])?.value;
			if (base)
				return body[1] === 'D' ? path.dirname(base) : path.basename(base);
		}

		//if (!this.get(name))
		//	console.log(`Unknown variable: ${body}`);

		const val	= this.get(name)?.value ?? '';
		return this.get(name)?.recurse
			? this.expand(val)
			: val;
	}

	constructor(public variables: Variables, public functions: Record<string, Function>, private depth = 0) {
	}

	get(name: string): VariableValue | undefined {
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
			this.functions, this.depth
		) : this;
	}

	withoutPrivate(): Expander {
		return new ExpanderClass(
			new Map([...this.variables].filter(([_, v]) => !v.priv)),
			this.functions, this.depth
		);
	}
}

//-----------------------------------------------------------------------------
// VariablesClass adds setVariable
//-----------------------------------------------------------------------------

export class VariablesClass extends ExpanderClass {
	async setVariable(name: string, op: string, value: string, origin: VariableOrigin, scope?: Variables, priv?: boolean) {
		const readscope = scope ? new Map([...this.variables, ...scope]) : this.variables;
		if (!scope)
			scope = this.variables;

		const old_origin = scope.get(name)?.origin;
		if (old_origin === 'command line' && origin !== 'override')
			return;
		if (old_origin === 'environment' && origin === 'override')
			origin = 'environment override';

		const exp = new ExpanderClass(readscope, this.functions);
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

			default:
				scope.set(name, { value, origin, priv, recurse: true });
				break;
		}
	}
}

// fix windows vars like ProgramFiles(x86)
function fix_name(input: string): string {
	return input.replace(/[():]/g, '^$&');
}

export function getEnvironmentVariables(): Record<string, VariableValue> {
	const env: Record<string, VariableValue> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined)
			env[fix_name(k)] = {value: v, origin: 'environment'};
	}
	return env;
}
