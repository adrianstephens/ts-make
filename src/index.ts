import { MakefileCore, Function, VariableValue, RuleEntry, Expander,
	defaultFunctions, makeWordFunction, fromWords, toWords, applyWords, applyWordsAsync, anchored
} from "./core";
import { Lock, RunOptionsShared, RecipeOptions, RunOptionsDirect, run } from "./run";
import { parse } from "./parse";

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export { RuleEntry, VariableValue, defaultFunctions, makeWordFunction, fromWords, toWords } from "./core";


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
//MAKE				c		The name with which make was invoked. Using this variable in recipes has special meaning. 
//MAKE_VERSION		x		The built-in variable ‘MAKE_VERSION’ expands to the version number of the GNU make program.
//MAKE_HOST			x		The built-in variable ‘MAKE_HOST’ expands to a string representing the host that GNU make was built to run on.
//MAKELEVEL			c		The number of levels of recursion (sub-makes).
//MAKEFLAGS			c		The flags given to make. You can set this in the environment or a makefile to set flags.
//GNUMAKEFLAGS				Other flags parsed by make. You can set this in the environment or a makefile to set make command-line flags. GNU make never sets this variable itself.
//MAKECMDGOALS		c		The targets given to make on the command line. Setting this variable has no effect on the operation of make.
//CURDIR			x		Set to the absolute pathname of the current working directory (after all -C options are processed, if any). Setting this variable has no effect on the operation of make.
//SUFFIXES			x		The default list of suffixes before make reads any makefiles.
//.LIBPATTERNS				Defines the naming of the libraries make searches for, and their order.

//Other Special Variables
//--------------------------
//MAKEFILE_LIST		x		Contains the name of each makefile that is parsed by make, in the order in which it was parsed
//.DEFAULT_GOAL		x		Sets the default goal to be used if no targets were specified on the command line
//MAKE_RESTARTS				This variable is set only if this instance of make has restarted (see How Makefiles Are Remade): it will contain the number of times this instance has restarted
//MAKE_TERMOUT	
//MAKE_TERMERR				When make starts it will check whether stdout and stderr will show their output on a terminal. If so, it will set MAKE_TERMOUT and MAKE_TERMERR, respectively, to the name of the terminal device (or true if this cannot be determined)
//.RECIPEPREFIX		x		The first character of the value of this variable is used as the character make assumes is introducing a recipe line
//.VARIABLES		x		Expands to a list of the names of all global variables defined so far
//.FEATURES			x		Expands to a list of special features supported by this version of make
//.INCLUDE_DIRS		x		Expands to a list of directories that make searches for included makefiles
//.EXTRA_PREREQS	x		Each word in this variable is a new prerequisite which is added to targets for which it is set. These prerequisites do not appear in any of the automatic variables, allowing prerequisites to be defined which do not impact the recipe

//Features	
//--------------------------
//archives					Supports ar (archive) files using special file name syntax
//check-symlink		x		Supports the -L (--check-symlink-times) flag
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


//-----------------------------------------------------------------------------
// Semaphore
//-----------------------------------------------------------------------------

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
// helpers
//-----------------------------------------------------------------------------

class SeededRNG {
	constructor(private seed: number) {}

	next(): number {
		this.seed = (this.seed * 1664525 + 1013904223) % (2 ** 32);
		return this.seed / (2 ** 32);
	}
}

async function touchFile(abs: string) {
	await fs.promises.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
	await fs.promises.open(abs, 'a').then(f => f.close()).catch(() => {});
	await fs.promises.utimes(abs, new Date(), new Date()).catch(() => {});
}

async function timeStampSymlink(file: string) {
	try {
		const lstat = await fs.promises.lstat(file);
		return !lstat.isSymbolicLink()
			? lstat.mtimeMs
			: Math.max(lstat.mtimeMs, (await fs.promises.stat(file)).mtimeMs);
	} catch {
		return 0;
	}
}

async function timeStamp(file: string) {
	try {
		return (await fs.promises.stat(file)).mtimeMs;
	} catch {
		return 0;
	}
}

function deleteFile(file: string) {
	return fs.promises.unlink(file);
}

