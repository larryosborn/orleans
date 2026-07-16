<script lang="ts">
	import * as Table from '$lib/components/ui/table/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { formatBytes, formatNumber, formatRelative, formatDuration } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (s === 'running' || s === 'paused') return 'default';
		if (s === 'failed') return 'destructive';
		if (s === 'completed') return 'secondary';
		return 'outline';
	}
</script>

<h1 class="mb-4 text-lg font-semibold">Runs</h1>

<div class="rounded-lg border bg-background">
	<Table.Root>
		<Table.Header>
			<Table.Row>
				<Table.Head>Mode</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head class="text-right">Pages</Table.Head>
				<Table.Head class="text-right">Docs</Table.Head>
				<Table.Head class="text-right">New/Chg</Table.Head>
				<Table.Head class="text-right">Errors</Table.Head>
				<Table.Head class="text-right">Bytes</Table.Head>
				<Table.Head class="text-right">Duration</Table.Head>
				<Table.Head>When</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each data.runs as r (r.id)}
				<Table.Row
					class="cursor-pointer"
					onclick={() => (window.location.href = `/dashboard/runs/${r.id}`)}
				>
					<Table.Cell class="font-medium capitalize">{r.mode}</Table.Cell>
					<Table.Cell><Badge variant={statusVariant(r.status)}>{r.status}</Badge></Table.Cell>
					<Table.Cell class="text-right tabular-nums">{formatNumber(r.pages)}</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{formatNumber(r.documents)}</Table.Cell>
					<Table.Cell class="text-right tabular-nums">
						{formatNumber(r.newCount)}/{formatNumber(r.changedCount)}
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">{formatNumber(r.errorCount)}</Table.Cell>
					<Table.Cell class="text-right tabular-nums">
						{formatBytes(r.bytesDownloaded || r.bytesEstimated)}
					</Table.Cell>
					<Table.Cell class="text-right tabular-nums">
						{formatDuration(r.startedAt?.getTime(), r.finishedAt?.getTime())}
					</Table.Cell>
					<Table.Cell class="text-muted-foreground">{formatRelative(r.requestedAt)}</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row>
					<Table.Cell colspan={9} class="text-center text-muted-foreground">No runs yet.</Table.Cell
					>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>
