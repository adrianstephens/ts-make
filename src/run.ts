import { MakefileCore, RuleEntry, Variables, Expander, toWords, fromWords, anchored, escapeRe } from './core';
import { include } from './parse';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';

export type RunMode = 'normal' | 'dry-run' | 'question' | 'touch';

export interface RunDebug {
	level?: 		number;
	implicit?: 		boolean;
	jobs?: 			boolean;
	makefile?: 		boolean;
	recipe?: 		boolean;
	why?: 			boolean;
};

export interface RunOptions {
	output?: (text: string) => void;
	jobs?: 			number;
	mode?: 			RunMode;
	ignoreErrors?: 	boolean;
	silent?: 		boolean;
	noSilent?: 		boolean;
	oneshell?: 		boolean;
	always?: 		boolean;
	keepGoing?: 	boolean;
	checkSymlink?:	boolean;
	printDirectory?: boolean;
	assumeOld?: 	string[];
	assumeNew?: 	string[];
	//unimplemented
	debug?: 		RunDebug;
	maxLoad?:		number;
	shuffle?: 		'reverse' | number;
	outputSync?: 	'target' | 'line' | 'recurse';
}

/*
// gnu's way to implement these automatic variables
const builtinVarsAuto: Record<string, string> = {
	'?D':				'$(patsubst %/,%,$(patsubst %\\,%,$(dir $?)))',
	'?F':				'$(notdir $?)',
	'@D':				'$(patsubst %/,%,$(patsubst %\\,%,$(dir $@)))',
	'@F':				'$(notdir $@)',
	'*D':				'$(patsubst %/,%,$(patsubst %\\,%,$(dir $*)))',
	'*F':				'$(notdir $*)',
	'%D':				'$(patsubst %/,%,$(patsubst %\\,%,$(dir $%)))',
	'%F':				'$(notdir $%)',
	'^D':				'$(patsubst %/,%,$(patsubst %\\,%,$(dir $^)))',
	'^F':				'$(notdir $^)',
	'+D':				'$(patsubst %/,%,$(patsubst %\\,%,$(dir $+)))',
	'+F':				'$(notdir $+)',
	'<D':				'$(patsubst %/,%,$(patsubst %\\,%,$(dir $<)))',
	'<F':				'$(notdir $<)',
};
*/

async function mapAsync<T, U>(arr: T[], fn: (arg: T) => Promise<U>): Promise<U[]> {
	return Promise.all(arr.map(fn));
}

async function getTimestamp(filepath: string, checkSymlink = false): Promise<number> {
	try {
		const linkStat = await fs.promises.lstat(filepath);
		if (!checkSymlink || !linkStat.isSymbolicLink())
			return linkStat.mtimeMs;
		const targetStat = await fs.promises.stat(filepath);
		return Math.max(linkStat.mtimeMs, targetStat.mtimeMs);
	} catch {
		return 0;
	}
}

//-----------------------------------------------------------------------------
// Semaphore
//-----------------------------------------------------------------------------

interface Lock {
	release(): void;
}

interface WaitingPromise {
	resolve(lock: Lock): void;
	reject(err?: Error): void;
}

class Semaphore {
	private running = 0;
	private waiting: WaitingPromise[] = [];

	constructor(public max: number) {
	}

	private release() {
		this.running--;
		// If there are tasks waiting and we can run more, start the next task
		if (this.running < this.max && this.waiting.length > 0) {
			this.running++;
			// Get the next task from the queue and resolve the promise to allow it to start, provide a release function
			this.waiting.shift()!.resolve({release: this.release.bind(this)});
		}
	}

	acquire(): Promise<Lock> {
		if (this.running < this.max) {
			this.running++;
			return Promise.resolve({release: this.release.bind(this)});
		}
		return new Promise<Lock>((resolve, reject) => this.waiting.push({resolve, reject}));
	}


