// Component test for the answer bubble (#38). Verifies the honesty surface:
// grounded answers show clickable sources (criterion 2), fallback/abstained
// answers show their mode label (criterion 3).
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { expect, test } from 'vitest';
import AnswerMessage from './answer-message.svelte';

test('grounded answer renders clickable source links, no mode label', async () => {
	render(AnswerMessage, {
		answer: 'The harbor budget is $1.2M.',
		citations: ['https://orleans.example/budget/harbor', 'https://orleans.example/minutes'],
		mode: 'grounded'
	});

	const links = page.getByTestId('citation-link');
	await expect.element(links.first()).toBeInTheDocument();
	await expect
		.element(links.first())
		.toHaveAttribute('href', 'https://orleans.example/budget/harbor');
	expect((await links.all()).length).toBe(2);
	expect(await page.getByTestId('mode-label').query()).toBeNull();
});

test('fallback answer is labeled "not from the town\'s records"', async () => {
	render(AnswerMessage, {
		answer: "This is not from the town's records: a select board is a governing body.",
		citations: [],
		mode: 'fallback'
	});

	await expect
		.element(page.getByTestId('mode-label'))
		.toHaveTextContent(/not from the town's records/i);
	expect(await page.getByTestId('citation-link').query()).toBeNull();
});

test('abstained answer shows a distinct "no matching town record" label', async () => {
	render(AnswerMessage, {
		answer: "That isn't in the town's records. Check with the Town Clerk.",
		citations: [],
		mode: 'abstained'
	});

	await expect
		.element(page.getByTestId('mode-label'))
		.toHaveTextContent(/no matching town record/i);
});
