import ts, { factory } from "typescript";

function isExported(node: ts.Declaration): boolean {
	return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

function getParseTreeNode<T extends ts.Node>(node: T) {
	while (node && ((node.flags & ts.NodeFlags.Synthesized)))
		node = (node as any).original;
	return node;
}

export function kind(node: ts.Node): string {
	return ts.SyntaxKind[node.kind];
}

function hasSingleTypeParameter(node: ts.FunctionDeclaration | ts.MethodDeclaration): ts.ParameterDeclaration|undefined {
    if (node.typeParameters && node.typeParameters.length == 1) {
		const typeParam = node.typeParameters[0];
		
		if (ts.isTypeParameterDeclaration(typeParam) && typeParam.constraint) {
			let param: ts.ParameterDeclaration | undefined;

			for (const p of node.parameters) {
				if (p.type && ts.isTypeReferenceNode(p.type) && p.type.typeName.getText() === typeParam.name.text) {
					if (param)
						return;
					param = p;
				}
			}

			return param;
		}
	}
}

function createParameters(node: ts.FunctionDeclaration | ts.MethodDeclaration, param: ts.ParameterDeclaration, member: ts.TypeNode) {
	return node.parameters.map(p => {
		if (p === param) {
			p = factory.createParameterDeclaration(
				undefined,	//modifiers
				undefined,	//dotDotDotToken
				param.name,	//name
				undefined,	//questionToken
				member,		//type
			);
			(p.type as any).parent = p;
		}
		return p;
	});
}

function resolveTypesTransformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> | undefined {
	console.log("Resolving Types");
	const typeChecker = program.getTypeChecker();

	function getMembersOfConstraintType(constraint: ts.TypeNode): ts.TypeNode[] {
		const type			= typeChecker.getTypeAtLocation(constraint);

		const declarations	= type.getSymbol()?.getDeclarations();
		if (declarations) {
			let declaration: ts.EnumDeclaration|undefined;
			for (const i of declarations) {
				if (ts.isEnumDeclaration(i)) {
					declaration = i;
					break;
				}
			}
			if (declaration) {
				const prefix = typeChecker.typeToString(type, declaration);
				return declaration.members.map(i => factory.createTypeReferenceNode(
					factory.createQualifiedName(factory.createIdentifier(prefix), i.name.getText()),
					undefined
				));
			}
		}

		if (type.isUnion()) {
			if (type.types.every(i => i.isNumberLiteral()))
				return type.types.map(i => factory.createLiteralTypeNode(factory.createNumericLiteral(i.value)));

			if (type.types.every(i => i.isStringLiteral()))
				return type.types.map(i => factory.createLiteralTypeNode(factory.createStringLiteral(i.value)));
		}
		return [];
	}

	return (context: ts.TransformationContext) => {
		return (sourceFile: ts.SourceFile) => {
			//UNCOMMENT TO DISABLE:
			//return sourceFile;

			let typeformatflags = ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope|ts.TypeFormatFlags.NoTruncation|ts.TypeFormatFlags.MultilineObjectLiterals;
			let exported 	= false;
			let depth		= 0;
			let declaration: ts.Declaration | undefined;
			const inherited: ts.ExpressionWithTypeArguments[] = [];
			
			// Create a cache for module resolution
			const moduleResolutionCache = ts.createModuleResolutionCache(
				process.cwd(), 			// Current working directory
				fileName => fileName	// Normalize file names
			);

			const moduleMap: Record<string, string> = {};

			function serializeNode(node: ts.Node): string {
				const printer = ts.createPrinter();
				const result = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
				return result;
			}

			function print(x: string) {
				console.log('  '.repeat(depth) + x);
			}

			function fixParents(node: ts.Node) {
				let	parent = node;
				function visit(node: ts.Node): ts.Node {
					const save = parent;
					parent = node;
					node = ts.visitEachChild(node, visit, context);
					(node as any).parent = parent = save;
					return node;
				}
				return ts.visitEachChild(node, visit, context);
			}
			function templateSubstitute(node: ts.Node, param: string, replacement: ts.TypeNode) {
				function visit(node: ts.Node): ts.Node {
					if (ts.isTypeReferenceNode(node)) {
						// If the type node is a reference to the type parameter, replace it
						if (ts.isIdentifier(node.typeName) && node.typeName.text === param)
							return replacement;
					}
					return ts.visitEachChild(node, visit, context);
				}
				return ts.visitNode(node, visit);
			}
			
			function createReturn(node: ts.FunctionDeclaration | ts.MethodDeclaration, member: ts.TypeNode) {
				const ret = fixParents(templateSubstitute(node.type!, node.typeParameters![0].name.getText(), member));
				const obj = ret as any;
				//(ret as any).original = undefined;
				obj.flags &= ~16;
				obj.parent = obj.original.parent;
				return ret as ts.TypeNode;
			}
			
			function fixTypeReference(node: ts.TypeReferenceNode): ts.TypeReferenceNode {
				const name	= node.typeName;
				if (ts.isQualifiedName(name))
					return node;

				const symbol = (name as any).symbol;
				if (symbol) {
					const declarations = symbol.getDeclarations();
					if (declarations && declarations.length > 0) {
						const exported = isExported(declarations[0]);
						if (!exported && !declarations[0].typeParameters) {
							for (const statement of sourceFile.statements) {
								if (ts.isTypeAliasDeclaration(statement) && isExported(statement) && statement !== declaration) {
									if (ts.isTypeReferenceNode(statement.type) && ts.isIdentifier(statement.type.typeName) && statement.type.typeName.escapedText === name.escapedText) {
										console.log("found");
										const newName = factory.createIdentifier(statement.name.getText());
										return factory.updateTypeReferenceNode(node, newName, node.typeArguments);
									}
									/*
								} else if (ts.isImportDeclaration(statement)) {
									const importClause = statement.importClause;
									if (importClause && importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
										for (const i of importClause.namedBindings.elements) {
											if (i.propertyName?.escapedText === name.escapedText) {
												console.log("found");
												const newName = factory.createIdentifier(i.name.getText());
												return factory.updateTypeReferenceNode(node, newName, node.typeArguments);
											}
										}

									}*/
								}
							}
						}

						// add module prefix if missing
						const prefix = moduleMap[declarations[0].getSourceFile().fileName];
						if (prefix) {
							const newName = factory.createQualifiedName(factory.createIdentifier(prefix), name.text);
							return factory.updateTypeReferenceNode(node, newName, node.typeArguments);
						}
					}
				}

				return node;
			}


			//various type fixing
			function visitSubType(node: ts.Node): ts.Node {
				//print(kind(node));

				if (ts.isQualifiedName(node))
					return node;

				if (ts.isTypeParameterDeclaration(node) || ts.isParameter(node))
					return node;

				if (ts.isTypeReferenceNode(node))
					return fixTypeReference(node);
	
				++depth;
				node = ts.visitEachChild(node, visitSubType, context);
				--depth;

				// strip {}'s from intersection
				if (ts.isIntersectionTypeNode(node)) {
					const filtered = node.types.filter(n => !ts.isTypeLiteralNode(n) || n.members.length);
					if (filtered.length === 1)
						return filtered[0];
					return ts.factory.updateIntersectionTypeNode(node, ts.factory.createNodeArray(filtered));
		  		}

				// remove parentheses if not needed
				if (ts.isParenthesizedTypeNode(node)) {
					if (ts.isTypeLiteralNode(node.type))
						return node.type;
				}

				return node;
			}

			function fixType(node: ts.TypeNode, declaration?: ts.Declaration) {
				if (ts.isTypeReferenceNode(node) && !node.typeArguments)
					return fixTypeReference(node);

				const type		= typeChecker.getTypeAtLocation(node);
/*
				if (ts.isImportTypeNode(node)) {
					//node.qualifier
					if (node.qualifier && ts.isIdentifier(node.qualifier)) {
						const text = node.qualifier.escapedText;
						for (const statement of sourceFile.statements) {
							if (ts.isImportDeclaration(statement)) {
								const module = statement.moduleSpecifier;
								if (ts.isStringLiteral(module)) {
									const importClause = statement.importClause;
									if (importClause && importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
										for (const i of importClause.namedBindings.elements) {
											if (i.propertyName?.escapedText === text) {
												console.log("found");
												importClause.getSourceFile();
												const newName = factory.createIdentifier(i.name.getText());
												//return factory.updateTypeReferenceNode(node, newName, node.typeArguments);
											}
										}

									}
								}
							}
						}
					}
				}
*/
				const typetext	= typeChecker.typeToString(type, declaration);
				//print('"'+typetext+'"');

				let node1 = typetext === 'any' ? node : typeChecker.typeToTypeNode(type, declaration, typeformatflags);

				if (node1) {
					if (ts.isTypeReferenceNode(node1) && !node1.typeArguments)
						return fixTypeReference(node1);

					node1 = visitSubType(node1) as ts.TypeNode;
					const text2 = serializeNode(node1);
					//console.log("**AFTER**" + text2);
					if (text2 !== 'any')
						return node1;
				}

				return node;
			}

			//finds types
			function visitType(node: ts.Node): ts.Node | undefined {
				if (ts.isTypeNode(node))
					return fixType(node, declaration);
				return ts.visitEachChild(node, visitType, context);
			}

			function fixTypes<T extends ts.Declaration>(node: T) {
				//print((node as any).original.kind);
				const save = declaration;
				declaration = getParseTreeNode(node);
				node = ts.visitEachChild(node, visitType, context);
				declaration = save;
				return node;
			}

			//	VISIT - just for stripping crap out
			function visit(node: ts.Node): ts.Node | undefined {
				//print(kind(node));

				if (ts.isVariableDeclaration(node)) {
					if (isExported(node)) {
						exported = true;
						return node;
					}
					for (const i of inherited) {
						if (i.expression === node.name) {
							exported	= true;
							if (node.type) {
								//setParentAndFlag(node.type, node);
								const type = fixType(node.type, node);
								return factory.updateVariableDeclaration(node, node.name, node.exclamationToken, type, node.initializer);
							}
						}
					}
					return undefined; // Remove the node
				}

				if (ts.isVariableStatement(node)) {
					const modifiers = node.modifiers;
					exported	= !!modifiers && modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
					if (!exported) {
						//fixParents(node);
						node = ts.visitEachChild(node, visit, context);
					}
					return exported ? node : undefined;
				}

				if (ts.isTypeAliasDeclaration(node)) {
					declaration = node;
					//print("++TYPEDEF");
					const save = typeformatflags;
					typeformatflags = (typeformatflags & ~ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope) | ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.MultilineObjectLiterals;
					node = fixTypes(node);
					typeformatflags = save;
					//print("--TYPEDEF");
					return node;
				}

				++depth;
				node = ts.visitEachChild(node, visit, context);
				--depth;
				return node;
			}
			
			//SourceFile:
			print(`SourceFile ${sourceFile.fileName}`);
			++depth;

			const newStatements: ts.Statement[] = [];

			for (const statement of sourceFile.statements) {
				//check for inheriting consts
				if (ts.isClassDeclaration(statement)) {
					print(`fixing class ${statement.name?.getText()}`);

					const heritageClauses = statement.heritageClauses;
					if (heritageClauses) {
						for (const i of heritageClauses) {
							if (i.token === ts.SyntaxKind.ExtendsKeyword)
								inherited.push(...i.types);
						}
					}
					//(node as any).parent = sourceFile;
					++depth;
					const newMembers: ts.ClassElement[] = [];
					for (const member of statement.members) {
						const param = ts.isMethodDeclaration(member) && hasSingleTypeParameter(member);
						if (param) {
							const members	= getMembersOfConstraintType(member.typeParameters![0].constraint!);
							if (members.length) {
								console.log(`Expanding generic method "${member.name.getText()}"`);
								for (const i of members) {
									const overload = factory.createMethodDeclaration(
										undefined,		// modifiers
										undefined,		// asteriskToken
										member.name,	// name
										undefined,		// questionToken
										undefined,		// typeParameters
										createParameters(member, param, i),	// parameters
										createReturn(member, i),	//type
										undefined		//body
									);
									newMembers.push(fixTypes(overload));
								}
								continue;
							}
						}
						// Add the original member to the class
						newMembers.push(fixTypes(member));
					}

					// Update the class declaration with the new members
					newStatements.push(factory.updateClassDeclaration(
						statement,
						statement.modifiers,
						statement.name,
						statement.typeParameters,
						statement.heritageClauses,
						newMembers
					));
					--depth;

				} else if (ts.isImportDeclaration(statement)) {
					const importClause = statement.importClause;
					if (importClause && importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
						const module = statement.moduleSpecifier;
						if (ts.isStringLiteral(module)) {
							// Resolve the module name to its file path
							const resolved = ts.resolveModuleName(
								module.text,
								sourceFile.fileName,
								program.getCompilerOptions(),
								{
									fileExists: ts.sys.fileExists,
									readFile: ts.sys.readFile,
								},
								moduleResolutionCache
							);
			
							if (resolved.resolvedModule)
								moduleMap[resolved.resolvedModule.resolvedFileName] = importClause.namedBindings.name.text;
						}
					}
					newStatements.push(statement);

				} else if (ts.isFunctionDeclaration(statement)) {
					const param = hasSingleTypeParameter(statement);

					//const type	= typeChecker.getTypeAtLocation(statement);
					//const node 	= typeChecker.typeToTypeNode(type, statement, typeformatflags);


					if (param) {
						const members		= getMembersOfConstraintType(statement.typeParameters![0].constraint!);
						if (members.length) {
							console.log(`Expanding generic function "${statement.name?.escapedText}"`);
							for (const i of members) {
								const overload 	= factory.createFunctionDeclaration(
									[factory.createModifier(ts.SyntaxKind.ExportKeyword)], // Add export
									undefined,		//asteriskToken
									statement.name,	//name
									undefined,		//type params
									createParameters(statement, param, i),
									createReturn(statement, i),	//type
									undefined		//body
								);
								newStatements.push(fixTypes(overload));
							}
							continue;
						}
					}
					newStatements.push(fixTypes(statement));

				} else if (ts.isTypeAliasDeclaration(statement)) {
					//print("++TYPEDEF");
					const save = typeformatflags;
					typeformatflags = (typeformatflags & ~ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope) | ts.TypeFormatFlags.InTypeAlias | ts.TypeFormatFlags.MultilineObjectLiterals;
					newStatements.push(fixTypes(statement));
					typeformatflags = save;
					//print("--TYPEDEF");
	
				} else if (ts.isInterfaceDeclaration(statement)) {
					let int = statement;
					const heritageClauses = int.heritageClauses;
					if (heritageClauses) {
						for (const i of heritageClauses) {
							if (i.token === ts.SyntaxKind.ExtendsKeyword) {
								if (i.types.length === 1) {
									const base = fixType(i.types[0]);
									if (ts.isTypeLiteralNode(base)) {
										int = factory.updateInterfaceDeclaration(int,
											int.modifiers,
											int.name,
											int.typeParameters,
											undefined,
										    [...base.members, ...int.members]
										);
									}
								} else {
									inherited.push(...i.types);
								}
							}
						}
					}
					newStatements.push(int);

				} else {
					newStatements.push(statement);
				}
			}
			return ts.visitEachChild(factory.updateSourceFile(sourceFile, newStatements), visit, context);
		};
	};
}

export default resolveTypesTransformer;