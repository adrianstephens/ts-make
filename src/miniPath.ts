export interface ParsedPath {
	root:	string;
	dir:	string;
	base:	string;
	name:	string;
	ext:	string;
}

export const sep	= process.platform === 'win32' ? '\\' : '/';

const fix = process.platform === 'win32'
	? (path: string) => path.replace(/\//g, '\\')
	: (path: string) => path;

const rootName = process.platform === 'win32'
	? (path: string) => {
		const m = /^(?:\\\\\w+\\\w+)|(?:[a-zA-Z]:)?\\?/.exec(path);
		return m ? m[0] : '';
	}
	: (path:string) => path[0] === sep ? sep : '';

function _normalize(path: string, sep: string): string {
	const parts = path.split(sep).filter(i => i && i !== '.');
	const newParts: string[] = [];
	let up = 0;
	for (const part of parts) {
		if (part === '..') {
			if (newParts.length === 0)
				++up;
			else
				newParts.pop();
		} else {
			newParts.push(part);
		}
	}
	return `..${sep}`.repeat(up) + newParts.join(sep);
}

export function normalize(path: string): string {
	return _normalize(fix(path), sep);
}

const reAbs = process.platform === 'win32' ? /^(?:[a-zA-Z]:)?[\\/]/ : /^[/]/;

export function isAbsolute(path: string): boolean {
	return reAbs.test(path);
}

export function join(...paths: string[]): string {
	return _normalize(paths.map(i => {
		i = fix(i);
		while (i.startsWith(sep))
			i = i.slice(1);
		while (i.endsWith(sep))
			i = i.slice(-1);
		return i;
	}).filter(Boolean).join(sep), sep);
}

export function resolve(...paths: string[]): string {
	if (paths.length && !isAbsolute(paths[0]))
		return join(process.cwd(), ...paths);
	return join(...paths);
}

export function relative(from: string, to: string): string {
	from	= fix(from);
	to		= fix(to);

	if (from === to)
		return '';
	
	const fromParts = from.split(sep).filter(i => i && i !== '.');
	const toParts	= to.split(sep).filter(i => i && i !== '.');
	
	let i = 0;
	while (fromParts[i] === toParts[i])
		++i;

	if (i === 0)
		return to;
	return `..${sep}`.repeat(fromParts.length - i) + toParts.slice(i).join(sep);
}

export function dirname(path: string): string {
	path = fix(path);
	const i = path.lastIndexOf(sep);
	return i === -1 ? '.' : i === 0 ? sep : path.slice(0, i);
}

export function basename(path: string, ext?: string): string {
	path = fix(path);
	const base = path.slice(path.lastIndexOf(sep) + 1);
	return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export function extname(path: string): string {
	const base = basename(path);
	const i = base.lastIndexOf('.');
	return i > 0 ? path.slice(i) : '';
}

export function parse(path: string): ParsedPath {
	path = fix(path);

	const root	= rootName(path);
	const i		= path.lastIndexOf(sep);
	const base	= path.slice(i + 1);
	const dot	= base.lastIndexOf('.');
	
	return {
		dir:	i === -1 ? '.' : path.slice(0, i),
		root,
		base,
		name:	dot > 0 ? base.slice(0, dot) : base,
		ext:	dot > 0 ? base.slice(dot) : ''
	};
}

function formatBase(name?: string, ext?: string) {
	return (name || '') + (ext ? (ext[0] === '.' ? ext : '.' + ext) : '');
}

export function format(parsed: Partial<ParsedPath>) {
	const dir = parsed.dir || parsed.root;
	const base = parsed.base || formatBase(parsed.name, parsed.ext);
	return !dir ? base : dir === parsed.root ? `${dir}${base}` : `${dir}${sep}${base}`;
}
