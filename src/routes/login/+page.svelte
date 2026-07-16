<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import type { ActionData, PageServerData } from './$types';

	let { form, data }: { form: ActionData; data: PageServerData } = $props();

	// Carry the post-login destination through the POST query string; the server
	// only honors same-origin paths, defaulting to /account.
	const redirectQuery = $derived(
		data.redirectTo && data.redirectTo !== '/account'
			? `&redirect=${encodeURIComponent(data.redirectTo)}`
			: ''
	);
</script>

<div class="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
	<div class="w-full max-w-sm">
		<Card.Root>
			<Card.Header class="text-center">
				<Card.Title class="text-xl">Welcome back</Card.Title>
				<Card.Description>Enter your email below to sign in to your account</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="post" action="?/signInEmail{redirectQuery}" use:enhance>
					<div class="flex flex-col gap-6">
						<div class="grid gap-2">
							<Label for="email">Email</Label>
							<Input
								id="email"
								name="email"
								type="email"
								placeholder="m@example.com"
								autocomplete="email"
								required
							/>
						</div>
						<div class="grid gap-2">
							<div class="flex items-center">
								<Label for="password">Password</Label>
								<a
									href="##"
									class="ml-auto text-sm underline-offset-4 hover:underline"
									tabindex={-1}
								>
									Forgot your password?
								</a>
							</div>
							<Input
								id="password"
								name="password"
								type="password"
								autocomplete="current-password"
								required
							/>
						</div>
						<div class="grid gap-2">
							<Label for="name">Name</Label>
							<Input id="name" name="name" placeholder="Jane Doe" autocomplete="name" />
							<p class="text-muted-foreground text-xs">Only needed when creating an account.</p>
						</div>

						{#if form?.message}
							<p class="text-destructive text-sm" role="alert">{form.message}</p>
						{/if}

						<div class="flex flex-col gap-3">
							<Button type="submit" class="w-full">Sign in</Button>
							<Button
								type="submit"
								formaction="?/signUpEmail{redirectQuery}"
								variant="outline"
								class="w-full"
							>
								Create account
							</Button>
						</div>
					</div>
				</form>
			</Card.Content>
		</Card.Root>
	</div>
</div>
