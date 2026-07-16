<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatBytes, formatNumber, formatRelative, formatDuration } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const o = $derived(data.overview);
	const dedupSavings = $derived(Math.max(0, o.logicalBytes - o.storedBytes));

	// Live active-run state. `streamed` is fed by the SSE stream; until the first
	// event arrives (and while disconnected) we fall back to the server-loaded
	// value, so the status card reflects progress without a page reload.
	let streamed = $state<typeof data.active | undefined>(undefined);
	const active = $derived(streamed !== undefined ? streamed : data.active);
	let connected = $state(false);

	onMount(() => {
		const es = new EventSource('/dashboard/stream');
		es.addEventListener('progress', (e) => {
			const p = JSON.parse((e as MessageEvent).data);
			const wasActive = !!active;
			streamed = p
				? {
						...p,
						heartbeatAt: p.heartbeatAt ? new Date(p.heartbeatAt) : null,
						startedAt: p.startedAt ? new Date(p.startedAt) : null
					}
				: null;
			// When the active run ends, refresh aggregates (tiles, feed, alert).
			if (wasActive && !p) invalidateAll();
		});
		es.onopen = () => (connected = true);
		es.onerror = () => (connected = false);
		return () => es.close();
	});

	const maxStorage = $derived(Math.max(1, ...data.storage.map((s) => Number(s.bytes))));

	function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (s === 'running') return 'default';
		if (s === 'failed') return 'destructive';
		if (s === 'completed') return 'secondary';
		return 'outline';
	}
	function changeVariant(k: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (k === 'new') return 'default';
		if (k === 'gone' || k === 'error') return 'destructive';
		if (k === 'changed') return 'secondary';
		return 'outline';
	}
</script>

