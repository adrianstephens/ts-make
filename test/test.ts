import {Makefile} from '../src/index';

export interface equal<T> {
	equal(b: T): boolean;
}

export function expect<T extends equal<T>>(v: T) {
	return {
		toEqual(v2: T) {
			if (!v.equal(v2))
				console.log("fail");
		}
	};
}

export function test(name: string, fn: ()=>void) {
	console.log("testing: " + name);
	fn();
	console.log("finished: " + name);
}

//test('make', () => {
//}

Makefile.load('test.mak').then(async m => {
	const output = process.stdout.write.bind(process.stdout);
//	for (const r of m.rules)
//		output(r);

	await m.run(['clean'], {noSilent: true, output});
	await m.run(['all'], {noSilent: true, output});
	m.RECIPEPREFIX = '>';
	output("done");
});