	// Purge all waiting tasks
	purge(reason = 'The semaphore was purged'): void {
		this.waiting.forEach(task => task.reject(new Error(reason)));
		this.running = 0;
		this.waiting = [];
	}
}

//-----------------------------------------------------------------------------
// runRecipe
//-----------------------------------------------------------------------------

const reHasMAKE = /\$\((?:MAKE)\)|\$\{(?:MAKE)\}/;

function parseRecipeLine(line: string) {
	const m = /^([-+@]*)(.*)/.exec(line)!;
	return {
		ignore: m[1].includes('-'),
		silent: m[1].includes('@'),
		force:	m[1].includes('+') || reHasMAKE.test(m[2]),
		cmd:	m[2]
	};
}

function close(code: number|null, ignore: boolean, resolve: (value: number) => void, reject: (reason?: Error) => void) {
	if (code && !ignore)
		reject(new Error(`Command failed with exit code ${code}`));
	else
		resolve(0);
}

// Execute recipe lines
async function runRecipe(recipe: string[], exp: Expander, opt: RunOptions, spawnOpts: child_process.SpawnOptions): Promise<void> {
	function echo(child: child_process.ChildProcess) {
		child.stdout?.on('data', chunk => opt.output!(chunk.toString()));
		child.stderr?.on('data', chunk => opt.output!(chunk.toString()));
	}

	if (opt.oneshell && recipe.length > 1) {
		const first		= parseRecipeLine(recipe[0])!;
		const cmds 		= (await mapAsync([first.cmd, ...recipe.slice(1)], async raw => (await exp.expand(raw)).trim())).filter(Boolean);
		const ignore	= opt.ignoreErrors || first.ignore;

		if (opt.noSilent || !(first.silent || opt.silent)) {
			for (const i of cmds)
				opt.output!(i + '\r\n');
		}

		if (opt.mode === 'normal' || first.force || recipe.some(r => reHasMAKE.test(r))) {
			if (process.platform === 'win32') {
				const script = cmds.map(ignore
					? cmd => `call ${cmd}`
					: cmd => `call ${cmd} || exit /b %ERRORLEVEL%`
				).join('\r\n');

				const file = path.join(os.tmpdir(), `taskmake-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.cmd`);
				await fs.promises.writeFile(file, script, 'utf8');

				await new Promise<number>((resolve, reject) => echo(
					child_process.spawn(file, [], spawnOpts)
					.on('error', err => reject(err))
					.on('close', code => {
						fs.promises.unlink(file).catch(() => {});
						close(code, ignore, resolve, reject);
					})
				));

			} else {
				const script = cmds.map(ignore
					? cmd => `(${cmd}) || true`
					: cmd => `(${cmd}) || exit $?`
				).join('\n');

				await new Promise<number>((resolve, reject) => echo(
					child_process.spawn(script, [], spawnOpts)
					.on('error', err => reject(err))
					.on('close', code => close(code, ignore, resolve, reject))
				));
			}
		}
		
	} else {

		for (const i of recipe) {
			const c		= parseRecipeLine(i);
			const cmd	= (await exp.expand(c.cmd)).trim();

			if (opt.noSilent || !(c.silent || opt.silent))
				opt.output!(cmd + '\r\n');

			if (cmd && (opt.mode === 'normal' || c.force)) {
				const ignore = opt.ignoreErrors || c.ignore;
				await new Promise<number>((resolve, reject) => echo(
					child_process.spawn(cmd, [], spawnOpts)
					.on('error', err => reject(err))
					.on('close', code => close(code, ignore, resolve, reject))
				));
			}
		}
	}
}


//-----------------------------------------------------------------------------
// run
//-----------------------------------------------------------------------------

type PatternTable<T> = {re: RegExp, value: T}[];

interface Rule {
	targets?:		string[];	// for grouped
	prerequisites:	string[];
	orderOnly:		string[];
	recipe?:		string[];
	stem?:			string;
	all?:			boolean;
	terminal?:		boolean;
}

