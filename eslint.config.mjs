import eslint from "@eslint/js";
import tslint from "typescript-eslint";
async function maybeImport(modulePath) { try { return await import(modulePath); } catch { return undefined; } }
let customPlugin = await maybeImport('../eslint-custom.mjs');
// @ts-check

export default tslint.config(
	eslint.configs.recommended,
	...tslint.configs.recommended,
	...tslint.configs.stylistic,
	...(customPlugin ? [customPlugin.config] : []),
	{
		rules: {
			"semi": ["error", "always"],
						"@typescript-eslint/prefer-function-type": "off",
			"@typescript-eslint/array-type": "off",
			"@typescript-eslint/no-unused-vars":  [
				"warn", {
					argsIgnorePattern: "^(_+$|_[^_])",
					varsIgnorePattern: "^(_+$|_[^_])",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-this-alias": "off",
			//"@typescript-eslint/explicit-module-boundary-types": "off",
			//"@typescript-eslint/no-non-null-assertion": "off"
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/consistent-indexed-object-style": "off"

		},
	},
	{
		files: ["src/*.ts"],
	}
);
