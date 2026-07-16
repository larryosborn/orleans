<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { formatBytes, formatNumber, formatRelative } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function pageHref(n: number): string {
		const params: [string, string][] = [];
		if (data.filters.q) params.push(['q', data.filters.q]);
		if (data.filters.kind) params.push(['kind', data.filters.kind]);
		if (data.filters.state) params.push(['state', data.filters.state]);
		params.push(['page', String(n)]);
		return '?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
	}
</script>

<h1 class="mb-4 text-lg font-semibold">Content</h1>

<form method="GET" class="mb-4 flex flex-wrap items-end gap-3">
	<label class="flex flex-col gap-1 text-xs">
		<span class="text-muted-foreground">Search URL / title</span>
		<input
			name="q"
			value={data.filters.q}
			placeholder="e.g. agenda"
			class="h-9 w-56 rounded-md border bg-background px-3 text-sm"
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		<span class="text-muted-foreground">Kind</span>
		<select name="kind" class="h-9 rounded-md border bg-background px-3 text-sm">
			<option value="" selected={data.filters.kind === ''}>all</option>
			<option value="page" selected={data.filters.kind === 'page'}>page</option>
			<option value="document" selected={data.filters.kind === 'document'}>document</option>
		</select>
	</label>
	<label class="flex flex-col gap-1 text-xs">
		<span class="text-muted-foreground">State</span>
		<select name="state" class="h-9 rounded-md border bg-background px-3 text-sm">
			<option value="" selected={data.filters.state === ''}>all</option>
			<option value="active" selected={data.filters.state === 'active'}>active</option>
			<option value="gone" selected={data.filters.state === 'gone'}>gone</option>
			<option value="error" selected={data.filters.state === 'error'}>error</option>
		</select>
	</label>
	<Button type="submit" variant="outline">Filter</Button>
	<span class="pb-2 text-xs text-muted-foreground">{formatNumber(data.total)} resources</span>
</form>

<div class="rounded-lg border bg-background">
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Title / URL</Table.Head>
				<Table.Head>Kind</Table.Head>
				<Table.Head>State</Table.Head>
				<Table.Head class="text-right">Size</Table.Head>
				<Table.Head class="text-right">Changed</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each data.rows as r (r.id)}
				<Table.Row>
					<Table.Cell class="max-w-md">
						<div class="truncate font-medium" title={r.title ?? ''}>{r.title || '—'}</div>
						<a
							href={r.url}
							target="_blank"
							rel="noreferrer"
							class="block truncate font-mono text-xs text-muted-foreground hover:underline"
							title={r.url}
						>
							{r.url}
						</a>
						{#if r.sha256}
							<a
								href={`/dashboard/blob/${r.id}`}
								target="_blank"
								rel="noreferrer"
								class="text-xs text-primary hover:underline"
							>
								view archived copy ↗
							</a>
						{/if}
					</Table.Cell>
					<Table.Cell><Badge variant="outline">{r.kind}</Badge></Table.Cell>
					<Table.Cell>
						<Badge
							variant={r.state === 'gone' || r.state === 'error' ? 'destructive' : 'secondary'}
						>
							{r.state}
						</Badge>
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{formatBytes(r.sizeBytes)}</Table.Cell>
					<Table.Cell class="text-right text-muted-foreground">
						{formatRelative(r.lastChangedAt ?? r.lastFetchedAt)}
					</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row>
					<Table.Cell colspan={5} class="text-center text-muted-foreground">
						No resources match.
					</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>

{#if data.pages > 1}
	<div class="mt-4 flex items-center justify-between text-sm">
		<span class="text-muted-foreground">Page {data.pageNum} of {data.pages}</span>
		<div class="flex gap-2">
			{#if data.pageNum > 1}
				<Button href={pageHref(data.pageNum - 1)} variant="outline" size="sm">Previous</Button>
			{/if}
			{#if data.pageNum < data.pages}
				<Button href={pageHref(data.pageNum + 1)} variant="outline" size="sm">Next</Button>
			{/if}
		</div>
	</div>
{/if}
