<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatBytes, formatNumber, formatRelative, formatDuration } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const o = $derived(data.overview);
	const dedupSavings = $derived(Math.max(0, o.logicalBytes - o.storedBytes));

	// Live state fed by the SSE stream (`{ run, progress }`); until the first event
	// (and while disconnected) we fall back to the server-loaded values.
	let streamed = $state<typeof data.active | undefined>(undefined);
	let streamedProgress = $state<typeof data.progress | undefined>(undefined);
	let streamedProcessing = $state<typeof data.processing | undefined>(undefined);
	const processing = $derived(streamedProcessing ?? data.processing);
	// New URLs discovered since the last aggregate tick — a nonzero value means the
	// frontier (and the Overall denominator) is still growing, not converged yet.
	let recentDelta = $state(0);
	const active = $derived(streamed !== undefined ? streamed : data.active);
	const progress = $derived(streamedProgress ?? data.progress);
	let connected = $state(false);

	// Coverage %, guarded against divide-by-zero (a zero-total bucket reads as 0%).
	const pctOf = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);
	// Overall roll-up: everything fetched vs everything discovered (the headline).
	const overallPct = $derived(pctOf(progress.fetched, progress.totalResources));
	const ratePerMin = $derived.by(() => {
		if (!active?.startedAt) return 0;
		const min = (Date.now() - active.startedAt.getTime()) / 60000;
		return min > 0.05 ? Math.round(active.requestsMade / min) : 0;
	});
	const etaText = $derived.by(() => {
		if (!active || ratePerMin <= 0 || progress.dueRemaining <= 0) return null;
		const m = Math.ceil(progress.dueRemaining / ratePerMin);
		return m >= 60 ? `~${Math.floor(m / 60)}h ${m % 60}m` : `~${m}m`;
	});

	onMount(() => {
		const es = new EventSource('/dashboard/stream');
		es.addEventListener('progress', (e) => {
			const p = JSON.parse((e as MessageEvent).data);
			const wasActive = !!active;
			const run = p?.run ?? null;
			streamed = run
				? {
						...run,
						requestedAt: run.requestedAt ? new Date(run.requestedAt) : null,
						heartbeatAt: run.heartbeatAt ? new Date(run.heartbeatAt) : null,
						startedAt: run.startedAt ? new Date(run.startedAt) : null
					}
				: null;
			if (p?.progress) {
				const prev = streamedProgress?.totalResources ?? data.progress.totalResources;
				recentDelta = Math.max(0, p.progress.totalResources - prev);
				streamedProgress = p.progress;
			}
			if (p?.processing) streamedProcessing = p.processing;
			// When the active run ends, refresh aggregates (tiles, feed, alert).
			if (wasActive && !run) invalidateAll();
		});
		es.onopen = () => (connected = true);
		es.onerror = () => (connected = false);
		return () => es.close();
	});

	// Worker-health hint, derived from the *live* run so it clears the instant a
	// worker starts heartbeating (a load-time snapshot would linger). Recomputes
	// each SSE tick, so a stale-heartbeat/unclaimed run surfaces on its own too.
	const STALE_HEARTBEAT_MS = 30_000;
	const QUEUE_GRACE_MS = 12_000;
	const workerAlert = $derived.by(() => {
		const a = active;
		if (!a) return null;
		const now = Date.now();
		if (a.status === 'queued') {
			const req = a.requestedAt?.getTime();
			return req && now - req > QUEUE_GRACE_MS
				? 'This run is queued but no worker has claimed it. Start the worker with `bun run worker`.'
				: null;
		}
		if (a.status === 'running' || a.status === 'paused') {
			const beat = a.heartbeatAt?.getTime();
			if (!beat || now - beat > STALE_HEARTBEAT_MS) {
				const ago = beat ? `${Math.round((now - beat) / 1000)}s ago` : 'never';
				return `The worker hasn't sent a heartbeat (last: ${ago}) — it may have stopped. Check that \`bun run worker\` is running.`;
			}
		}
		return null;
	});

	// The heartbeat, worker health, and connection signals collapse into a single
	// fixed-width status chip (live / paused / stale / idle) in the card header.
	// `stale` folds in the former worker-health banner (stale heartbeat OR a queued
	// run no worker has claimed) so awareness isn't lost — see the tooltip.
	type StatusKind = 'live' | 'paused' | 'stale' | 'idle';
	const statusKind = $derived.by<StatusKind>(() => {
		if (!active) return 'idle';
		if (workerAlert) return 'stale';
		if (active.status === 'paused') return 'paused';
		return 'live';
	});
	const STATUS: Record<StatusKind, { label: string; dot: string; ping: boolean }> = {
		live: { label: 'live', dot: 'bg-green-500', ping: true },
		paused: { label: 'paused', dot: 'bg-amber-500', ping: false },
		stale: { label: 'stale', dot: 'bg-red-500', ping: true },
		idle: { label: 'idle', dot: 'bg-muted-foreground/50', ping: false }
	};
	const status = $derived(STATUS[statusKind]);

	const maxStorage = $derived(Math.max(1, ...data.storage.map((s) => Number(s.bytes))));

	function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (s === 'running') return 'default';
		if (s === 'failed') return 'destructive';
		if (s === 'completed') return 'secondary';
		return 'outline';
	}
	// Badge colour for a change/outcome/state token: new → primary, gone/error →
	// destructive, changed → secondary, everything else (probed / active /
	// unchanged re-verify) → outline. Shared by the change feed and the panel.
	function changeVariant(k: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (k === 'new') return 'default';
		if (k === 'gone' || k === 'error') return 'destructive';
		if (k === 'changed') return 'secondary';
		return 'outline';
	}
	// Resource type: page / document / other (unknown kinds collapse to "other").
	const KNOWN_KINDS = new Set(['page', 'document', 'sitemap']);
	function typeLabel(kind: string): string {
		return KNOWN_KINDS.has(kind) ? kind : 'other';
	}
