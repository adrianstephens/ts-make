// generate-links.js
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

// Extract types from all .ts files in a directory
function extractAllTypes(distDir: string) {
	const types = new Map();
	const files = fs.readdirSync(distDir).filter(f => f.endsWith('.ts'));
	
	for (const file of files) {
		const filePath = path.join(distDir, file);
		const source = fs.readFileSync(filePath, 'utf8');
		const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest);

		function visit(node: ts.Node) {
			if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) {
				const hasExportModifier = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword);
				if (hasExportModifier) {
					const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
					types.set(node.name?.text, `${distDir}/${file}#L${line}`);
				}
			}
			ts.forEachChild(node, visit);
		}

		visit(sourceFile);
	}
	return types;
}

function removeLinks(readme: string) {
	// Remove existing links to avoid duplicates
	return readme.replace(/(`?)\[`(.*?)`\]\((.*?)\)(`?)/g, (match, q1, typeName, _link, _q2) => {
		return q1 ? typeName : `\`${typeName}\``;
	});
}

function addLinks(readme: string, types: Map<string, string>) {
	const baseUrl = 'https://github.com/adrianstephens/ts-make/blob/HEAD/';
	const used = new Set<string>();
	
	// Add links for type names and collect references
	readme = readme.replace(/`[^`\n]+`/g, (match) => {
		match = match.replace(/([A-Za-z][A-Za-z0-9_]*)/g, (match, typeName) => {
			if (types.has(typeName)) {
				used.add(typeName);
				return `\`[\`${typeName}\`][${typeName}]\``;
			}
			return match;
		});
		if (match.startsWith('``'))
			match = match.slice(2);
		if (match.endsWith('``'))
			match = match.slice(0, -2);

		return match;
	});
	
	// Add references at the end
	if (used.size) {
		readme += '\n\n<!-- Type References -->\n';

		for (const typeName of used) {
			const link = types.get(typeName);
			if (link) {
				readme += `[${typeName}]: ${baseUrl}${link}\n`;
			}
		}
	}
	
	return readme;
}

// Usage
const types = extractAllTypes('src');
const readme = fs.readFileSync('nolinks.README.md', 'utf8');
//const updated = removeLinks(readme);
const updated = addLinks(removeLinks(readme), types);
fs.writeFileSync('README.md', updated);