<div class="space-y-6">
	<!-- Worker-health alert ----------------------------------------------- -->
	{#if data.workerAlert}
		<div
			class="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
			role="alert"
		>
			<span aria-hidden="true">⚠️</span>
			<div>
				<p class="font-medium">No worker processing this run</p>
				<p class="text-amber-800 dark:text-amber-300/90">{data.workerAlert}</p>
			</div>
		</div>
	{/if}

	<!-- Current status ---------------------------------------------------- -->
	<Card.Root>
		<Card.Header>
			<div class="flex items-center justify-between">
				<Card.Title>Sync status</Card.Title>
				<div class="flex items-center gap-2">
					{#if connected}
						<span
							class="flex items-center gap-1 text-xs text-muted-foreground"
							title="Live updates"
						>
							<span class="relative flex h-2 w-2">
								<span
									class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"
								></span>
								<span class="relative inline-flex h-2 w-2 rounded-full bg-green-500"></span>
							</span>
							live
						</span>
					{/if}
					{#if active}
						<Badge variant={statusVariant(active.status)}>{active.status}</Badge>
					{:else}
						<Badge variant="outline">idle</Badge>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content>
			{#if active}
				{@const pct = active.maxPages
					? Math.min(100, Math.round((active.requestsMade / active.maxPages) * 100))
					: null}
				<div class="space-y-3">
					<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
						<span class="font-medium capitalize">{active.mode} run</span>
						<span class="text-muted-foreground">
							{formatNumber(active.requestsMade)} requests
							{#if active.maxPages}/ {formatNumber(active.maxPages)} cap{/if}
						</span>
						<span class="text-muted-foreground">
							heartbeat {formatRelative(active.heartbeatAt)}
						</span>
						<span class="text-muted-foreground">
							running {formatDuration(active.startedAt?.getTime())}
						</span>
					</div>

					{#if pct !== null}
						<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
							<div class="h-full rounded-full bg-primary transition-all" style="width:{pct}%"></div>
						</div>
					{/if}

					{#if active.currentUrl}
						<p class="truncate font-mono text-xs text-muted-foreground" title={active.currentUrl}>
							{active.currentUrl}
						</p>
					{/if}

					<div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
						<div><span class="text-muted-foreground">pages</span> {formatNumber(active.pages)}</div>
						<div>
							<span class="text-muted-foreground">docs</span>
							{formatNumber(active.documents)}
						</div>
						<div>
							<span class="text-muted-foreground">changed</span>
							{formatNumber(active.newCount + active.changedCount)}
						</div>
						<div>
							<span class="text-muted-foreground">errors</span>
							{formatNumber(active.errorCount)}
						</div>
					</div>

					<div class="flex gap-2 pt-1">
						<form method="POST" action="?/control" use:enhance>
							<input type="hidden" name="runId" value={active.id} />
							{#if active.status === 'paused'}
								<input type="hidden" name="action" value="resume" />
								<Button type="submit" variant="outline" size="sm">Resume</Button>
							{:else}
								<input type="hidden" name="action" value="pause" />
								<Button type="submit" variant="outline" size="sm">Pause</Button>
							{/if}
						</form>
						<form method="POST" action="?/control" use:enhance>
							<input type="hidden" name="runId" value={active.id} />
							<input type="hidden" name="action" value="cancel" />
							<Button type="submit" variant="destructive" size="sm">Cancel</Button>
						</form>
					</div>
				</div>
			{:else if data.lastRun}
				<p class="text-sm text-muted-foreground">
					No active run. Last run: <span class="capitalize">{data.lastRun.mode}</span>
					<Badge variant={statusVariant(data.lastRun.status)}>{data.lastRun.status}</Badge>
					· {formatRelative(data.lastRun.finishedAt)} ·
					{formatNumber(data.lastRun.pages)} pages, {formatNumber(data.lastRun.documents)} docs
				</p>
			{:else}
				<p class="text-sm text-muted-foreground">No runs yet. Start one below.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Controls ---------------------------------------------------------- -->
	<Card.Root>
		<Card.Header><Card.Title>Start a run</Card.Title></Card.Header>
		<Card.Content>
			<form method="POST" action="?/enqueue" use:enhance class="flex flex-wrap items-end gap-3">
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Mode</span>
					<select name="mode" class="h-9 rounded-md border bg-background px-3 text-sm">
						<option value="sync">sync — core-first, resumable, only what's due</option>
						<option value="estimate">estimate — discover + size, no download</option>
						<option value="crawl">crawl — download &amp; store new content</option>
						<option value="recrawl">recrawl — re-check known URLs for changes</option>
					</select>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Max requests (optional)</span>
					<input
						name="max"
						type="number"
						min="1"
						placeholder="unbounded"
						class="h-9 w-40 rounded-md border bg-background px-3 text-sm"
					/>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span
						class="text-muted-foreground"
						title="Blank = download all. 0 = skip documents (HTML only)."
					>
						Max file size, MB (optional)
					</span>
					<input
						name="maxDocMb"
						type="number"
						min="0"
						step="0.1"
						placeholder="all"
						class="h-9 w-40 rounded-md border bg-background px-3 text-sm"
					/>
				</label>
				<Button type="submit" disabled={!!active}>Queue run</Button>
				{#if active}
					<span class="text-xs text-muted-foreground">A run is already active.</span>
				{/if}
			</form>
			{#if form?.enqueued}
				<p class="mt-2 text-xs text-green-600">
					Queued {form.mode} run — the worker will pick it up.
				</p>
			{:else if form?.error}
				<p class="mt-2 text-xs text-destructive">{form.error}</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Stat tiles -------------------------------------------------------- -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
		{#snippet tile(label: string, value: string, sub?: string)}
			<Card.Root>
				<Card.Content class="pt-6">
					<p class="text-xs text-muted-foreground">{label}</p>
					<p class="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
					{#if sub}<p class="text-xs text-muted-foreground">{sub}</p>{/if}
				</Card.Content>
			</Card.Root>
		{/snippet}
		{@render tile('Resources', formatNumber(o.resources), `${formatNumber(o.pages)} pages`)}
		{@render tile('Documents', formatNumber(o.documents))}
		{@render tile('Gone (404)', formatNumber(o.gone))}
		{@render tile('Stored', formatBytes(o.storedBytes), `${formatNumber(o.blobObjects)} objects`)}
		{@render tile('Dedup saved', formatBytes(dedupSavings), 'vs logical size')}
		{@render tile('Links', formatNumber(o.links), `${formatNumber(o.versions)} versions`)}
	</div>

	<div class="grid gap-6 lg:grid-cols-2">
		<!-- Storage by type ---------------------------------------------- -->
		<Card.Root>
			<Card.Header><Card.Title>Storage by content type</Card.Title></Card.Header>
			<Card.Content class="space-y-2">
				{#each data.storage as row (row.contentType)}
					<div class="space-y-1">
						<div class="flex justify-between text-xs">
							<span class="truncate font-mono" title={row.contentType}>{row.contentType}</span>
							<span class="text-muted-foreground">
								{formatBytes(Number(row.bytes))} · {formatNumber(row.n)}
							</span>
						</div>
						<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
							<div
								class="h-full rounded-full bg-primary/70"
								style="width:{Math.round((Number(row.bytes) / maxStorage) * 100)}%"
							></div>
						</div>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">No data yet.</p>
				{/each}
			</Card.Content>
		</Card.Root>

		<!-- Errors -------------------------------------------------------- -->
		<Card.Root>
			<Card.Header><Card.Title>Errors &amp; events</Card.Title></Card.Header>
			<Card.Content>
				{#if data.eventCounts.length}
					<div class="mb-3 flex flex-wrap gap-2">
						{#each data.eventCounts as c (c.kind)}
							<Badge variant="outline">{c.kind}: {formatNumber(c.n)}</Badge>
						{/each}
					</div>
					<ul class="space-y-1 text-xs">
						{#each data.events as e (e.id)}
							<li class="flex items-baseline gap-2">
								<span class="text-muted-foreground">{formatRelative(e.at)}</span>
								<span class="font-medium">{e.kind}{e.httpStatus ? ` ${e.httpStatus}` : ''}</span>
								<span class="truncate font-mono text-muted-foreground" title={e.url ?? ''}>
									{e.url ?? e.message ?? ''}
								</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">No errors recorded. 🎉</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<!-- Change feed ------------------------------------------------------- -->
	<Card.Root>
		<Card.Header>
			<div class="flex items-center justify-between">
				<Card.Title>Recent changes</Card.Title>
				<a href="/dashboard/content" class="text-xs text-muted-foreground hover:underline">
					View all content →
				</a>
			</div>
		</Card.Header>
		<Card.Content>
			{#if data.feed.length}
				<ul class="divide-y">
					{#each data.feed as v (v.id)}
						<li class="flex items-center gap-3 py-2 text-sm">
							<Badge variant={changeVariant(v.changeKind)} class="w-16 justify-center">
								{v.changeKind}
							</Badge>
							<span class="min-w-0 flex-1 truncate" title={v.url}>
								{v.title || v.url}
							</span>
							<span class="shrink-0 text-xs text-muted-foreground">
								{formatBytes(v.sizeBytes)} · {formatRelative(v.observedAt)}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">No changes recorded yet.</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
