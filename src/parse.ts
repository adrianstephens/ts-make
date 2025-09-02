import { MakefileCore, VariableValue, Variables, Expander, toWords, scanBalanced, unescape } from './core';

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
// include
//-----------------------------------------------------------------------------

export async function includeFiles(mf: MakefileCore, files: string[]): Promise<string[]> {
	const promises = mf.loadIncludes(files);
	const failed: string[] = [];

	for (const i of promises) {
		const { file, filepath, promise } = await i;
		if (!promise) {
			failed.push(file);
		} else {
			const text = await promise;
			try {
				await mf.setVariable('MAKEFILE_LIST', '+', filepath!, 'file');
				await parse(mf, text, file);
			} catch (error: any) {
				throw new Error(`${error.message} in included ${file}`, error.options);
			}
		}
	}
	return failed;
}

//-----------------------------------------------------------------------------
// Makefile
//-----------------------------------------------------------------------------

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

export async function parse(mf: MakefileCore, text: string, file: string) {
	const lines		= text.split(/\r?\n/);
	const L			= lines.length;

	const setVariable = async (args: VariableAssignment, scope?: Variables) => mf.setVariable(
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
			if (mf.recipeRe.test(lines[i])) {
				mf.addRecipeLine(lines[i].slice(1).trim());
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
			const directive = isDirective(line);
			if (directive) {
				const {command, args} = directive;

				switch (command) {
					case 'ifeq':
					case 'ifneq':
					case 'ifdef':
					case 'ifndef':
						ifdepth++;
						for (let conditional: ConditionalLine|undefined = {type: command, args};
							conditional && !await doConditional(mf, conditional);
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
							throw new Error('Unexpected else without ifdef/ifndef/ifeq/ifneq');
						else
							i = skipToEndif(i, false);
						break;

					case 'endif':
						if (ifdepth == 0)
							throw new Error('Unexpected endif without ifdef/ifndef/ifeq/ifneq');
						else
							--ifdepth;
						break;

					case 'endef':
						throw new Error('Unexpected endef without define');

					case 'sinclude':
					case '-include':
					case 'include':
						if (args) {
							const files		= toWords(await mf.expand(args));
							const noError	= command === 'sinclude'|| command === '-include';
							const failed	= await includeFiles(mf, files);
							mf.deferredIncludes.push(...failed.map(file => ({ file, noError, lineNo })));
						}
						break;

					case 'export': {
						const assign = parseAssignment(args);
						if (assign) {
							if (assign.define)
								i = readDefine(assign, i);
							await setVariable(assign);
							assignIfExists(mf.variables.get(assign.name), 'export', true);
						} else {
							const vars = toWords(args);
							if (vars.length)
								vars.forEach(name => assignIfExists(mf.variables.get(name), 'export', true));
							else
								mf.exportAll = true;
						}
						break;
					}

					case 'unexport': {
						const vars = toWords(args);
						if (vars.length)
							vars.forEach(name => assignIfExists(mf.variables.get(name), 'export', false));
						else
							mf.exportAll = false;
						break;
					}

					case 'undefine':
						mf.variables.delete(args);
						break;

					case 'vpath': {
						const parts = toWords(args);
						if (!parts.length)
							mf.setVPath('');
						else
							mf.setVPath(parts[0], parts.slice(1));
						break;
					}

				}
				continue;
			}

			
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
						await setVariable(assign, mf.scopes[left] ??= new Map<string, VariableValue>());
						continue;
					}
					const semi 			= right.indexOf(';');
					const prerequisites = (semi >= 0 ? right.slice(0, semi) : right).trim();
					const recipe		= semi >= 0 ? [right.slice(semi + 1).trim()] : [];

					if (targets.includes('.SUFFIXES')) {
						// Handle .SUFFIXES special case
						if (!prerequisites)
							mf.suffixes.clear();
						else
							toWords(prerequisites).forEach(suffix => mf.suffixes.add(suffix));

					} else {
						// convert (old fashioned) suffix rule
						if (!grouped && !prerequisites && !targets.includes(' ') && targets[0] === '.') {
							const suff = targets.slice(1).split('.');
							if (suff.length < 3 && mf.suffixes.has(suff[0]) && (suff.length < 2 || mf.suffixes.has(suff[1]))) {
								mf.rules.push({
									targets:		suff.length < 2 ? '%' : '%.' + suff[1],
									prerequisites:	'%.' + suff[0],
									recipe,
									file, lineNo,
									doubleColon, grouped,
								});
								continue;
							}
						}

						mf.addRule({
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

			line = await mf.expand(line);
			if (line)
				throw new Error(`Unrecognized line: ${line}`);

		} catch (error: any) {
			throw new Error(`${error.message} at line ${lineNo}`, error.options);
		}
	}
}
