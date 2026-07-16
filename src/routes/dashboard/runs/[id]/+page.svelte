<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { formatBytes, formatNumber, formatDateTime, formatDuration } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const r = $derived(data.run);

	const stats = $derived([
		['Requests', formatNumber(r.requestsMade)],
		['Pages', formatNumber(r.pages)],
		['Documents', formatNumber(r.documents)],
		['Discovered', formatNumber(r.discovered)],
		['New', formatNumber(r.newCount)],
		['Changed', formatNumber(r.changedCount)],
		['Unchanged', formatNumber(r.unchangedCount)],
		['Gone', formatNumber(r.goneCount)],
		['Errors', formatNumber(r.errorCount)],
		['Downloaded', formatBytes(r.bytesDownloaded)],
		['Stored', formatBytes(r.bytesStored)],
		['Estimated', formatBytes(r.bytesEstimated)]
	] as const);
</script>

<div class="space-y-6">
	<div class="flex items-center gap-3">
		<a href="/dashboard/runs" class="text-sm text-muted-foreground hover:underline">← Runs</a>
		<h1 class="text-lg font-semibold capitalize">{r.mode} run</h1>
		<Badge variant={r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge>
	</div>

	<Card.Root>
		<Card.Content class="grid grid-cols-2 gap-4 pt-6 text-sm sm:grid-cols-3 lg:grid-cols-4">
			{#each stats as [label, value] (label)}
				<div>
					<p class="text-xs text-muted-foreground">{label}</p>
					<p class="text-lg font-semibold tabular-nums">{value}</p>
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Content class="grid gap-2 pt-6 text-sm sm:grid-cols-2">
			<div>
				<span class="text-muted-foreground">Requested</span>
				{formatDateTime(r.requestedAt)}
			</div>
			<div><span class="text-muted-foreground">Started</span> {formatDateTime(r.startedAt)}</div>
			<div><span class="text-muted-foreground">Finished</span> {formatDateTime(r.finishedAt)}</div>
			<div>
				<span class="text-muted-foreground">Duration</span>
				{formatDuration(r.startedAt?.getTime(), r.finishedAt?.getTime())}
			</div>
			<div class="sm:col-span-2">
				<span class="text-muted-foreground">Worker</span>
				<span class="font-mono text-xs">{r.workerId ?? '—'}</span>
			</div>
			{#if r.error}
				<div class="sm:col-span-2">
					<span class="text-muted-foreground">Error</span>
					<pre class="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">{r.error}</pre>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header><Card.Title>Events ({formatNumber(data.events.length)})</Card.Title></Card.Header>
		<Card.Content>
			{#if data.eventCounts.length}
				<div class="mb-3 flex flex-wrap gap-2">
					{#each data.eventCounts as c (c.kind)}
						<Badge variant="outline">{c.kind}: {formatNumber(c.n)}</Badge>
					{/each}
				</div>
				<ul class="max-h-96 space-y-1 overflow-y-auto text-xs">
					{#each data.events as e (e.id)}
						<li class="flex items-baseline gap-2">
							<span class="shrink-0 text-muted-foreground">{formatDateTime(e.at)}</span>
							<span class="shrink-0 font-medium"
								>{e.kind}{e.httpStatus ? ` ${e.httpStatus}` : ''}</span
							>
							<span class="truncate font-mono text-muted-foreground" title={e.url ?? ''}>
								{e.url ?? e.message ?? ''}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-sm text-muted-foreground">No events recorded for this run.</p>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
