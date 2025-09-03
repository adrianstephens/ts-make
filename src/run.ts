import { MakefileCore, RuleEntry, Variables, Expander, toWords, fromWords, anchored, escapeRe } from './core';

export interface Lock {
	release(): void;
}

export interface RunDebug {
	level?: 		number;
	implicit?: 		boolean;
	jobs?: 			boolean;
	makefile?: 		boolean;
	recipe?: 		boolean;
	why?: 			boolean;
};

export interface RecipeOptions {
	ignoreErrors?: 	boolean;
	silent?: 		boolean;
	noSilent?: 		boolean;
	oneshell?: 		boolean;
}

//passed through
export interface RunOptionsShared extends RecipeOptions {
	always?: 		boolean;
	keepGoing?: 	boolean;
	assumeOld?: 	string[];
	assumeNew?: 	string[];
	debug?: 		RunDebug;	//unimplemented
}

export interface RunOptionsDirect extends RunOptionsShared {
	runRecipe:		(recipe: string[], targets: string[], exp: Expander, opt: RecipeOptions) => Promise<void>;
	timestamp:		(file: string) => Promise<number>;
	deleteFile:		(file: string) => Promise<void>;
	includeFiles:	(files: string[]) => Promise<string[]>;
	getPath:		(target: string) => Promise<string | undefined>;
	rearrange:		(prerequisites: string[]) => string[];
	jobServer:		() => Promise<Lock>;
	stopOnRebuild:	boolean;
}

async function mapAsync<T, U>(arr: T[], fn: (arg: T) => Promise<U>): Promise<U[]> {
	return Promise.all(arr.map(fn));
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
//	'EXPORT_ALL_VARIABLES',
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


export async function run(make: MakefileCore, goals: string[], opt: RunOptionsDirect): Promise<boolean> {
	const exactRules:		Record<string, Rule|Rule[]>	= {};
	const patternRules:		PatternTable<Rule>			= [];
	const anythingRules:	Rule[]						= [];
	const exactScopes:		Record<string, Variables>	= {};
	const patternScopes:	PatternTable<Variables>		= [];

	const knownTypes	= new Set<string>();
	const visited		= new Map<string, Promise<boolean>>();

	// Cache stat results for this run() pass
	const statCache = new Map<string, Promise<number>>();
	function modTime(file: string): Promise<number> {
		return statCache.get(file) ?? mapSet(statCache, file, opt.timestamp!(file));
	}

	// Cache getPath results for this run() pass
	const pathCache = new Map<string, Promise<string>>();
	function getPathCheck(file: string) {
		return pathCache.get(file) ?? mapSet(pathCache, file, opt.getPath(file));
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

		const type = target.lastIndexOf('.') < target.length ? target.slice(target.lastIndexOf('.') + 1) : '';
		if (knownTypes.has(type))
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
		//if (opt.debug?.level)
		//	opt.output('Build target ' + target + '\n');

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
		//if (opt.debug?.level)
		//	opt.output('Run rule on ' + target + '\n');

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
		const uniquePrereqs	= opt.rearrange(unique(prerequisites));

		// handle parallelism
		const stopOnRebuild = opt.stopOnRebuild;
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
				if (stopOnRebuild)
					return true;

				const oldest = targetTimes.reduce((a, b) => a === 0 || b < a ? b : a, 0);
				const older	= oldest ? await mapAsync(uniquePrereqs, async p => await modTime(p) > oldest ? p : '') : uniquePrereqs;

				// Set automatic variables for make target
				const exp = scope.with({
					'@': {value: target, 						origin: 'automatic'},
					'<': {value: uniquePrereqs[0], 				origin: 'automatic'},
					'^': {value: fromWords(uniquePrereqs),		origin: 'automatic'},
					'+': {value: fromWords(r.prerequisites),	origin: 'automatic'},
					'|': {value: fromWords(orderOnly), 			origin: 'automatic'},
					'?': {value: fromWords(older),				origin: 'automatic'},
					'*': {value: r.stem ?? '',					origin: 'automatic'},
				});
				const lock = await opt.jobServer();
				try {
					await opt.runRecipe(r.recipe, targets, exp, {
						noSilent:		opt.noSilent ?? false,
						ignoreErrors:	opt.ignoreErrors || special.IGNORE.has(target),
						silent:			opt.silent || special.SILENT.has(target),
						oneshell:		opt.oneshell || special.ONESHELL.has(target),
					});
					clearCaches();
				
				} catch (err) {
					if (!opt.keepGoing) {
						// .DELETE_ON_ERROR: remove targets on failure unless PRECIOUS/SECONDARY
						if (special.DELETE_ON_ERROR.has(target) && !special.PRECIOUS.has(target) && !special.SECONDARY.has(target)) {
							await Promise.allSettled(
								targets.map(t => opt.deleteFile(t))
							);
						}
						throw err;
					}

				} finally {
					lock.release();
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

	const incResults = await mapAsync(make.deferredIncludes, inc => buildTarget(inc.include, make));
	if (incResults.some(Boolean)) {
		const numRules	= make.rules.length;
		const numScopes = Object.keys(make.scopes).length;
		await opt.includeFiles(make.deferredIncludes.map(i => i.include));
		await prepareRules(make.rules.slice(numRules), make);			// in case new rules were added
		prepareScopes(Object.entries(make.scopes).slice(numScopes));	// in case new scopes were added
	}

	return (await mapAsync(goals, g => getPath(g).then(g => buildTarget(g, make)))).some(Boolean);
}
