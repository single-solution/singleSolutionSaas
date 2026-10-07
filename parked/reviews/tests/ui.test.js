/** Mode A: the display element's default renderer (structure, a11y, variants, slots, tokens only). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReviews } from '../headless/reviews.js';
import { render, styles } from '../ui/reviews.js';
import { createClient, createFakeDom, findAll, formDefinition, reviewView, summaryView } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const config = { sorts: ['newest', 'rating_high'], default_sort: 'newest', filters: ['rating', 'verified', 'photos'] };

const loaded = async (overrides = {}) => {
	const client = createClient({
		'GET /v1/ratings/itm_1': () => summaryView(),
		'GET /v1/reviews': () => ({
			items: [reviewView(), reviewView({ id: 'rev_2', body: null, title: null, reply: null, verifiedPurchase: false })],
			nextCursor: 'c',
			hasMore: true,
		}),
		'GET /v1/review-form': () => formDefinition(),
		'POST /v1/reviews': (/** @type {any} */ _q, /** @type {any} */ body) => ({
			...reviewView({ rating: body.rating }),
			status: 'pending',
		}),
		...overrides,
	});
	const element = createReviews({ config, strings, client });
	await element.actions.load('itm_1');
	return { element, client };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ui/reviews renderer', () => {
	it('renders an accessible list: summary, distribution, sort, filters, reviews, replies and "show more"', async () => {
		const { element, client } = await loaded();
		const root = render({ state: element.state(), actions: element.actions, strings, dom: createFakeDom() });
		expect(root.attributes).toMatchObject({ role: 'region', 'aria-label': 'Reviews', 'aria-busy': 'false' });
		expect(root.attributes.class).toContain('ss-reviews--list');
		expect(root.textContent).toContain('4.5 out of 5 · 2 reviews');
		expect(findAll(root, (n) => n.tag === 'progress')).toHaveLength(5);
		expect(root.textContent).toContain('Quality: 4.5 (1–5)');
		expect(root.textContent).toContain('Response from the store');
		expect(root.textContent).toContain('Verified buyer');
		const [select] = findAll(root, (n) => n.tag === 'select');
		expect(select.attributes['aria-label']).toBe('Sort by');
		select.dispatch('change', { target: { value: 'rating_high' } });
		await tick();
		expect(client.calls.at(-1)?.query.sort).toBe('rating_high');
		const toggles = findAll(root, (n) => n.attributes?.class === 'ss-reviews__filter');
		expect(toggles.map((n) => n.attributes['aria-pressed'])).toEqual(['false', 'false']);
		toggles[0].dispatch('click');
		await tick();
		expect(client.calls.at(-1)?.query['filter[verified]']).toBe(true);
		const more = findAll(root, (n) => n.tag === 'button' && n.textContent === 'Show more reviews')[0];
		more.dispatch('click');
		await tick();
		expect(client.calls.at(-1)?.query.cursor).toBe('c');
		const pressed = render({ state: element.state(), actions: element.actions, strings, dom: createFakeDom() });
		expect(findAll(pressed, (n) => n.attributes?.class === 'ss-reviews__filter')[0].attributes['aria-pressed']).toBe('true');
	});

	it('renders the stars and summary variants, slots, the empty state and loading', async () => {
		const { element } = await loaded();
		const dom = createFakeDom();
		const stars = render({ state: element.state(), actions: element.actions, strings, theme: { variant: 'stars' }, dom });
		expect(stars.attributes.class).toContain('ss-reviews--stars');
		expect(findAll(stars, (n) => n.attributes?.role === 'img')[0].attributes['aria-label']).toBe('Rated 4.5 out of 5');
		expect(stars.textContent).toContain('★★★★★');
		const summary = render({
			state: element.state(),
			actions: element.actions,
			strings,
			theme: { variant: 'summary' },
			slots: { before: dom.createTextNode('B'), after: dom.createTextNode('A') },
			dom,
		});
		expect(summary.children[0].text).toBe('B');
		expect(findAll(summary, (n) => n.tag === 'li' && n.attributes?.class === 'ss-reviews__item')).toHaveLength(0);
		const empty = { ...element.state(), reviews: [], hasMore: false, summary: null, sorts: ['newest'], filters: ['rating'] };
		expect(render({ state: empty, actions: element.actions, strings, dom }).textContent).toContain('No reviews yet.');
		expect(
			render({ state: empty, actions: element.actions, strings, slots: { empty: dom.createTextNode('Be first') }, dom })
				.textContent,
		).toContain('Be first');
		const noStars = render({ state: empty, actions: element.actions, strings, theme: { variant: 'stars' }, dom });
		expect(findAll(noStars, (n) => n.attributes?.role === 'img')[0].attributes['aria-label']).toBe('No reviews yet.');
		const loading = render({
			state: { ...element.state(), status: 'loading', loadingMore: true, error: 'oops' },
			actions: element.actions,
			strings,
			dom,
		});
		expect(loading.attributes['aria-busy']).toBe('true');
		expect(loading.textContent).toContain('Loading reviews…');
		expect(loading.textContent).toContain('oops');
		expect(findAll(loading, (n) => n.tag === 'button' && n.attributes.disabled === '')).toHaveLength(1);
		const hidden = {
			...element.state(),
			summary: summaryView({ display: { showSummary: true, showDistribution: false, showAttributes: false } }),
		};
		const plain = render({ state: hidden, actions: element.actions, strings, dom });
		expect(findAll(plain, (n) => n.tag === 'progress')).toHaveLength(0);
	});

	it('renders the write-a-review form, shows field errors and submits typed values', async () => {
		const { element, client } = await loaded();
		const dom = createFakeDom();
		const closed = render({ state: element.state(), actions: element.actions, strings, dom });
		findAll(closed, (n) => n.tag === 'button' && n.textContent === 'Write a review')[0].dispatch('click');
		await tick();
		const open = render({ state: element.state(), actions: element.actions, strings, dom });
		const [form] = findAll(open, (n) => n.tag === 'form');
		expect(form.attributes['aria-label']).toBe('Write a review');
		const selects = findAll(form, (n) => n.tag === 'select');
		expect(findAll(selects[0], (n) => n.tag === 'option')).toHaveLength(6);
		form.dispatch('submit', { preventDefault: () => {} });
		await tick();
		const invalid = render({ state: element.state(), actions: element.actions, strings, dom });
		const [invalidForm] = findAll(invalid, (n) => n.tag === 'form');
		expect(findAll(invalidForm, (n) => n.attributes?.['aria-invalid'] === 'true').length).toBeGreaterThan(0);
		expect(invalid.textContent).toContain('Please check the highlighted fields.');
		const [rating] = findAll(invalidForm, (n) => n.tag === 'select');
		const [title, name] = findAll(invalidForm, (n) => n.tag === 'input');
		const [body] = findAll(invalidForm, (n) => n.tag === 'textarea');
		rating.value = '4';
		title.value = 'Nice';
		body.value = 'Really nice product overall.';
		name.value = 'Ava Martin';
		invalidForm.dispatch('submit', {});
		await tick();
		expect(client.calls.at(-1)).toMatchObject({
			method: 'POST',
			body: {
				itemId: 'itm_1',
				rating: 4,
				title: 'Nice',
				body: 'Really nice product overall.',
				author: { name: 'Ava Martin' },
			},
		});
		const thanks = render({ state: element.state(), actions: element.actions, strings, dom });
		expect(thanks.textContent).toContain('Thank you! Your review will appear once it has been checked.');
		const submitting = {
			...element.state(),
			form: {
				...element.state().form,
				status: /** @type {const} */ ('submitting'),
				definition: formDefinition({ title: { enabled: false, required: false, maxLength: 0 } }),
			},
		};
		const busy = render({ state: submitting, actions: element.actions, strings, dom });
		expect(findAll(busy, (n) => n.tag === 'button' && n.attributes.type === 'submit')[0].attributes.disabled).toBe('');
		expect(findAll(busy, (n) => n.tag === 'input')).toHaveLength(1);
		findAll(busy, (n) => n.tag === 'button' && n.textContent === 'Cancel')[0].dispatch('click');
		expect(element.state().form.open).toBe(false);
		const readOnly = render({ state: { ...element.state(), canWrite: false }, actions: element.actions, strings, dom });
		expect(findAll(readOnly, (n) => n.tag === 'button' && n.textContent === 'Write a review')).toHaveLength(0);
		const noted = { ...element.state(), form: { ...element.state().form, open: false, message: 'Sign in to write a review.' } };
		expect(render({ state: noted, actions: element.actions, strings, dom }).textContent).toContain(
			'Sign in to write a review.',
		);
	});

	it('uses design tokens only', () => {
		expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
		expect(styles).toMatch(/var\(--ss-color-primary\)/);
	});
});
