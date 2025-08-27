import { Makefile, RuleEntry } from './parse';
import { Variables, Expander, toWords, fromWords, anchored, escapeRe } from './variables';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';


export type ExecutionMode = 'normal' | 'dry-run' | 'question' | 'touch';

export interface ExecuteOptions {
	jobs?: number;
	mode?: ExecutionMode;
	ignoreErrors?: boolean;
	silent?: boolean;
	noSilent?: boolean;
	oneshell?: boolean;
	output?: (text: string) => void;
}

async function mapAsync<T, U>(arr: T[], fn: (arg: T) => Promise<U>): Promise<U[]> {
	return Promise.all(arr.map(fn));
}

function unique<T>(array: T[]) {
	return [...new Set(array)];
}

type PatternTable<T> = {re: RegExp, value: T}[];

interface Rule {
	targets?:		string[];	// for grouped
	prerequisites:	string[];
	orderOnly:		string[];
	recipe:			string[];
	stem?:			string;
	all?:			boolean;
}
//Special Built-in Target Names
const specialTargetNames = [
	'PHONY',
	'SUFFIXES',
	'DEFAULT',
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

class Rules {
	exactRules:		Record<string, Rule|Rule[]>	= {};
	patternRules:	PatternTable<Rule>			= [];
	exactScopes:	Record<string, Variables>	= {};
	patternScopes:	PatternTable<Variables>		= [];

	// get special targets
	specialTargets() {
		return Object.fromEntries(specialTargetNames.map(name => {
			const rule = this.exactRules['.' + name] as Rule|undefined;
			return [name, rule?.all ? Universal : new Set(rule?.prerequisites)];
		}));
	}

	async prepare(rules: RuleEntry[], scopes: Record<string, Variables>, expander: Expander) {
		this.exactRules		= {};
		this.patternRules	= [];
		this.exactScopes	= {};
		this.patternScopes	= [];

		for (const r of rules) {
			const [targets, prerequisites] = await mapAsync([r.targets,  r.prerequisites], async s => toWords(await expander.expand(s)));
			const pipe		= prerequisites.indexOf('|');
			const orderOnly = pipe >= 0 ? prerequisites.slice(pipe + 1) : [];
			if (pipe >= 0)
				prerequisites.length = pipe;

			const r2: Rule = {prerequisites, orderOnly, recipe: r.recipe};

			const wild = targets.filter(t => t.includes('%'));

			if (wild.length) {
				this.patternRules.push({re: anchored(wild.map(t => escapeRe(t).replace('%', '(.*?)')).join('|')), value: r2});

			} else if (r.grouped) {
				// Record grouped explicit rules (no patterns) for coalescing
				r2.targets = targets;
			}

			for (const t of targets) {
				if (!t.includes('%')) {
					const dest = this.exactRules[t];
					if (r.doubleColon) {
						if (Array.isArray(dest))
							dest.push(r2);
						else
							this.exactRules[t] = [r2];
					} else {
						if (!dest || Array.isArray(dest)) {
							this.exactRules[t] = r2;
						} else {
							dest.prerequisites.push(...prerequisites);
							dest.orderOnly.push(...orderOnly);
							if (r2.recipe.length > 0)
								dest.recipe = r2.recipe;
						}
						if (prerequisites.length == 0)
							(this.exactRules[t] as Rule).all = true;
					}
				}
			}
		}

		for (const [key, scope] of Object.entries(scopes)) {
			const keys = toWords(key);
			keys.filter(t => !t.includes('%')).forEach(t => this.exactScopes[t] = scope);

			if (key.includes('%'))
				this.patternScopes.push({re: anchored(keys.filter(t => t.includes('%')).map(t => escapeRe(t).replace('%', '.*?')).join('|')), value: scope});
		}

	}

	getRules(target: string): Rule | Rule[] {
		const prerequisites:	string[] = [];
		const orderOnly:		string[] = [];
		let bestrecipe:			Rule | undefined;
		let beststem			= target;

		const fixPercent = (list: string[], stem: string) => list.map(t => t.replaceAll('%', stem));

		for (const i of this.patternRules) {
			const m = i.re.exec(target);
			if (m) {
				const stem = m.slice(1).find(Boolean)!;
				if (i.value.recipe.length === 0) {
					prerequisites.push(...fixPercent(i.value.prerequisites, stem));
					orderOnly.push(...fixPercent(i.value.orderOnly, stem));
				} else if (stem.length < beststem.length) {
					bestrecipe	= i.value;
					beststem 	= stem;
				}
			}
		}
		if (bestrecipe) {
			bestrecipe = {
				prerequisites:	fixPercent(bestrecipe.prerequisites, beststem),
				orderOnly: 		fixPercent(bestrecipe.orderOnly, beststem),
				recipe:			bestrecipe.recipe,
				stem:			beststem,
			};
		}

		const exact = this.exactRules[target];
		if (exact) {
			if (Array.isArray(exact)) {
				return exact.map(r => ({
					prerequisites:	[...r.prerequisites, ...prerequisites],
					orderOnly:		[...new Set([...r.orderOnly, ...orderOnly])],
					recipe:			r.recipe,
					stem:			'',
				}));
			}
			if (exact.recipe.length === 0) {
				prerequisites.push(...exact.prerequisites);
				orderOnly.push(...exact.orderOnly);
			} else {
				bestrecipe = exact;
			}
		}

		if (bestrecipe) {
			return {
				prerequisites:	[...bestrecipe.prerequisites, ...prerequisites],
				orderOnly:		[...new Set([...bestrecipe.orderOnly, ...orderOnly])],
				recipe:			bestrecipe.recipe,
				stem:			beststem,
			};
		}

		return {
			prerequisites,
			orderOnly,
			recipe: (this.exactRules['.DEFAULT'] as Rule|undefined)?.recipe ?? [],
			stem: '',
		};
	}	

	getScope(target: string): Variables | undefined {
		const exact = this.exactScopes[target];
		if (exact)
			return exact;

		let bestvalue:	Variables | undefined;
		let beststem	= target;

		for (const i of this.patternScopes) {
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
}


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
// execute
//-----------------------------------------------------------------------------

const hasMAKERef = (s: string) => /\$\((?:MAKE)\)|\$\{(?:MAKE)\}/.test(s);

interface ExecuteOptions2 extends ExecuteOptions {
	oneshell?: boolean;
}


// Execute recipe lines
async function runRecipe(recipe: string[], exp: Expander, opt: ExecuteOptions2, spawnOpts: child_process.SpawnOptions): Promise<void> {
	function echo(child: child_process.ChildProcess) {
		child.stdout?.on('data', chunk => 
			opt.output!(chunk.toString()));
		child.stderr?.on('data', chunk => opt.output!(chunk.toString()));
	}
	function close(code: number|null, ignore: boolean, resolve: (value: number) => void, reject: (reason?: Error) => void) {
		if (code && !ignore)
			reject(new Error(`Command failed with exit code ${code}`));
		else
			resolve(0);
	}

	function parseRecipeLine(line: string) {
		const m = /^([-+@]*)(.*)/.exec(line)!;
		return {
			ignore: m[1].includes('-'),
			silent: m[1].includes('@'),
			force:	m[1].includes('+') || hasMAKERef(m[2]),
			cmd:	m[2]
		};
	}

	if (opt.oneshell && recipe.length > 1) {
		const first		= parseRecipeLine(recipe[0])!;
		const cmds 		= (await mapAsync([first.cmd, ...recipe.slice(1)], async raw => (await exp.expand(raw)).trim())).filter(Boolean);
		const ignore	= opt.ignoreErrors || first.ignore;

		if (opt.noSilent || !(first.silent || opt.silent)) {
			for (const i of cmds)
				opt.output!(i + '\r\n');
		}

		const map: (cmd: string)=>string = process.platform === 'win32'
			? (ignore ? cmd => `call ${cmd}`		: cmd => `call ${cmd} || exit /b %ERRORLEVEL%`)
			: (ignore ? cmd => `(${cmd}) || true`	: cmd => `(${cmd}) || exit $?`);

		const script = cmds.map(map).join(os.EOL);

		if (opt.mode === 'normal' || first.force || recipe.some(hasMAKERef)) {
			if (process.platform === 'win32') {
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

function mapSet<K, V>(map: Map<K, V>, k: K, v: V): V {
	map.set(k, v);
	return v;
}

async function touchFile(abs: string) {
	await fs.promises.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
	await fs.promises.open(abs, 'a').then(f => f.close()).catch(() => {});
	await fs.promises.utimes(abs, new Date(), new Date()).catch(() => {});
}

export async function execute(make: Makefile, goals: string[] = [], opt: ExecuteOptions = {}): Promise<boolean> {
	opt = {
		mode: 'normal' as const,
		jobs: 1,
		output: () => {},
		...opt,
	};
	const cwd = make.cwd();

	const spawnOpts: child_process.SpawnOptions = {
		cwd,
		shell:		make.shell(),
		windowsHide: true,
	};

	const ruler		= new Rules;
	await ruler.prepare(make.rules, make.scopes, make);
	const special	= ruler.specialTargets();
	const exportAll = make.exportAll || special.EXPORT_ALL_VARIABLES.size > 0;

	// Cache stat results for this execute() pass
	const statCache = new Map<string, Promise<number>>();
	async function statCached(abs: string): Promise<number> {
		return statCache.get(abs) ?? mapSet(statCache, abs, fs.promises.stat(abs).then(s => s.mtimeMs).catch(() => 0));
	}
	function clearStatCache() {
		statCache.clear();
	}
    async function modTime2(p: string): Promise<number> {
		return statCached(path.resolve(cwd, p));
    }

	// Cache getPath results for this execute() pass
	const pathCache = new Map<string, Promise<string>>();
	function getPath(file: string) {
		return pathCache.get(file) ?? mapSet(pathCache, file, make.getPath(file));
	}
	function clearPathCache() {
		pathCache.clear();
	}

	function relative(filename?: string): string {
		return filename ? path.relative(cwd, filename) : '';
	}

	const visited = new Map<string, Promise<boolean>>();
	const semaphore = new Semaphore(opt.jobs!);


	function buildTarget(target: string, parentScope: Expander): Promise<boolean> {
		const mark = visited.get(target);
		if (mark)
			return mark;

		const scope	= parentScope.with(ruler.getScope(target));
		const rules	= ruler.getRules(target);

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
		const extra	= scope.get('.EXTRA_PREREQS');
		if (extra)
			extra.priv = true;

		const scopeNoPriv	= scope.withoutPrivate();

		// First-pass expansion results from prepare()
        let wordsP = r.prerequisites;
        let wordsO = r.orderOnly;

        // .SECONDEXPANSION: apply second pass over the first-pass words, with $@/$* set
        if (special.SECONDEXPANSION.has(target)) {
            const exp2 = scope.with({
                '@': { value: target,       origin: 'automatic' },
                '*': { value: r.stem ?? '', origin: 'automatic' },
            });
			wordsP = toWords(await exp2.expand(fromWords(wordsP)));
			wordsO = toWords(await exp2.expand(fromWords(wordsO)));
        }

        // Resolve to paths after choosing the expansion path
        const prerequisites = await mapAsync(wordsP, getPath);
        const orderOnly     = await mapAsync(wordsO, getPath);
		const extraPrereqs	= extra ? await mapAsync(toWords(extra.value), getPath) : [];
		const uniquePrereqs	= unique(prerequisites);

		const stopOnRebuild = opt.mode === 'question';
		if (special.NOTPARALLEL.has(target)) {
			for (const i of uniquePrereqs) {
				if (await buildTarget(i, scopeNoPriv) && stopOnRebuild)
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


		if (r.recipe.length) {
			const targets 		= r.targets ?? [target];
			const targetTimes	= await mapAsync(targets, async t => special.PHONY.has(t) ? 0 : await modTime2(t));
			const mtime			= Math.min(...targetTimes);

			if (!mtime || (await mapAsync(unique([...uniquePrereqs, ...extraPrereqs]), modTime2)).some(t => t > mtime)) {
				const oldest = targetTimes.reduce((a, b) => a === 0 || b < a ? b : a, 0);
				const older	= oldest ? await mapAsync(uniquePrereqs, async p => await modTime2(p) > oldest ? p : '') : uniquePrereqs;

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
						clearStatCache();
						clearPathCache();
  					
					} catch (err) {
                        // .DELETE_ON_ERROR: remove targets on failure unless PRECIOUS/SECONDARY
                        if (special.DELETE_ON_ERROR.has(target) && !special.PRECIOUS.has(target) && !special.SECONDARY.has(target)) {
                            await Promise.allSettled(
                                targets.map(t => fs.promises.unlink(path.resolve(cwd, t)))
                            );
                        }
                        throw err;

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

	const incResults = await mapAsync(make.deferredIncludes, inc => buildTarget(inc.file, make));
	if (incResults.some(Boolean)) {
		await make.include(make.deferredIncludes.map(i => i.file));
		ruler.prepare(make.rules, make.scopes, make); // in case new rules were added
	}

	if (goals.length === 0)
		goals.push(make.get('.DEFAULT_GOAL')!.value);

	return (await mapAsync(goals, g => make.getPath(g).then(g => buildTarget(g, make)))).some(Boolean);
}
