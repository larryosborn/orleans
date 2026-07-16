<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let { children, data }: { children: Snippet; data: { user: { email: string } } } = $props();

	const nav = [
		{ href: '/dashboard', label: 'Overview' },
		{ href: '/dashboard/runs', label: 'Runs' },
		{ href: '/dashboard/content', label: 'Content' }
	];

	function active(href: string): boolean {
		return href === '/dashboard' ? page.url.pathname === href : page.url.pathname.startsWith(href);
	}
</script>

<div class="min-h-svh bg-muted/30">
	<header class="border-b bg-background">
		<div class="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
			<div class="flex items-center gap-6">
				<a href="/dashboard" class="text-sm font-semibold tracking-tight">Orleans&nbsp;Sync</a>
				<nav class="flex items-center gap-1">
					{#each nav as item (item.href)}
						<a
							href={item.href}
							class="rounded-md px-3 py-1.5 text-sm transition-colors {active(item.href)
								? 'bg-muted font-medium text-foreground'
								: 'text-muted-foreground hover:text-foreground'}"
						>
							{item.label}
						</a>
					{/each}
				</nav>
			</div>
			<span class="text-xs text-muted-foreground">{data.user.email}</span>
		</div>
	</header>

	<main class="mx-auto max-w-6xl px-6 py-6">
		{@render children()}
	</main>
</div>
