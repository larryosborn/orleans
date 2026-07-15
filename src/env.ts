import { defineEnvVars } from '@sveltejs/kit/hooks';

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

export const variables = defineEnvVars({
	DATABASE_URL: { description: 'The database connection string.' },
	DATABASE_AUTH_TOKEN: {
		description:
			'Auth token for a remote libSQL/Turso database. Required on Cloudflare (remote DB); unused for local/Vercel file databases.',
		schema: optionalString
	},
	ORIGIN: {
		description: 'The app origin (base URL), e.g. `http://localhost:5173`.'
	},
	BETTER_AUTH_SECRET: {
		description:
			'Secret used to sign tokens. For production use 32 characters generated with high entropy. See [Better Auth installation](https://www.better-auth.com/docs/installation).'
	}
});
