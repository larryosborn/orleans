<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import type { ComponentProps } from 'svelte';
	import ParasolIcon from '@lucide/svelte/icons/parasol';
	let { ...restProps }: ComponentProps<typeof Card.Root> = $props();
</script>

<Card.Root {...restProps}>
	<Card.Header>
		<div class="flex gap-5 items-center">
			<ParasolIcon size={42} class="text-primary" />
			<div>
				<Card.Title>Orleans Massachusetts</Card.Title>
				<Card.Description>I am a town.</Card.Description>
			</div>
		</div>
	</Card.Header>
</Card.Root>
