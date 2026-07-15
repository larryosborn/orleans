// Type shims for upstream packages that ship broken type-entry pointers, which
// fail to resolve under `moduleResolution: "bundler"` (see tsconfig.json). These
// only affect type-checking — the packages work correctly at build/runtime.

// vitest 4.1.10: the `./config` export's `types` points at a root `config.d.ts`
// whose body is `export * from 'vitest/config'`, i.e. it resolves to itself, so
// `defineConfig` (and the `test` augmentation of vite's UserConfig) appear
// missing. The real, usable declarations live in `dist/config.d.ts`; re-map to
// them via a relative path, which bypasses the broken `exports` resolution.
declare module 'vitest/config' {
	export {
		defineConfig,
		defineProject,
		mergeConfig,
		configDefaults
	} from '../node_modules/vitest/dist/config.js';
}

// @inlang/paraglide-js: every shipped `.d.ts` re-exports from a `src/` directory
// that isn't in the published package, so the package's entry (`dist/index.d.ts`)
// exposes no members. Only `paraglideVitePlugin` is used here, so declare it
// directly rather than depend on the broken declaration files.
declare module '@inlang/paraglide-js' {
	import type { Plugin } from 'vite';
	export function paraglideVitePlugin(options: {
		project: string;
		outdir: string;
		[key: string]: unknown;
	}): Plugin | Plugin[];
}