</script>

{#snippet coverageBar(label: string, done: number, total: number, pct: number, unit = '')}
	<div class="space-y-1">
		<div class="flex justify-between text-xs">
			<span class="font-medium">{label}</span>
			<span class="text-muted-foreground">
				{pct}% · {formatNumber(done)}/{formatNumber(total)}
				{unit}
			</span>
		</div>
		<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
			<div class="h-full rounded-full bg-primary transition-all" style="width:{pct}%"></div>
		</div>
	</div>
{/snippet}

<!-- Overall roll-up + one bar per content type (data-driven from progress.byType).
     Shared by the active-run and idle branches so both stay in lockstep. Per-type
     bars omit a unit — the label already names the type; only Overall needs one. -->
{#snippet coverageBars()}
	{@render coverageBar(
		'Overall',
		progress.fetched,
		progress.totalResources,
		overallPct,
		'resources'
	)}
	{#each progress.byType as t (t.kind)}
		{@render coverageBar(t.label, t.fetched, t.total, pctOf(t.fetched, t.total))}
	{/each}
{/snippet}

{#snippet statusDetail(label: string, value: string)}
	<span class="flex justify-between gap-4">
		<span class="text-background/60">{label}</span>
		<span class="font-medium tabular-nums">{value}</span>
	</span>
{/snippet}

<div class="space-y-6">
	<!-- Current status ---------------------------------------------------- -->
	<Card.Root>
		<Card.Header>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<Card.Title>Sync status</Card.Title>
				<div class="flex items-center gap-2">
					<!-- One fixed-width status chip: never reflows across live/paused/stale/idle.
					     Hover/focus reveals worker id, phase, heartbeat age, and connection state. -->
					<Tooltip.Provider delayDuration={100}>
						<Tooltip.Root>
							<Tooltip.Trigger
								class="inline-flex w-24 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground"
								aria-label={workerAlert
									? `Sync status: ${status.label}. ${workerAlert}`
									: `Sync status: ${status.label}`}
							>
								<span class="relative flex h-2 w-2 shrink-0">
									{#if status.ping}
										<span
											class={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${status.dot}`}
										></span>
									{/if}
									<span class={`relative inline-flex h-2 w-2 rounded-full ${status.dot}`}></span>
								</span>
								<span class="capitalize">{status.label}</span>
							</Tooltip.Trigger>
							<Tooltip.Content class="flex min-w-44 flex-col items-stretch gap-1 text-left">
								{#if active}
									{@render statusDetail('Worker', active.workerId ?? 'unassigned')}
									{@render statusDetail('Phase', active.currentPhase ?? '—')}
									{@render statusDetail(
										'Heartbeat',
										active.heartbeatAt ? formatRelative(active.heartbeatAt) : 'never'
									)}
								{:else}
									<span class="font-medium">No active run</span>
								{/if}
								{@render statusDetail('Updates', connected ? 'live (connected)' : 'reconnecting…')}
								{#if workerAlert}
									<!-- Tooltip.Content inverts (bg-foreground): amber-300 reads on the dark
									     light-theme surface, amber-600 on the light dark-theme surface. -->
									<span
										class="mt-1 border-t border-background/20 pt-1 text-amber-300 dark:text-amber-600"
									>
										{workerAlert}
									</span>
								{/if}
							</Tooltip.Content>
						</Tooltip.Root>
					</Tooltip.Provider>

					{#if active}
						<form method="POST" action="?/control" use:enhance>
							<input type="hidden" name="runId" value={active.id} />
							{#if active.status === 'paused'}
								<input type="hidden" name="action" value="resume" />
								<Button type="submit" variant="outline" size="sm" class="w-20">Resume</Button>
							{:else}
								<input type="hidden" name="action" value="pause" />
								<Button type="submit" variant="outline" size="sm" class="w-20">Pause</Button>
							{/if}
						</form>
						<form method="POST" action="?/control" use:enhance>
							<input type="hidden" name="runId" value={active.id} />
							<input type="hidden" name="action" value="cancel" />
							<Button type="submit" variant="destructive" size="sm">Cancel</Button>
						</form>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content>
			{#if active}
				<div class="space-y-3">
					<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
						<span class="font-medium capitalize">{active.mode} run</span>
						<span class="text-muted-foreground">
							{formatNumber(active.requestsMade)} requests
							{#if active.maxPages}/ {formatNumber(active.maxPages)} cap{/if}
						</span>
						<span class="text-muted-foreground">
							running {formatDuration(active.startedAt?.getTime())}
						</span>
					</div>

					<!-- Coverage: overall roll-up + one bar per content type (data-driven) -->
					<div class="space-y-2">
						{@render coverageBars()}
						<p class="text-xs text-muted-foreground">
							{formatNumber(progress.totalResources)} discovered
							{#if recentDelta > 0}
								<span class="text-amber-600 dark:text-amber-500">
									↑ +{formatNumber(recentDelta)} — still finding new URLs (per-type totals keep growing
									until page crawling finishes)
								</span>
							{:else}
								· settling
							{/if}
						</p>
					</div>

					{#if active.currentUrl}
						<p class="truncate font-mono text-xs text-muted-foreground" title={active.currentUrl}>
							{active.currentUrl}
						</p>
					{/if}

					<div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
						{#snippet stat(label: string, value: string)}
							<div><span class="text-muted-foreground">{label}</span> {value}</div>
						{/snippet}
						{@render stat('archived', formatNumber(progress.fetched))}
						{@render stat('documents', formatNumber(progress.documents))}
						{@render stat('stored', formatBytes(progress.storedBytes))}
						{@render stat('due', formatNumber(progress.dueRemaining))}
						{@render stat('rate', ratePerMin ? `${ratePerMin}/min` : '—')}
						{@render stat('eta', etaText ?? '—')}
						{@render stat('changed', formatNumber(active.newCount + active.changedCount))}
						{@render stat('errors', formatNumber(active.errorCount))}
					</div>
				</div>
			{:else if data.lastRun}
				<div class="space-y-3">
					<p class="text-sm text-muted-foreground">
						No active run. Last run: <span class="capitalize">{data.lastRun.mode}</span>
						<Badge variant={statusVariant(data.lastRun.status)}>{data.lastRun.status}</Badge>
						· {formatRelative(data.lastRun.finishedAt)}
					</p>
					<div class="space-y-2">
						{@render coverageBars()}
					</div>
					<p class="text-xs text-muted-foreground">
						{formatNumber(progress.fetched)} archived · {formatNumber(progress.documents)} documents ·
						{formatBytes(progress.storedBytes)} stored
						{#if progress.dueRemaining > 0}· {formatNumber(progress.dueRemaining)} due{/if}
					</p>
				</div>
			{:else}
				<p class="text-sm text-muted-foreground">No runs yet. Start one below.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<!-- Currently processing: the worker's most-recent touches, enriched ---- -->
	<Card.Root>
		<Card.Header>
			<div class="flex items-center justify-between">
				<Card.Title>Currently processing</Card.Title>
				<span class="text-xs text-muted-foreground">most recently fetched</span>
			</div>
		</Card.Header>
		<Card.Content>
			{#if processing.records.length}
				<ul class="divide-y">
					{#each processing.records as r (r.id)}
						<li class="flex flex-col gap-1.5 py-3 text-sm">
							<div class="flex items-center gap-2">
								<Badge variant="outline" class="shrink-0 capitalize">{typeLabel(r.kind)}</Badge>
								<span class="min-w-0 flex-1 truncate font-medium" title={r.url}>
									{r.title || r.url}
								</span>
								<span
									class="shrink-0 text-xs tabular-nums text-muted-foreground"
									title="cache age — time since last fetched"
								>
									fetched {formatRelative(r.fetchedAt)}
								</span>
							</div>
							<div
								class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
							>
								{#if r.contentType}
									<span class="font-mono">{r.contentType}</span>
								{/if}
								<span class="flex items-center gap-1">
									current
									<Badge variant={changeVariant(r.currentOutcome ?? r.state)}>
										{r.currentOutcome ?? r.state}
									</Badge>
									{#if r.httpStatus}<span class="tabular-nums">{r.httpStatus}</span>{/if}
								</span>
								<span class="flex items-center gap-1">
									previous
									{#if r.previousOutcome}
										<Badge variant={changeVariant(r.previousOutcome)}>{r.previousOutcome}</Badge>
									{:else}
										<span>—</span>
									{/if}
								</span>
							</div>
						</li>
					{/each}
				</ul>
				{#if processing.hasMore}
					<p class="mt-2 text-xs text-muted-foreground">
						Showing the {processing.records.length} most recent · older records truncated
					</p>
				{/if}
			{:else}
				<p class="text-sm text-muted-foreground">Nothing processed yet.</p>
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
