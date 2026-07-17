<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { sourceLabel, type AnswerMode } from '$lib/chat';

	interface Props {
		answer: string;
		citations: string[];
		mode: AnswerMode;
	}

	let { answer, citations, mode }: Props = $props();

	// The mode label is the honesty surface (criterion 3): a fallback answer is
	// general knowledge (labeled but still answered), an abstention is an explicit
	// "we don't have this". `grounded` has no label (its sources speak for it).
	// Label + badge variant are keyed off `mode` here so both stay in step.
	const MODE_BADGE: Partial<
		Record<AnswerMode, { label: string; variant: 'secondary' | 'outline' }>
	> = {
		fallback: { label: "Not from the town's records", variant: 'secondary' },
		abstained: { label: 'No matching town record', variant: 'outline' }
	};
	const badge = $derived(MODE_BADGE[mode] ?? null);
</script>

<div
	class="rounded-lg border bg-card px-4 py-3 text-card-foreground"
	data-mode={mode}
	data-testid="answer-message"
>
	{#if badge}
		<Badge variant={badge.variant} class="mb-2" data-testid="mode-label">
			{badge.label}
		</Badge>
	{/if}

	<p class="whitespace-pre-wrap text-sm leading-relaxed">{answer}</p>

	{#if citations.length > 0}
		<div class="mt-3 border-t pt-3">
			<p class="mb-1 text-xs font-medium text-muted-foreground">Sources</p>
			<ul class="space-y-1">
				{#each citations as url (url)}
					<li>
						<a
							href={url}
							target="_blank"
							rel="noreferrer noopener"
							class="text-sm text-primary underline underline-offset-2 hover:no-underline"
							data-testid="citation-link"
						>
							{sourceLabel(url)}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
