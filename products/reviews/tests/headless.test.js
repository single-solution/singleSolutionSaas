/** Mode B: the display element's headless core (state machine, actions, validation, strings) on a scripted client. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createReviews } from '../headless/reviews.js';
import { createTranslator } from '../headless/strings.js';
import { createClient, formDefinition, reviewView, summaryView } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));
const config = {
	sorts: ['newest', 'rating_high'],
	default_sort: 'newest',
	filters: ['rating', 'verified', 'photos'],
	page_size: 2,
};

/** @param {Record<string, (query: any, body?: any) => any>} [overrides] */
const routes = (overrides = {}) => ({
	'GET /v1/ratings/itm_1': () => summaryView(),
	'GET /v1/reviews': (/** @type {any} */ query) =>
		query.cursor
			? {
					items: [reviewView({ id: 'rev_3', rating: 3, reply: null, verifiedPurchase: false, author: null })],
					nextCursor: null,
					hasMore: false,
				}
			: {
					items: [reviewView(), reviewView({ id: 'rev_2', rating: 4, removed: true, body: null })],
					nextCursor: 'c1',
					hasMore: true,
				},
	'GET /v1/review-form': () => formDefinition(),
	'GET /v1/ratings': (/** @type {any} */ query) => ({
		items: query.itemIds.split(',').map((/** @type {string} */ itemId) => ({
			itemId,
			count: itemId === 'itm_1' ? 2 : 0,
			average: itemId === 'itm_1' ? 4.5 : 0,
			scale: 5,
		})),
	}),
	'POST /v1/reviews': (/** @type {any} */ _q, /** @type {any} */ body) => ({
		...reviewView({ id: 'rev_new', rating: body.rating }),
		status: 'pending',
	}),
	...overrides,
});

