<script lang="ts">
	import { enhance, applyAction } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import AnswerMessage from '$lib/components/chat/answer-message.svelte';
	import type { AskResult, ChatTurn } from '$lib/chat';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();

	// Session-scoped history only — no persistence (v1). Reloading the page starts
	// a fresh conversation, by design.
	let history = $state<ChatTurn[]>([]);
	let question = $state('');
	// The question currently in flight (also drives the "Thinking…" placeholder).
	let pending = $state<string | null>(null);
	// Client-side error surface. `form` (below) is the no-JS fallback — with JS,
	// our enhance callback owns errors and never calls `update`, so `form` stays
	// null and the two paths never both render.
	let errorMsg = $state<string | null>(null);
	let idSeq = 0;

	// No-JS fallback only: after a non-enhanced POST, `form` carries the one result.
	// The `in` narrowing on SvelteKit's ActionData union widens props to
	// `T | undefined`, so pin the success shape here for the template.
	const noJsAnswer = $derived(form && 'answer' in form ? (form as AskResult) : null);
	const noJsError = $derived(form && 'error' in form ? String(form.error) : null);

	let scrollEl = $state<HTMLDivElement | null>(null);
	$effect(() => {
		// Reading these tracks them as deps, so the effect re-runs (and scrolls to
		// the newest message) whenever a turn is added or a request goes in/out of
		// flight.
		const messageCount = history.length + (pending ? 1 : 0);
		if (messageCount > 0) {
			scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
		}
	});

	const submit: SubmitFunction = ({ formData, cancel }) => {
		const q = String(formData.get('question') ?? '').trim();
		if (!q || pending) {
			cancel();
			return;
		}
		pending = q;
		errorMsg = null;

		return async ({ result }) => {
			pending = null;
			if (result.type === 'success' && result.data) {
				const d = result.data as AskResult;
				history.push({ id: idSeq++, ...d });
				question = '';
			} else if (result.type === 'failure') {
				errorMsg = (result.data?.error as string) ?? 'Something went wrong. Please try again.';
			} else {
				await applyAction(result);
			}
		};
	};

	function onKeydown(event: KeyboardEvent) {
		// Enter submits; Shift+Enter inserts a newline.
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			(event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
		}
	}
</script>

<svelte:head>
	<title>Ask · Town of Orleans</title>
</svelte:head>

<!-- One user-question bubble, rendered for history turns, the no-JS result, and
     the in-flight question — so its styling lives in exactly one place. -->
{#snippet questionBubble(text: string)}
	<p
		class="ml-auto w-fit max-w-[85%] rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
	>
		{text}
	</p>
{/snippet}

<!-- One question→answer exchange. Shared by the JS history path and the no-JS
     fallback so there's a single render for a completed turn. -->
{#snippet turn(t: AskResult)}
	<div class="space-y-2">
		{@render questionBubble(t.question)}
		<AnswerMessage answer={t.answer} citations={t.citations} mode={t.mode} />
	</div>
{/snippet}

<div class="mx-auto flex h-[calc(100vh-2rem)] max-w-3xl flex-col gap-4 p-4">
	<header>
		<h1 class="text-xl font-semibold">Ask the town archive</h1>
		<p class="text-sm text-muted-foreground">
			Answers come from the Town of Orleans' own archived records. Anything not in the archive is
			labeled as such.
		</p>
	</header>

	<div
		bind:this={scrollEl}
		class="flex-1 space-y-4 overflow-y-auto rounded-lg border bg-muted/30 p-4"
		data-testid="conversation"
	>
		{#if history.length === 0 && !pending}
			<p class="pt-8 text-center text-sm text-muted-foreground">
				Ask a question to get started — for example, "What did the Select Board decide about the
				harbor?"
			</p>
		{/if}

		{#each history as t (t.id)}
			{@render turn(t)}
		{/each}

		<!-- No-JS fallback: `form` is only populated after a non-enhanced POST, so
		     this never double-renders alongside client-managed history (see above). -->
		{#if noJsAnswer}
			{@render turn(noJsAnswer)}
		{/if}

		{#if pending}
			<div class="space-y-2">
				{@render questionBubble(pending)}
				<p class="text-sm text-muted-foreground" data-testid="pending">Thinking…</p>
			</div>
		{/if}
	</div>

	{#if errorMsg}
		<p class="text-sm text-destructive" role="alert" data-testid="error">{errorMsg}</p>
	{:else if noJsError}
		<p class="text-sm text-destructive" role="alert" data-testid="error">{noJsError}</p>
	{/if}

	<form method="POST" action="?/ask" use:enhance={submit} class="flex items-end gap-2">
		<Textarea
			name="question"
			bind:value={question}
			onkeydown={onKeydown}
			placeholder="Ask about the Town of Orleans…"
			rows={2}
			class="resize-none"
			aria-label="Your question"
		/>
		<Button type="submit" disabled={!question.trim() || !!pending}>Ask</Button>
	</form>
</div>