//Special Built-in Target Names
const specialTargetNames = [
	'PHONY',
//	'SUFFIXES',
//	'DEFAULT',
	'PRECIOUS',
	'INTERMEDIATE',
	'NOTINTERMEDIATE',
	'SECONDARY',
	'SECONDEXPANSION',
	'DELETE_ON_ERROR',
	'IGNORE',
	'LOW_RESOLUTION_TIME',
	'SILENT',
	'EXPORT_ALL_VARIABLES',
	'NOTPARALLEL',
	'ONESHELL',
	'POSIX'
];

const Universal = {
	size: Infinity,
	has(_: string) { return true; },
};

function prerequisiteSet(rule?: Rule) {
	return rule?.all ? Universal : new Set(rule?.prerequisites);
}

function mapSet<K, V>(map: Map<K, V>, k: K, v: V): V {
	map.set(k, v);
	return v;
}

function unique<T>(array: T[]) {
	return [...new Set(array)];
}

async function touchFile(abs: string) {
	await fs.promises.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
	await fs.promises.open(abs, 'a').then(f => f.close()).catch(() => {});
	await fs.promises.utimes(abs, new Date(), new Date()).catch(() => {});
}

export async function run(make: MakefileCore, goals: string[] = [], opt: RunOptions = {}): Promise<boolean> {
	opt = {
		mode: 'normal' as const,
		jobs: 1,
		output: () => {},
		...opt,
	};
	const cwd = make.CURDIR;

	const spawnOpts: child_process.SpawnOptions = {
		cwd,
		shell:		make.shell(),
		windowsHide: true,
	};

	const exactRules:		Record<string, Rule|Rule[]>	= {};
	const patternRules:		PatternTable<Rule>			= [];
	const anythingRules:	Rule[]						= [];
	const exactScopes:		Record<string, Variables>	= {};
	const patternScopes:	PatternTable<Variables>		= [];

	const knownTypes	= new Set<string>();
	const visited		= new Map<string, Promise<boolean>>();
	const semaphore		= new Semaphore(opt.jobs!);

	// Cache stat results for this run() pass
	const statCache = new Map<string, Promise<number>>();
	function modTime(file: string): Promise<number> {
		const abs = path.resolve(cwd, file);
		return statCache.get(abs) ?? mapSet(statCache, abs, getTimestamp(abs, opt.checkSymlink));
	}

	// Cache getPath results for this run() pass
	const pathCache = new Map<string, Promise<string>>();
	function getPathCheck(file: string) {
		return pathCache.get(file) ?? mapSet(pathCache, file, make.getPath(file));
	}
	function getPath(file: string) {
		return getPathCheck(file).then(f => f ?? file);
	}

	function clearCaches() {
		pathCache.clear();
		statCache.clear();
		opt.assumeNew?.forEach(f => getPath(f).then(f => statCache.set(f, Promise.resolve(Infinity))));
		opt.assumeOld?.forEach(f => getPath(f).then(f => statCache.set(f, Promise.resolve(1))));
	}

	function relative(filename?: string): string {
		return filename ? path.relative(cwd, filename) : '';
	}

	function addRule(targets: string[], prerequisites: string[], recipe?: string[], doubleColon?: boolean, grouped?: boolean) {
		const pipe		= prerequisites.indexOf('|');
		const orderOnly = pipe >= 0 ? prerequisites.slice(pipe + 1) : [];
		if (pipe >= 0)
			prerequisites.length = pipe;

		const rule: Rule = {prerequisites, orderOnly, recipe: recipe};
		const wild = targets.filter(t => t.includes('%'));

		//wild
		if (wild.length) {
			if (doubleColon)
				rule.terminal = true;

			if (wild.includes('%'))
				anythingRules.push(rule);

			const patterns = wild.filter(t => t !== '%');
			if (patterns.length) {
				patternRules.push({re: anchored(patterns.map(t => escapeRe(t).replace('%', '(.*?)')).join('|')), value: rule});
				patterns.forEach(t => knownTypes.add(t.replace('%', '')));
			}

		} else if (grouped) {
			// Record grouped explicit rules (no patterns) for coalescing
			rule.targets = targets;
		}

		// exact
		for (const t of targets.filter(t => !t.includes('%'))) {
			const dest = exactRules[t];
			if (doubleColon) {
				if (Array.isArray(dest))
					dest.push(rule);
				else
					exactRules[t] = [rule];
			} else {
				if (!dest || Array.isArray(dest)) {
					exactRules[t] = rule;
				} else {
					dest.prerequisites.push(...prerequisites);
					dest.orderOnly.push(...orderOnly);
					if (rule.recipe)
						dest.recipe = rule.recipe;
				}
				if (prerequisites.length == 0)
					(exactRules[t] as Rule).all = true;
			}
		}
	}

	async function prepareRules(rules: RuleEntry[], expander: Expander) {
		for (const r of rules) {
			const [targets, prerequisites] = await mapAsync([r.targets,  r.prerequisites], async s => toWords(await expander.expand(s)));
			addRule(targets, prerequisites, r.recipe, r.doubleColon, r.grouped);
		}
	}

	async function oughtExist(file: string) {
		return exactRules[file] || await getPathCheck(file);
	}

	function findRule(target: string): Rule | Rule[] | undefined {
		const exact = exactRules[target];
		if (exact && (Array.isArray(exact) || exact.recipe))
			return exact;

		const candidates: (Rule & { stem: string; intermediates?: string[] })[] = patternRules.filter(i => i.value.recipe && i.re.exec(target)).map(i => (
			{...i.value, stem: i.re.exec(target)!.slice(1).find(Boolean)!}
		));

		candidates.sort((a, b) => a.stem.length - b.stem.length);
		candidates.push(...anythingRules.filter(r => r.recipe).map(r => ({...r, stem: target})));

		for (const rule of candidates) {
			rule.intermediates = rule.prerequisites.filter(i => i.includes('%') && !oughtExist(i.replaceAll('%', rule.stem)));
			if (rule.intermediates.length === 0)
				return rule;
		}

		if (knownTypes.has(path.extname(target)))
			return;

		for (const rule of candidates) {
			if (!rule.terminal) {
				if (rule.intermediates!.reduce((ok, i) => ok && !!findRule(i.replaceAll('%', rule.stem)), true))
					return rule;
			}
		}
	}	

	function getRule(target: string): Rule | Rule[] {
		const prerequisites:	string[] = [];
		const orderOnly:		string[] = [];

		const fixPercent = (list: string[], stem: string) => list.map(t => t.replaceAll('%', stem));

		for (const i of patternRules) {
			const m = i.re.exec(target);
			if (m) {
				const stem = m.slice(1).find(Boolean)!;
				if (!i.value.recipe) {
					prerequisites.push(...fixPercent(i.value.prerequisites, stem));
					orderOnly.push(...fixPercent(i.value.orderOnly, stem));
				}
			}
		}

		const exact = exactRules[target];
		if (exact && !Array.isArray(exact) && !exact.recipe) {
			prerequisites.push(...exact.prerequisites);
			orderOnly.push(...exact.orderOnly);
		}

		const rule = findRule(target);
		if (rule) {
			if (Array.isArray(rule))
				return rule;
			
			const stem = rule.stem ?? '';
			prerequisites.push(...fixPercent(rule.prerequisites, stem));
			orderOnly.push(...fixPercent(rule.orderOnly, stem));
			return {
				prerequisites,
				orderOnly,
				recipe:	rule.recipe,
				stem,
			};
		} else {
			return {
				prerequisites,
				orderOnly,
				recipe:	(exactRules['.DEFAULT'] as Rule|undefined)?.recipe ?? [],
				stem:	'',
			};
		}
	}	

	function prepareScopes(scopes: [string, Variables][]) {
		for (const [key, scope] of scopes) {
			const keys = toWords(key);
			keys.filter(t => !t.includes('%')).forEach(t => exactScopes[t] = scope);

			if (key.includes('%'))
				patternScopes.push({re: anchored(keys.filter(t => t.includes('%')).map(t => escapeRe(t).replace('%', '.*?')).join('|')), value: scope});
		}
	}

	function getScope(target: string): Variables | undefined {
		const exact = exactScopes[target];
		if (exact)
			return exact;

		let bestvalue:	Variables | undefined;
		let beststem	= target;

		for (const i of patternScopes) {
			const m = i.re.exec(target);
			if (m) {
				const stem = m.slice(1).find(Boolean)!;
				if (stem.length < beststem.length) {
					bestvalue	= i.value;
					beststem 	= stem;
				}
			}
		}
		return bestvalue;
	}

	function buildTarget(target: string, parentScope: Expander): Promise<boolean> {
		if (opt.debug?.level && opt.output)
			opt.output('Build target ' + target + '\n');

		const mark = visited.get(target);
		if (mark)
			return mark;

		const scope	= parentScope.with(getScope(target));
		const rules	= getRule(target);

		if (Array.isArray(rules)) {
			return mapSet(visited, target, mapAsync(rules, async r => {
				if (r.targets) {
					//grouped
					const mark = visited.get(r.targets[0]);
					if (mark)
						return mark;
					const p = buildRule(r.targets[0], r, scope);
					for (const t of r.targets)
						visited.set(t, p);
					return p;
				} else {
					return buildRule(target, r, scope);
				}
			}).then(a => a.some(Boolean)));
		}

		if (rules.targets) {
			// grouped
			const mark = visited.get(rules.targets[0]);
			if (mark)
				return mark;
			const p = buildRule(rules.targets[0], rules, scope);
			for (const t of rules.targets)
				visited.set(t, p);
			return p;
		}

		return mapSet(visited, target, buildRule(target, rules, scope));
	}

	async function buildRule(target: string, r: Rule, scope: Expander): Promise<boolean> {
		if (opt.debug?.level && opt.output)
			opt.output('Run rule on ' + target + '\n');

		const extra	= scope.get('.EXTRA_PREREQS');
		if (extra)
			extra.priv = true;

		const scopeNoPriv	= scope.withoutPrivate();

		// First-pass expansion results from prepare()
        let _prerequisites	= r.prerequisites;
        let _orderOnly 		= r.orderOnly;

        // .SECONDEXPANSION: apply second pass over the first-pass words, with $@/$* set
        if (special.SECONDEXPANSION.has(target)) {
            const exp2 = scope.with({
                '@': { value: target,       origin: 'automatic' },
                '*': { value: r.stem ?? '', origin: 'automatic' },
            });
			_prerequisites	= toWords(await exp2.expand(fromWords(_prerequisites)));
			_orderOnly		= toWords(await exp2.expand(fromWords(_orderOnly)));
        }

        // Resolve to paths after choosing the expansion path
        const prerequisites = await mapAsync(_prerequisites, getPath);
        const orderOnly     = await mapAsync(_orderOnly, getPath);
		const extraPrereqs	= extra ? await mapAsync(toWords(extra.value), getPath) : [];
		const uniquePrereqs	= unique(prerequisites);

		// handle parallelism
		const stopOnRebuild = opt.mode === 'question';
		if (special.NOTPARALLEL.has(target)) {
			for (const i of uniquePrereqs) {
				if (i !== '.WAIT' && await buildTarget(i, scopeNoPriv) && stopOnRebuild)
					return true;
			}

		} else if (prerequisites.indexOf('.WAIT') >= 0) {
			let i = 0;
			let wait: number;
			while ((wait = prerequisites.indexOf('.WAIT', i)) >= 0) {
				if ((await mapAsync(prerequisites.slice(i, wait), pre => buildTarget(pre, scopeNoPriv))).some(Boolean) && stopOnRebuild)
					return true;
				i = wait + 1;
			}
			if ((await mapAsync(unique([...prerequisites.slice(i), ...extraPrereqs, ...orderOnly]), pre => buildTarget(pre, scopeNoPriv))).some(Boolean) && stopOnRebuild)
				return true;

		} else {
			if ((await mapAsync(unique([...uniquePrereqs, ...extraPrereqs, ...orderOnly]), pre => buildTarget(pre, scopeNoPriv))).some(Boolean) && stopOnRebuild)
				return true;
		}


		if (r.recipe) {
			const targets 		= r.targets ?? [target];
			const targetTimes	= await mapAsync(targets, async t => special.PHONY.has(t) ? 0 : await modTime(t));
			const mtime			= Math.min(...targetTimes);

			if (opt.always || !mtime || (await mapAsync(unique([...uniquePrereqs, ...extraPrereqs]), modTime)).some(t => t > mtime)) {
				const oldest = targetTimes.reduce((a, b) => a === 0 || b < a ? b : a, 0);
				const older	= oldest ? await mapAsync(uniquePrereqs, async p => await modTime(p) > oldest ? p : '') : uniquePrereqs;

				if (opt.mode === 'dry-run' || opt.mode === 'normal') {
					// Set automatic variables for make target
					const exp = scope.with({
						'@': {value: target, 								origin: 'automatic'},
						'<': {value: relative(uniquePrereqs[0]), 			origin: 'automatic'},
						'^': {value: fromWords(uniquePrereqs.map(relative)),origin: 'automatic'},
						'+': {value: fromWords(r.prerequisites),			origin: 'automatic'},
						'|': {value: fromWords(orderOnly.map(relative)), 	origin: 'automatic'},
						'?': {value: fromWords(older.map(relative)),		origin: 'automatic'},
						'*': {value: r.stem ?? '',							origin: 'automatic'},
					});

					const lock = await semaphore.acquire();
					try {
						await runRecipe(r.recipe, exp, {...opt,
							ignoreErrors:	opt.ignoreErrors || special.IGNORE.has(target),
							silent:			opt.silent || special.SILENT.has(target),
							oneshell:		opt.oneshell || special.ONESHELL.has(target),
						}, {
							...spawnOpts,
							env: {...process.env, ...scope.exports(exportAll) },
						});
						clearCaches();
  					
					} catch (err) {
						if (!opt.keepGoing) {
							// .DELETE_ON_ERROR: remove targets on failure unless PRECIOUS/SECONDARY
							if (special.DELETE_ON_ERROR.has(target) && !special.PRECIOUS.has(target) && !special.SECONDARY.has(target)) {
								await Promise.allSettled(
									targets.map(t => fs.promises.unlink(path.resolve(cwd, t)))
								);
							}
							throw err;
						}

					} finally {
						lock.release();
					}

				} else if (opt.mode === 'touch') {
					await Promise.all(targets.map(t => touchFile(path.resolve(cwd, t))));
				}
				return true;
			}
		}

		return false;
	}

	// main function

	await prepareRules(make.rules, make);
	prepareScopes(Object.entries(make.scopes));

	const special	= Object.fromEntries(specialTargetNames.map(name => [name, prerequisiteSet(exactRules['.' + name] as Rule)]));
	const exportAll = make.exportAll || special.EXPORT_ALL_VARIABLES.size > 0;

	const incResults = await mapAsync(make.deferredIncludes, inc => buildTarget(inc.file, make));
	if (incResults.some(Boolean)) {
		const numRules	= make.rules.length;
		const numScopes = Object.keys(make.scopes).length;
		await include(make, make.deferredIncludes.map(i => i.file));
		await prepareRules(make.rules.slice(numRules), make);			// in case new rules were added
		prepareScopes(Object.entries(make.scopes).slice(numScopes));	// in case new scopes were added
	}

	if (goals.length === 0)
		goals.push(make.DEFAULT_GOAL);

	return (await mapAsync(goals, g => getPath(g).then(g => buildTarget(g, make)))).some(Boolean);
}