function shuffle<T>(array: T[], rng: SeededRNG): T[] {
	for (let i = array.length; i--; ) {
		const j = Math.floor(rng.next() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array;
}

async function mapAsync<T, U>(arr: T[], fn: (arg: T) => Promise<U>): Promise<U[]> {
	return Promise.all(arr.map(fn));
}


function globRe(glob: string) {
	return anchored(glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex chars except * and ?
		.replace(/\*/g, '[^/]*') // * matches any chars except dir separator
		.replace(/\*\*/g, '.*') // ** matches any chars
		.replace(/\?/g, '.') // ? matches single char
	);
}

async function searchPath(target: string, paths: string[], cwd: string): Promise<string | undefined> {
	if (path.isAbsolute(target))
		return fs.promises.access(target).then(() => target).catch(() => undefined);

	const promises = paths.map(i => {
		const fullpath = path.resolve(cwd, i, target);
		return fs.promises.access(fullpath).then(() => fullpath).catch(() => undefined);
	});

	for (const p of promises) {
		const result = await p;
		if (result)
			return path.relative(cwd, result);
	}
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

// Functions for File Names
Object.assign(defaultFunctions, {
	dir:		makeWordFunction((name: string) => 			path.dirname(name)),
	notdir:		makeWordFunction((name: string) => 			path.basename(name)),
	suffix:		makeWordFunction((name: string) => 			path.extname(name)),
	basename:	makeWordFunction((name: string) => 			path.format({...path.parse(name), base: '', ext: ''})),
	realpath: (exp, names: string) => {
		const cwd		= exp.get('CURDIR')!.value;
		const realpath	= (n: string) => fs.promises.realpath(n).catch(() => n);
		return applyWordsAsync(names, async name => realpath(path.resolve(cwd, name)));
	},
	abspath: (exp, names: string) => {
		const cwd	= exp.get('CURDIR')!.value;
		return applyWords(names, name => path.resolve(cwd, name));
	},
	
	wildcard: async (exp, pattern: string) => {
		const cwd	= exp.get('CURDIR')!.value;
		const files = await Promise.all(toWords(pattern).map(async i => {
			const pattern = path.resolve(cwd, i);
			return i.includes('*') || i.includes('?')
				? await getDirs(path.dirname(pattern), globRe(path.basename(pattern)))
				: pattern;
		}));
		return fromWords([...new Set(files.flat())]); // Remove duplicates
	},

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

} as Record<string, Function>);

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
async function runRecipe(recipe: string[], exp: Expander, opt: RecipeOptions,
	dryRun: boolean,
	output:		(text: string) => void,
	lineflush: () => void,
	spawnOpts: child_process.SpawnOptions
): Promise<void> {
	
	function echo(child: child_process.ChildProcess) {
		child.stdout?.on('data', chunk => output(chunk.toString()));
		child.stderr?.on('data', chunk => output(chunk.toString()));
	}

	if (opt.oneshell && recipe.length > 1) {
		const first		= parseRecipeLine(recipe[0])!;
		const cmds 		= (await mapAsync([first.cmd, ...recipe.slice(1)], async raw => (await exp.expand(raw)).trim())).filter(Boolean);
		const ignore	= opt.ignoreErrors || first.ignore;

		if (opt.noSilent || !(first.silent || opt.silent)) {
			for (const i of cmds)
				output(i + '\r\n');
		}

		if (!dryRun || first.force || recipe.some(r => reHasMAKE.test(r))) {
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
				lineflush();
			}
		}
		
	} else {

		for (const i of recipe) {
			const c		= parseRecipeLine(i);
			const cmd	= (await exp.expand(c.cmd)).trim();

			if (opt.noSilent || !(c.silent || opt.silent))
				output(cmd + '\r\n');

			if (cmd && (!dryRun || c.force)) {
				const ignore = opt.ignoreErrors || c.ignore;
				await new Promise<number>((resolve, reject) => echo(
					child_process.spawn(cmd, [], spawnOpts)
					.on('error', err => reject(err))
					.on('close', code => close(code, ignore, resolve, reject))
				));
				lineflush();
			}
		}
	}
}


//-----------------------------------------------------------------------------
// Makefile
//-----------------------------------------------------------------------------

export interface CreateOptions {
	variables?:		Record<string, VariableValue>;
	functions?:		Record<string, Function>;
	rules?:			RuleEntry[];
	includeDirs?:	string[];
	envOverrides?:	boolean;
	warnUndef?: 	boolean;
}

export type RunMode = 'normal' | 'dry-run' | 'question' | 'touch';

export interface RunOptions extends RunOptionsShared {
	output?:		(text: string) => void;
	jobs?: 			number;
	maxLoad?:		number;
	mode?: 			RunMode;
	checkSymlink?:	boolean;
	shuffle?: 		'reverse' | number;
	outputSync?: 	'target' | 'line' | 'recurse';
}

export class Makefile extends MakefileCore {
	constructor(options?: CreateOptions) {
		super(
			{
				SHELL: 			{ value: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'},
				MAKESHELL: 		{ value: process.env.COMSPEC || 'cmd.exe' },
				MAKE_VERSION: 	{ value: '1.0'},
				MAKE_HOST: 		{ value: process.platform },
				...options?.variables
			},
			{
				eval:	(_exp, commands: string) => this.parse(commands).then(() => ''),
				shell:	async (_exp, command: string) => new Promise<string>((resolve, reject) => child_process.exec(command, {
					cwd:		this.CURDIR,
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
				),
				...options?.functions,
			},
			options?.rules ?? [],
			options?.includeDirs ?? ['.'],
			options?.warnUndef ?? false,
			options?.envOverrides ?? false
		);
	}

	setFunction(name: string, fn: Function) {
		this.functions[name] = fn;
	}

	parse(text: string, file = ''): Promise<void> {
		return parse(this, text, file, this.includeFiles.bind(this));
	}

	async run(goals: string[] = [], options?: RunOptions): Promise<boolean> {
		const buffer: string[] = [];
		const output	= options?.output || (_text => {});
		const flush		= () => { output(buffer.join('')); buffer.length = 0; };
		const cwd		= this.CURDIR;
		const semaphore	= new Semaphore(options?.jobs ?? 1);
		const rng		= new SeededRNG(typeof options?.shuffle === 'number' ? options.shuffle : 123456);

		if (goals.length === 0)
			goals.push(this.DEFAULT_GOAL);

		const r = await run(this, goals, {
			runRecipe:		options?.mode === 'touch'
				? (recipe, targets, _exp, _opt) => mapAsync(targets, t => touchFile(path.resolve(cwd, t))).then(() => {})
				: (recipe, targets, exp, opt) => runRecipe(
					recipe, exp, opt,
					options?.mode === 'dry-run',
					options?.outputSync ? text => buffer.push(text) : output,
					options?.outputSync === 'line' ? flush : () => {},
					{
						cwd,
						shell:		this.shell(),
						env: 		{...process.env, ...exp.exports(this.exportAll) },
						windowsHide: true,
					}
				).then(options?.outputSync === 'target' ? flush : () => {}),

			timestamp:		options?.checkSymlink
				? file => timeStampSymlink(path.resolve(cwd, file))
				: file => timeStamp(path.resolve(cwd, file)),

			deleteFile: 	file => deleteFile(path.resolve(cwd, file)),
			includeFiles:	this.includeFiles.bind(this),
			getPath:		this.getPath.bind(this),

			rearrange: !options?.shuffle
				? prerequisites => prerequisites
				: options.shuffle==='reverse'
				? prerequisites => prerequisites.reverse()
				: prerequisites => shuffle(prerequisites, rng),

			jobServer:		() => semaphore.acquire(),

			stopOnRebuild:	options?.mode === 'question',

			...options,
		});
		flush();
		return r;
	}

	async runDirect(goals: string[] = [], options: Partial<RunOptionsDirect>): Promise<boolean> {
		const cwd		= this.CURDIR;
		return await run(this, goals, {
			runRecipe:		(recipe, targets, exp, opt) => runRecipe(recipe, exp, opt, false, _text=>{}, ()=>{}, {
				cwd,
				shell:		this.shell(),
				env: 		{...process.env, ...exp.exports(this.exportAll) },
				windowsHide: true,
			}),
			timestamp:		file => timeStamp(path.resolve(cwd, file)),
			deleteFile: 	file => deleteFile(path.resolve(cwd, file)),
			includeFiles:	this.includeFiles.bind(this),
			getPath:		this.getPath.bind(this),
			rearrange:		prerequisites => prerequisites,
			jobServer:		() => Promise.resolve({release() {}}),
			stopOnRebuild:	false,
			...options
		});
	}

	async getPath(file: string) {
		if (!path.isAbsolute(file)) {
			const cwd = this.CURDIR;
			for (const i of Object.values(this.vpath)) {
				const m = i.re.exec(file);
				if (m) {
					const result = await searchPath(file, i.paths, cwd);
					if (result)
						return result;
				}
			}
			return await searchPath(file, this.vpathAll, cwd);
		}
	}

	async includeFiles(files: string[]): Promise<string[]> {
		const cwd		= this.CURDIR;
		const promises	= files.map(async file => {
			const filepath = await searchPath(file, this.includeDirs, cwd);
			return filepath
				? { file: filepath, promise: fs.promises.readFile(path.resolve(cwd, filepath), 'utf8') }
				: { file };
		});
		
		const failed: string[] = [];
	
		for (const i of promises) {
			const { file, promise } = await i;
			if (!promise) {
				failed.push(file);
			} else {
				const text = await promise;
				try {
					await this.setVariable('MAKEFILE_LIST', '+', file, 'file');
					await this.parse(text, file);
				} catch (error: any) {
					throw new Error(`${error.message} in included ${file}`, error.options);
				}
			}
		}
		return failed;
	}

	shell() {
		return (process.platform === 'win32' && this.get('MAKESHELL')?.value) || this.get('SHELL')?.value;
	}

	static async parse(text: string, options?: CreateOptions): Promise<Makefile> {
		const m	= new Makefile(options);
		await m.parse(text, '');
		return m;
	}

	static async load(filePath: string, options?: CreateOptions): Promise<Makefile> {
		try {
			const text = await fs.promises.readFile(filePath, 'utf8');
			return await this.parse(text, { ...options,
				variables: {
					...(options?.variables ?? environmentVariables()),
					CURDIR: 		{ value: path.dirname(path.resolve(process.cwd(), filePath)) },
					MAKEFILE_LIST:	{ value: filePath },
				}
			});
		} catch (error: any) {
			throw new Error(`${error.message} in ${filePath}`, error.options);
		}
	}
}

// fix windows vars like ProgramFiles(x86)
function fix_name(input: string): string {
	return input.replace(/[():]/g, '^$&');
}

export function environmentVariables(): Record<string, VariableValue> {
	const env: Record<string, VariableValue> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined)
			env[fix_name(k)] = {value: v, origin: 'environment'};
	}
	return env;
}