describe('headless/reviews', () => {
	it('loads the summary and the first page, then sorts, filters and pages', async () => {
		/** @type {Array<{ name: string, data: any }>} */
		const events = [];
		const client = createClient(routes());
		const element = createReviews({ config, strings, client, emit: (name, data) => events.push({ name, data }) });
		/** @type {string[]} */
		const seen = [];
		const off = element.subscribe((state) => seen.push(state.status));
		expect(element.state()).toMatchObject({
			status: 'idle',
			sort: 'newest',
			canWrite: true,
			filters: ['rating', 'verified', 'photos'],
		});
		const loaded = await element.actions.load('itm_1');
		expect(loaded.ok).toBe(true);
		const state = element.state();
		expect(state).toMatchObject({
			status: 'ready',
			itemId: 'itm_1',
			countText: '2 reviews',
			averageText: '4.5 out of 5',
			hasMore: true,
			cursor: 'c1',
		});
		expect(state.reviews[0]).toMatchObject({
			authorText: 'Ava M.',
			ratingText: '5 out of 5 stars',
			dateText: 'Oct 1, 2026',
			verified: true,
		});
		expect(state.reviews[0]?.attributes).toEqual([{ key: 'quality', label: 'Quality', value: 5 }]);
		expect(state.reviews[1]?.removed).toBe(true);
		expect(Object.isFrozen(state)).toBe(true);
		expect(events).toEqual([{ name: 'viewed', data: { itemId: 'itm_1', count: 2 } }]);
		expect(client.calls.find((call) => call.path === '/v1/reviews')?.query).toMatchObject({
			'filter[itemId]': 'itm_1',
			sort: 'newest',
			limit: 2,
		});

		await element.actions.loadMore();
		expect(element.state().reviews.map((review) => review.id)).toEqual(['rev_1', 'rev_2', 'rev_3']);
		expect(element.state().reviews[2]?.authorText).toBe('Anonymous');
		expect((await element.actions.loadMore()).ok).toBe(false);

		await element.actions.setSort('rating_high');
		expect(client.calls.at(-1)?.query.sort).toBe('rating_high');
		expect((await element.actions.setSort('oldest')).ok).toBe(false);
		await element.actions.setFilter('verified', true);
		expect(client.calls.at(-1)?.query['filter[verified]']).toBe(true);
		await element.actions.setFilter('rating', 5);
		expect(client.calls.at(-1)?.query['filter[rating]']).toBe(5);
		const limited = createReviews({ config: { ...config, filters: [] }, strings, client });
		expect((await limited.actions.setFilter('photos', true)).ok).toBe(false);
		off();
		expect(seen).toContain('loading');
		element.destroy();
		await element.actions.load('itm_1');
		expect(element.state().status).toBe('ready'); // no updates after destroy
	});

	it('loads a store-wide list without an item, and stars for product lists', async () => {
		const client = createClient(routes());
		const element = createReviews({ config: {}, strings, client });
		expect(element.state().sorts).toEqual(['newest']);
		await element.actions.load();
		expect(element.state()).toMatchObject({ status: 'ready', summary: null, countText: null });
		expect((await element.actions.loadStars([])).ok).toBe(true);
		await element.actions.loadStars(['itm_1', 'itm_2', 'itm_1']);
		expect(element.state().stars).toEqual({
			itm_1: { average: 4.5, count: 2, scale: 5, text: 'Rated 4.5 out of 5' },
			itm_2: { average: 0, count: 0, scale: 5, text: 'No reviews yet.' },
		});
		expect(client.calls.at(-1)?.query.itemIds).toBe('itm_1,itm_2');
		expect(element.countText(1)).toBe('1 review');
		expect(createTranslator({ a: 'Hi {name} {missing}' })('a', { name: 'Bo' })).toBe('Hi Bo {missing}');
		expect(createTranslator({})('unknown.key')).toBe('unknown.key');
	});

	it('reports load errors with user-facing messages', async () => {
		const failing = createReviews({
			config,
			strings,
			client: createClient(routes({ 'GET /v1/ratings/itm_1': () => ({ error: { code: 'network_error' } }) })),
		});
		await failing.actions.load('itm_1');
		expect(failing.state()).toMatchObject({ status: 'error', error: 'Reviews could not be loaded. Please try again.' });
		const listFails = createReviews({
			config,
			strings,
			client: createClient(routes({ 'GET /v1/reviews': () => ({ error: { code: 'element_disabled' } }) })),
		});
		await listFails.actions.load('itm_1');
		expect(listFails.state().status).toBe('error');
		const empty = createReviews({
			config,
			strings,
			client: createClient(
				routes({
					'GET /v1/ratings/itm_1': () => summaryView({ count: 0, average: 0 }),
					'GET /v1/reviews': () => ({ items: [] }),
				}),
			),
		});
		await empty.actions.load('itm_1');
		expect(empty.state()).toMatchObject({ averageText: null, reviews: [], hasMore: false, cursor: null });
	});

	it('opens the form, validates like the API, submits and reloads published reviews', async () => {
		/** @type {Array<{ name: string, data: any }>} */
		const events = [];
		const client = createClient(
			routes({ 'POST /v1/reviews': (_q, body) => ({ ...reviewView({ rating: body.rating }), status: 'approved' }) }),
		);
		const element = createReviews({ config, strings, client, emit: (name, data) => events.push({ name, data }) });
		expect(element.validate({ rating: 9 })).toEqual([]); // nothing to check before the form is loaded
		await element.actions.load('itm_1');
		await element.actions.openForm();
		expect(element.state().form).toMatchObject({ open: true, status: 'idle', definition: { ratingScale: 5 } });
		await element.actions.openForm(); // cached definition
		expect(client.calls.filter((call) => call.path === '/v1/review-form')).toHaveLength(1);
		const problems = element.validate({ rating: 6, body: 'short' });
		expect(problems.map((p) => `${p.path}:${p.code}:${p.message}`)).toEqual([
			'/rating:rating_invalid:Please check this value',
			'/body:too_short:Too short (at least 10 characters)',
		]);
		const invalid = await element.actions.submit({ rating: 0 });
		expect(invalid.ok).toBe(false);
		expect(element.state().form).toMatchObject({ status: 'error', message: 'Please check the highlighted fields.' });
		expect(element.state().form.errors.map((e) => e.message)).toContain('Required');
		const done = await element.actions.submit({ rating: 5, body: 'Works perfectly, thanks.', title: '' });
		expect(done.ok).toBe(true);
		expect(client.calls.find((call) => call.method === 'POST')?.body).toEqual({
			itemId: 'itm_1',
			rating: 5,
			body: 'Works perfectly, thanks.',
		});
		expect(element.state().form).toMatchObject({ status: 'submitted', message: 'Thank you! Your review is published.' });
		expect(events.map((e) => e.name)).toEqual(['viewed', 'submitted', 'viewed']);
		element.actions.closeForm();
		expect(element.state().form.open).toBe(false);
	});

	it('maps submission problems and pending moderation', async () => {
		const pending = createReviews({ config, strings, client: createClient(routes()) });
		await pending.actions.load('itm_1');
		await pending.actions.openForm();
		await pending.actions.submit({ rating: 4, body: 'Pretty good indeed.' });
		expect(pending.state().form.message).toBe('Thank you! Your review will appear once it has been checked.');
		for (const [code, text] of [
			['not_verified', 'Only customers who bought this item can review it.'],
			['identity_required', 'Sign in to write a review.'],
			['server_error', 'Your review could not be sent. Please try again.'],
		]) {
			const element = createReviews({
				config,
				strings,
				client: createClient(
					routes({
						'POST /v1/reviews': () => ({
							error: { code, errors: code === 'server_error' ? [{ path: '/body', code: 'too_long' }] : undefined },
						}),
					}),
				),
			});
			await element.actions.load('itm_1');
			await element.actions.openForm();
			const result = await element.actions.submit({ rating: 4, body: 'Pretty good indeed.' });
			expect(result.ok).toBe(false);
			expect(element.state().form.message).toBe(text);
			if (code === 'server_error') expect(element.state().form.errors[0]?.message).toBe('Too long');
		}
		const noWrite = createReviews({ config: { ...config, allow_submit: false }, strings, client: createClient(routes()) });
		expect((await noWrite.actions.openForm()).ok).toBe(false);
		const brokenForm = createReviews({
			config,
			strings,
			client: createClient(routes({ 'GET /v1/review-form': () => ({ error: { code: 'element_disabled' } }) })),
		});
		await brokenForm.actions.openForm();
		expect(brokenForm.state().form).toMatchObject({ status: 'error', definition: null });
		const withAttributes = createReviews({
			config,
			strings,
			client: createClient(
				routes({
					'GET /v1/review-form': () =>
						formDefinition({
							title: { enabled: false, required: false, maxLength: 0 },
							attributes: [{ key: 'fit', label: 'Fit', min: 1, max: 3, required: true }],
							photos: { enabled: true, max: 1, maxBytes: 10, types: ['image/png'] },
						}),
				}),
			),
		});
		await withAttributes.actions.load('itm_1');
		await withAttributes.actions.openForm();
		expect(
			withAttributes.validate({ rating: 3, body: 'Long enough text', title: 'x', photoIds: ['a', 'b'] }).map((p) => p.code),
		).toEqual(['title_not_allowed', 'photos_invalid', 'required']);
		expect(withAttributes.validate('nope')[0]?.code).toBe('required');
	});
});
