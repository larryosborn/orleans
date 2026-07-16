import { defineEnvVars } from '@sveltejs/kit/hooks';
import { building } from '$app/env';

// Minimal Standard Schema marking a var as optional (value may be undefined).
// Without a schema, defineEnvVars requires a non-empty string. The `types`
// field is a phantom type marker (never read at runtime) that drives the
// inferred value type — here `string | undefined`.
const optionalString = {
	'~standard': {
		version: 1 as const,
		vendor: 'orleans',
		validate: (value: unknown) => ({ value: value ? String(value) : undefined }),
		types: undefined as unknown as { input: string | undefined; output: string | undefined }
	}
};

// Standard Schema for a var that is required when the app *runs* but must be
// allowed to be absent at *build* time.
//
// SvelteKit executes the app during `build` (route analysis + prerendering) via
// `set_env()`, which runs these validators against the build-time environment.
// A plain `defineEnvVars` entry (no schema) requires a non-empty string, so the
// build fails in CI/deploy where runtime secrets aren't present on disk. Since
// SvelteKit sets `building` before calling `set_env()` during the build, we can
// skip the presence check while building and enforce it only at runtime. The
// inferred type stays `string`, matching the value seen by running code.
const requiredAtRuntime = {
	'~standard': {
		version: 1 as const,
		vendor: 'orleans',
		validate: (value: unknown) => {
			if (!value && !building) {
				return { issues: [{ message: 'Value is missing.' }] };
			}
			return { value: value ? String(value) : (undefined as unknown as string) };
		},
		types: undefined as unknown as { input: string | undefined; output: string }
	}
};

// Required in production at runtime, but optional during build and in dev. In
// dev the app derives its origin from the incoming request (see auth.ts), so
// running multiple dev servers on different ports just works — no ORIGIN needed.
const requiredInProduction = {
	'~standard': {
		version: 1 as const,
		vendor: 'orleans',
		validate: (value: unknown) => {
			if (!value && !building && !import.meta.env.DEV) {
				return { issues: [{ message: 'Value is missing.' }] };
			}
			return { value: value ? String(value) : undefined };
		},
		types: undefined as unknown as { input: string | undefined; output: string | undefined }
	}
};

export const variables = defineEnvVars({
	DATABASE_URL: {
		description: 'The database connection string.',
		schema: requiredAtRuntime
	},
	DATABASE_AUTH_TOKEN: {
		description:
			'Auth token for a remote libSQL/Turso database. Required on Cloudflare (remote DB); unused for local/Vercel file databases.',
		schema: optionalString
	},
	ORIGIN: {
		description:
			'The app origin (base URL), e.g. `https://example.com`. Required in production; ' +
			'in dev the origin is derived from the request, so any port works without it.',
		schema: requiredInProduction
	},
	BETTER_AUTH_SECRET: {
		description:
			'Secret used to sign tokens. For production use 32 characters generated with high entropy. See [Better Auth installation](https://www.better-auth.com/docs/installation).',
		schema: requiredAtRuntime
	},
	// Cloudflare R2 — lets the dashboard presign short-lived URLs to view archived
	// blobs. Same credentials the worker uses. Optional: without them, the
	// "view stored copy" endpoint falls back to the local BLOB_DIR (dev only).
	R2_ENDPOINT: {
		description: 'R2 S3 endpoint, e.g. https://<acct>.r2.cloudflarestorage.com.',
		schema: optionalString
	},
	R2_BUCKET: { description: 'R2 bucket name holding the archived blobs.', schema: optionalString },
	R2_ACCESS_KEY_ID: { description: 'R2 API token access key id.', schema: optionalString },
	R2_SECRET_ACCESS_KEY: { description: 'R2 API token secret access key.', schema: optionalString },
	BLOB_DIR: {
		description:
			'Local blob cache dir for serving archived copies in dev (default `.cache/blobs`).',
		schema: optionalString
	}
});
