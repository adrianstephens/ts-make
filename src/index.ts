import { MakefileCore, Function, VariableValue, RuleEntry, fromWords, toWords, defaultFunctions, anchored} from "./core";
import { RunOptions, run } from "./run";
import { parse } from "./parse";
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export { RuleEntry, VariableValue, getEnvironmentVariables, makeWordFunction, fromWords, toWords, defaultFunctions } from "./core";
export { RunOptions } from "./run";

//import { cli } from "./cli";
//export { cli, builtinRules, builtinVariables } from "./cli";

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
//MAKELEVEL					The number of levels of recursion (sub-makes).
//MAKEFLAGS			c		The flags given to make. You can set this in the environment or a makefile to set flags.
//GNUMAKEFLAGS				Other flags parsed by make. You can set this in the environment or a makefile to set make command-line flags. GNU make never sets this variable itself.
//MAKECMDGOALS		c		The targets given to make on the command line. Setting this variable has no effect on the operation of make.
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

export interface CreateOptions {
	variables?:		Record<string, VariableValue>;
	functions?:		Record<string, Function>;
	rules?:			RuleEntry[];
	includeDirs?:	string[];
	envOverrides?:	boolean;
	warnUndef?: 	boolean;
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
		return parse(this, text, file);
	}

	run(goals: string[] = [], options?: RunOptions): Promise<boolean> {
		return run(this, goals, options);
	}

	static async parse(text: string, options?: CreateOptions): Promise<Makefile> {
		const m	= new Makefile(options);
		await parse(m, text, '');
		return m;
	}

	static async load(filePath: string, options?: CreateOptions): Promise<Makefile> {
		try {
			const text = await fs.promises.readFile(filePath, 'utf8');
			return await this.parse(text, { ...options,
				variables: {...options?.variables,
					CURDIR: 		{ value: path.dirname(path.resolve(process.cwd(), filePath)) },
					MAKEFILE_LIST:	{ value: filePath },
				}
			});
		} catch (error: any) {
			throw new Error(`${error.message} in ${filePath}`, error.options);
		}
	}
}
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

defaultFunctions.wildcard = async (exp, pattern: string) => {
	const cwd	= exp.get('CURDIR')!.value;
	const files = await Promise.all(toWords(pattern).map(async i => {
		const pattern = path.resolve(cwd, i);
		return i.includes('*') || i.includes('?')
			? await getDirs(path.dirname(pattern), globRe(path.basename(pattern)))
			: pattern;
	}));
	return fromWords([...new Set(files.flat())]); // Remove duplicates
};


//-----------------------------------------------------------------------------
// Auto-invoke CLI if run directly from command line
//-----------------------------------------------------------------------------

if (require.main === module) {
	import('./cli')
		.then(module => module.cli(process.argv))
		.then(code => process.exit(code))
		.catch(error => {
			if (error.code === 'MODULE_NOT_FOUND') {
				console.error('CLI not available in this build');
				process.exit(1);
			} else {
				console.error('CLI error:', error.message);
				process.exit(1);
			}
		});
}
