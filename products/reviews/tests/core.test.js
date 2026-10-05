/** Pure core: text, validation, moderation, rollups, requests, orders, structured data, CSV, sorting, analytics, time. */
import { describe, expect, it } from 'vitest';
import { analyticsRange, assembleAnalytics } from '../core/analytics.js';
import { defaultsOf, effectiveConfig } from '../core/config.js';
import { mapImportRows, parseCsv } from '../core/csv.js';
import { contentChecks, decide, moderationContext } from '../core/moderation.js';
import { orderFacts, uniqueLines } from '../core/orders.js';
import { averageOf, emptyRollup, round1, starsView, summaryView } from '../core/ratings.js';
import {
	afterFailure,
	afterSent,
	buildRequest,
	itemEligibility,
	nextStep,
	pendingItems,
	pickChannel,
	reviewUrl,
} from '../core/requests.js';
import { buildReview, dedupeKeyOf, submissionRefusal } from '../core/reviews.js';
import { checkCondition, compileCondition, conditionMatches } from '../core/rules.js';
import { afterFilter, cursorOf, pickSort, sortSpec } from '../core/sort.js';
import { aggregateRatingNode, compact, productJsonLd, reviewNode, selectReviews } from '../core/structured.js';
import { countLinks, displayName, findBlockedTerms, sanitizeText, singleLine, words } from '../core/text.js';
import { bucketKey, bucketKeys, dayKey, inWindow, isTimeZone, isoOrNull, localParts, parseClock, toMs } from '../core/time.js';
import {
	checkFields,
	validateAnswer,
	validateApprove,
	validateImport,
	validateModerationCheck,
	validatePhotoUpload,
	validateQuestion,
	validateReject,
	validateReply,
	validateRequestInput,
	validateReview,
	validateToken,
} from '../core/validate.js';
import { customerRequestView, formView, ownerReview, publicReview, questionView, requestView } from '../core/views.js';
import moderationSchema from '../schemas/moderation.features.json' with { type: 'json' };

const T0 = Date.parse('2026-10-01T10:00:00Z');
const DAY = 86_400_000;
/** @type {import('../core/validate.js').ContentLimits} */
const CONTENT = {
	rating_scale: 5,
	title_max_length: 20,
	title_required: false,
	body_required: true,
	body_min_length: 5,
	body_max_length: 50,
	author_name_max_length: 20,
	attributes: [{ key: 'fit', label: 'Fit', min: -2, max: 2, required: false }],
};
/** @type {import('../core/moderation.js').ModerationSettings} */
const MODERATION = /** @type {any} */ (effectiveConfig(moderationSchema, {}));

describe('text', () => {
	it('sanitises customer text and counts links', () => {
		expect(sanitizeText('  a‮b <b>bold</b> <x\r\n\r\n\r\n\r\nend  ', 100)).toBe('ab bold x\n\nend');
		expect(sanitizeText(42, 10)).toBe('');
		expect(sanitizeText('abcdef', 3)).toBe('abc');
		expect(singleLine('a\nb', 10)).toBe('a b');
		expect(countLinks('see https://x.example and www.y.example, not y.example')).toBe(2);
	});

	it('finds blocked terms on word boundaries in any script', () => {
		expect(findBlockedTerms('This is AWFUL, a total scam.', ['awful', 'total scam', 'sca', ''])).toEqual([
			'awful',
			'total scam',
		]);
		expect(findBlockedTerms('Größe passt', ['größe'])).toEqual(['größe']);
		expect(findBlockedTerms('とても悪い商品', ['悪い'])).toEqual(['悪い']);
		expect(findBlockedTerms('', ['x'])).toEqual([]);
		expect(findBlockedTerms('x', [])).toEqual([]);
		expect(findBlockedTerms('a b c d e f g h i j k l', 'abcdefghijkl'.split(''))).toHaveLength(10);
		expect(words('Hello, World!')).toEqual(['hello', 'world']);
	});

	it('builds public names in every format', () => {
		expect(displayName('Ayesha  Khan', 'first_name_initial')).toBe('Ayesha K.');
		expect(displayName('Ayesha Khan', 'first_name')).toBe('Ayesha');
		expect(displayName('Ayesha Bibi Khan', 'full_name')).toBe('Ayesha Bibi Khan');
		expect(displayName('ayesha khan', 'initials')).toBe('A. K.');
		expect(displayName('Cher', 'initials')).toBe('C.');
		expect(displayName('Cher', 'first_name_initial')).toBe('Cher');
		expect(displayName('', 'first_name')).toBeNull();
		expect(displayName(null, 'first_name')).toBeNull();
	});
});

describe('validate', () => {
	it('validates and normalises review submissions', () => {
		const { problems, value } = validateReview(
			{
				itemId: 'itm_1',
				rating: 4,
				title: ' Good\nfit ',
				body: '<i>Nice</i> one',
				attributes: { fit: 1 },
				author: { name: 'Ava', email: 'ava@example.com' },
				locale: 'en-GB',
				custom: { size: 'M', ok: true, n: 1, none: null },
				orderId: 'ord_1',
				customerId: 'cus_1',
				externalId: 'ext_1',
			},
			{ content: CONTENT, maxPhotos: null, server: true },
		);
		expect(problems).toEqual([]);
		expect(value).toMatchObject({
			title: 'Good fit',
			body: 'Nice one',
			author: { name: 'Ava', email: 'ava@example.com' },
			customerId: 'cus_1',
			externalId: 'ext_1',
			photoIds: [],
		});
		const bad = validateReview(
			{
				itemId: 'bad id',
				rating: 6,
				title: 'x'.repeat(30),
				body: 'abc',
				attributes: { fit: 5, size: 1 },
				photoIds: ['a', 'a'],
				author: { name: '', email: 'nope' },
				locale: 'EN',
				custom: { 'bad-key': 1 },
				customerId: 'cus',
				extra: true,
			},
			{ content: CONTENT, maxPhotos: 3, server: false },
		);
		expect(bad.value).toBeNull();
		expect(bad.problems.map((p) => `${p.path}:${p.code}`).sort()).toEqual(
			[
				'/itemId:id_invalid',
				'/rating:rating_invalid',
				'/title:too_long',
				'/body:too_short',
				'/attributes/fit:attribute_invalid',
				'/attributes/size:unknown_attribute',
				'/photoIds:photos_invalid',
				'/author/name:name_invalid',
				'/author/email:email_invalid',
				'/locale:locale_invalid',
				'/custom:custom_invalid',
				'/customerId:unknown_field',
				'/extra:unknown_field',
			].sort(),
		);
		expect(validateReview(null, { content: CONTENT, maxPhotos: null, server: false }).problems).toEqual([
			{ path: '', code: 'body_invalid' },
		]);
		const strict = {
			...CONTENT,
			title_required: true,
			title_max_length: 0,
			attributes: [{ key: 'fit', label: 'Fit', min: 1, max: 2, required: true }],
		};
		expect(
			validateReview(
				{ itemId: 'i', rating: 1, body: 'long enough', title: 'x' },
				{ content: strict, maxPhotos: null, server: false },
			).problems.map((p) => p.code),
		).toEqual(['title_not_allowed', 'required']);
		expect(
			validateReview(
				{ itemId: 'i', rating: 1, body: '   ', photoIds: 'x', attributes: [], custom: [], token: 5 },
				{ content: CONTENT, maxPhotos: 2, server: false },
			).problems.map((p) => p.code),
		).toEqual(['text_empty', 'attributes_invalid', 'photos_invalid', 'custom_invalid', 'token_invalid']);
		expect(
			validateReview(
				{
					itemId: 'i',
					rating: 1,
					body: 'fine body',
					photoIds: ['p1', 'bad id'],
					custom: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 1])),
				},
				{ content: CONTENT, maxPhotos: 3, server: false },
			).problems.map((p) => p.code),
		).toEqual(['photos_invalid', 'custom_invalid']);
		expect(
			validateReview(
				{ itemId: 'i', rating: 1, body: 'fine body', custom: { a: { nested: 1 } }, photoIds: ['a', 'b', 'c', 'd'] },
				{ content: CONTENT, maxPhotos: 3, server: false },
			).problems.map((p) => p.code),
		).toEqual(['photos_invalid', 'custom_invalid']);
		expect(
			validateReview(
				{ itemId: 'i', rating: 1, title: 5, body: 'fine body' },
				{ content: CONTENT, maxPhotos: null, server: false },
			).problems[0]?.code,
		).toBe('text_invalid');
	});

	it('validates the other bodies', () => {
		expect(
			validateRequestInput({
				orderId: 'o',
				customerId: 'c',
				items: [{ itemId: 'i', sku: 'S', title: 'T', variantId: 'v' }],
				contact: { name: 'N', email: 'a@b.c', phone: '+4915112345678' },
				number: '1',
				completedAt: '2026-10-01T00:00:00Z',
				locale: 'en',
			}),
		).toEqual([]);
		expect(
			validateRequestInput({
				orderId: 'o',
				customerId: 'c',
				items: [{ sku: 1 }],
				contact: { phone: '123' },
				number: '',
				completedAt: 'x',
			}).map((p) => `${p.path}:${p.code}`),
		).toEqual([
			'/number:text_invalid',
			'/contact/phone:phone_invalid',
			'/items/0/itemId:required',
			'/items/0/sku:text_invalid',
			'/completedAt:date_invalid',
		]);
		expect(validateRequestInput({ orderId: 'o', customerId: 'c', items: [] })[0]?.code).toBe('items_invalid');
		expect(validateReject({ reason: 'spam', note: 'x' }, ['spam'])).toEqual([]);
		expect(validateReject({ reason: 'other' }, ['spam'])[0]?.code).toBe('reason_invalid');
		expect(validateApprove(undefined)).toEqual([]);
		expect(validateApprove({ note: '' })[0]?.code).toBe('text_empty');
		expect(validateReply({ body: 'x'.repeat(11) }, 10)[0]?.code).toBe('too_long');
		expect(validateQuestion({ itemId: 'i', body: 'Why?', customerId: 'c' }, { maxLength: 10, server: true })).toEqual([]);
		expect(validateQuestion({ itemId: 'i', body: 'Hi' }, { maxLength: 10, server: false })[0]?.code).toBe('too_short');
		expect(validateAnswer({ body: 'Yes', author: { name: 'A' } }, { maxLength: 10, server: false })).toEqual([]);
		expect(
			validatePhotoUpload(
				{ contentType: 'image/png', size: 5, token: 't' },
				{ allowedTypes: ['image/png'], maxBytes: 10, server: false },
			),
		).toEqual([]);
		expect(
			validatePhotoUpload(
				{ contentType: 'image/gif', size: 50, customerId: 'c' },
				{ allowedTypes: ['image/png'], maxBytes: 10, server: true },
			).map((p) => p.code),
		).toEqual(['type_not_allowed', 'size_invalid']);
		expect(validateImport({ csv: '', dryRun: 'yes' }).map((p) => p.code)).toEqual(['csv_invalid', 'boolean_invalid']);
		expect(validateModerationCheck({ source: 'a' })).toEqual([]);
		expect(validateModerationCheck({}).map((p) => p.path)).toEqual(['/source']);
		expect(validateModerationCheck({ source: 1, review: [] }).map((p) => p.code)).toEqual(['text_invalid', 'object_invalid']);
		expect(validateToken({ token: '' })[0]?.code).toBe('token_invalid');
		expect(checkFields({ a: 1 }, { a: () => [{ path: '/x', code: 'nested' }] }, [], '/base')).toEqual([
			{ path: '/base/a/x', code: 'nested' },
		]);
	});
});

describe('moderation', () => {
	const review = { rating: 5, title: 'Great', body: 'Really good product, works.', verified: true, photos: 0 };
	const context = (r = review) => moderationContext({ review: { ...r, itemId: 'itm', scale: 5 }, flags: [] });

	it('approves clean verified reviews with the default rule and queues unverified ones', () => {
		expect(decide({ review, settings: MODERATION, context: context(), now: T0, timeZone: 'UTC' })).toMatchObject({
			status: 'approved',
			by: 'rule',
			ruleId: 'verified_clean',
		});
		const unverified = { ...review, verified: false };
		expect(
			decide({ review: unverified, settings: MODERATION, context: context(unverified), now: T0, timeZone: 'UTC' }),
		).toMatchObject({ status: 'pending', by: 'default' });
		const approveAll = { ...MODERATION, rules: [], default_action: /** @type {const} */ ('approve') };
		expect(
			decide({ review: unverified, settings: approveAll, context: context(unverified), now: T0, timeZone: 'UTC' }),
		).toMatchObject({ status: 'pending', by: 'unverified', reason: 'unverified' });
		expect(
			decide({
				review: unverified,
				settings: { ...approveAll, auto_approve_unverified: true },
				context: context(unverified),
				now: T0,
				timeZone: 'UTC',
			}),
		).toMatchObject({ status: 'approved', by: 'default' });
		expect(decide({ review, settings: null, context: {}, now: T0, timeZone: 'UTC' })).toMatchObject({
			status: 'approved',
			by: 'off',
		});
	});

	it('runs the content checks before any rule', () => {
		const settings = { ...MODERATION, blocked_terms: ['junk'], max_links: 0, queue_shorter_than: 50 };
		const spam = { ...review, body: 'junk see www.x.example' };
		expect(contentChecks(spam, settings)).toEqual({
			flags: [
				{ code: 'blocked_terms', action: 'queue' },
				{ code: 'links', action: 'queue' },
				{ code: 'short', action: 'queue' },
			],
			terms: ['junk'],
		});
		expect(decide({ review: spam, settings, context: context(spam), now: T0, timeZone: 'UTC' })).toMatchObject({
			status: 'pending',
			by: 'check',
			reason: 'blocked_terms',
		});
		expect(
			decide({
				review: spam,
				settings: { ...settings, link_action: 'reject' },
				context: context(spam),
				now: T0,
				timeZone: 'UTC',
			}),
		).toMatchObject({ status: 'rejected', reason: 'links' });
		expect(contentChecks({ ...review, title: null, body: null }, MODERATION).flags).toEqual([]);
	});

	it('evaluates rules in order with the website zone; disabled and failing rules are skipped', () => {
		const settings = {
			...MODERATION,
			rules: [
				{ id: 'off', when: 'true', action: /** @type {const} */ ('reject'), enabled: false },
				{ id: 'broken', when: 'review.rating >', action: /** @type {const} */ ('reject') },
				{ id: 'night', when: "between(now, '22:00', '06:00')", action: /** @type {const} */ ('queue') },
				{ id: 'low', when: 'review.rating <= 2', action: /** @type {const} */ ('reject'), reason: '' },
				{ id: 'photos', when: 'review.hasPhotos', action: /** @type {const} */ ('approve') },
			],
		};
		const night = Date.parse('2026-10-01T23:30:00Z');
		expect(decide({ review, settings, context: context(), now: night, timeZone: 'UTC' })).toMatchObject({
			status: 'pending',
			ruleId: 'night',
		});
		expect(decide({ review, settings, context: context(), now: night, timeZone: 'Asia/Tokyo' }).ruleId).toBe(null); // 08:30 in Tokyo
		const low = { ...review, rating: 1 };
		expect(decide({ review: low, settings, context: context(low), now: T0, timeZone: 'UTC' })).toMatchObject({
			status: 'rejected',
			ruleId: 'low',
			reason: 'other',
		});
		const withPhotos = { ...review, photos: 2 };
		expect(decide({ review: withPhotos, settings, context: context(withPhotos), now: T0, timeZone: 'UTC' })).toMatchObject({
			status: 'approved',
			ruleId: 'photos',
		});
		const ctx = moderationContext({
			review: { ...review, title: null, body: null, itemId: 'i', scale: 5 },
			customer: { id: 'c', identified: true, reviewsToday: 2 },
			item: { id: 'i', count: 3, average: 4 },
			flags: ['x'],
		});
		expect(ctx).toMatchObject({
			review: { title: '', body: '', length: 0, source: 'api', locale: null, attributes: {} },
			customer: { reviewsToday: 2 },
			item: { count: 3 },
			flags: ['x'],
		});
	});

	it('compiles, checks and caches conditions', () => {
		expect(compileCondition('')).toEqual({ ok: true, program: null });
		expect(compileCondition(null)).toEqual({ ok: true, program: null });
		const first = compileCondition('review.rating > 3');
		expect(compileCondition('review.rating > 3')).toBe(first);
		for (let i = 0; i < 505; i += 1) compileCondition(`review.rating > ${i}`);
		expect(checkCondition('')).toMatchObject({ ok: true, paths: [] });
		expect(checkCondition('order.total > 1').warnings[0]?.code).toBe('unknown_identifier');
		expect(conditionMatches('review.rating > 3', { review: { rating: 4 } }, { now: T0, timeZone: 'UTC' })).toEqual({
			matched: true,
			error: null,
		});
		expect(conditionMatches('bad >', {}, { now: T0, timeZone: 'UTC' }).matched).toBe(false);
		expect(conditionMatches('', {}, { now: T0, timeZone: 'UTC' }).matched).toBe(true);
		expect(
			conditionMatches(
				"dateParts(now, 'Not/AZone').hour > 1 or between(now, '01:00', '02:00', 'Bad/Zone')",
				{},
				{ now: T0, timeZone: 'Nowhere/Zone' },
			).matched,
		).toBe(false);
	});
});

describe('ratings', () => {
	it('summarises approved ratings on the current scale', () => {
		const rollup = {
			...emptyRollup(),
			ratings: [
				{ rating: 5, scale: 5, count: 2 },
				{ rating: 6, scale: 10, count: 1 },
				{ rating: 9, scale: 5, count: 3 },
				{ rating: 2, scale: 5, count: 0 },
			],
			attributes: { fit: { count: 2, sum: 1 }, gone: { count: 1, sum: 1 } },
			withPhotos: 1,
			verified: 2,
			lastReviewAt: '2026-10-01',
		};
		expect(averageOf(rollup, 5)).toEqual({ count: 3, average: 4.3 });
		const summary = summaryView(rollup, {
			scale: 5,
			attributes: [
				{ key: 'fit', label: 'Fit', min: -2, max: 2 },
				{ key: 'none', label: 'None', min: 1, max: 5 },
			],
		});
		expect(summary.distribution).toEqual([
			{ rating: 5, count: 2, percent: 67 },
			{ rating: 4, count: 0, percent: 0 },
			{ rating: 3, count: 1, percent: 33 },
			{ rating: 2, count: 0, percent: 0 },
			{ rating: 1, count: 0, percent: 0 },
		]);
		expect(summary.attributes).toEqual([
			{ key: 'fit', label: 'Fit', min: -2, max: 2, lowLabel: null, highLabel: null, count: 2, average: 0.5 },
		]);
		expect(summaryView(emptyRollup(), { scale: 3 })).toMatchObject({
			count: 0,
			average: 0,
			distribution: [{ rating: 3, percent: 0 }, { rating: 2 }, { rating: 1 }],
		});
		expect(starsView('i', null, 5)).toEqual({ itemId: 'i', count: 0, average: 0, scale: 5 });
		expect(round1(-1.25)).toBe(-1.3);
		expect(round1(4.45)).toBe(4.5);
	});
});

describe('orders and requests', () => {
	it('derives order facts from event data, merged over earlier snapshots', () => {
		const placed = orderFacts(
			{
				orderId: 'o1',
				number: 'N1',
				customer: { customerId: 'cus_1', subject: 'sub|1', email: 'a@b.c' },
				lines: [
					{ itemId: 'i1', title: 'One', quantity: 1 },
					{ itemId: 'i1', quantity: 2 },
					{ itemId: 'i2', sku: 'S2' },
					'junk',
				],
			},
			{ actorId: 'act_1' },
		);
		expect(placed).toEqual({
			orderId: 'o1',
			number: 'N1',
			customerId: 'sub|1',
			customerKeys: ['sub|1', 'cus_1', 'act_1'],
			contact: { name: null, email: 'a@b.c', phone: null },
			lines: [
				{ itemId: 'i1', variantId: null, title: 'One', sku: null },
				{ itemId: 'i2', variantId: null, title: null, sku: 'S2' },
			],
		});
		const completed = orderFacts({ orderId: 'o1', contact: { name: 'Ann', phone: '+4915112345678' } }, { previous: placed });
		expect(completed).toMatchObject({
			number: 'N1',
			customerId: 'sub|1',
			contact: { name: 'Ann', email: 'a@b.c', phone: '+4915112345678' },
			lines: placed.lines,
		});
		expect(orderFacts({ orderId: 'o2', customerId: 'cus_2', items: [{ itemId: 'x' }] })).toMatchObject({
			customerId: 'cus_2',
			lines: [{ itemId: 'x' }],
		});
		expect(orderFacts({ orderId: 'o3' })).toMatchObject({ customerId: null, customerKeys: [], lines: [] });
		expect(
			uniqueLines(
				Array.from({ length: 5 }, (_, i) => ({ itemId: `i${i}` })),
				2,
			),
		).toHaveLength(2);
		expect(uniqueLines('nope')).toEqual([]);
	});

	it('runs the request lifecycle: due, send, remind, fail, expire', () => {
		const facts = {
			...orderFacts({
				orderId: 'o1',
				customerId: 'cus_1',
				customer: { email: 'a@b.c' },
				lines: [{ itemId: 'i1' }, { itemId: 'i2' }],
			}),
			customerId: 'cus_1',
		};
		const request = buildRequest({ id: 'rrq_1', order: facts, completedAt: T0, delayHours: 24, windowDays: 30 });
		expect(request).toMatchObject({
			status: 'open',
			dueAt: new Date(T0 + DAY).toISOString(),
			delivery: { state: 'scheduled', nextAt: new Date(T0 + DAY).toISOString() },
			source: 'event',
		});
		expect(
			buildRequest({
				id: 'r',
				order: { ...facts, customerKeys: [] },
				completedAt: T0,
				delayHours: 0,
				windowDays: 1,
				source: 'api',
				locale: 'de',
			}),
		).toMatchObject({ customerKeys: ['cus_1'], source: 'api', locale: 'de' });
		expect(itemEligibility(request, 'i1', T0)).toBe('ok');
		expect(itemEligibility(request, 'zz', T0)).toBe('not_in_order');
		expect(itemEligibility({ ...request, items: request.items.map((item) => ({ ...item, reviewId: 'r' })) }, 'i1', T0)).toBe(
			'already_reviewed',
		);
		expect(itemEligibility(request, 'i1', T0 + 31 * DAY)).toBe('expired');
		expect(itemEligibility({ ...request, status: 'cancelled' }, 'i1', T0)).toBe('closed');
		expect(itemEligibility({ ...request, status: 'expired' }, 'i1', T0)).toBe('expired');
		expect(pendingItems(request)).toHaveLength(2);
		expect(pickChannel({ name: null, email: 'a@b.c', phone: '+1' }, ['sms', 'email'])).toEqual({ channel: 'sms', to: '+1' });
		expect(pickChannel({ name: null, email: null, phone: null }, ['email', 'whatsapp', 'pigeon'])).toBeNull();
		expect(
			reviewUrl('https://s.example/r?t={token}&o={orderId}&r={requestId}', { token: 'a.b', orderId: 'o 1', requestId: 'r' }),
		).toBe('https://s.example/r?t=a.b&o=o%201&r=r');
		expect(reviewUrl('', { token: 't', orderId: 'o', requestId: 'r' })).toBeNull();

		const due = T0 + DAY;
		expect(nextStep(request, { now: due, reminders: [3], quiet: false })).toEqual({ action: 'send', kind: 'request' });
		expect(nextStep(request, { now: due, reminders: [3], quiet: true })).toEqual({ action: 'wait' });
		const sent = { ...request, delivery: afterSent(request, { now: due, reminders: [3], channel: 'email' }) };
		expect(sent.delivery).toMatchObject({
			state: 'sent',
			sends: 1,
			firstSentAt: new Date(due).toISOString(),
			nextAt: new Date(due + 3 * DAY).toISOString(),
			channel: 'email',
		});
		expect(nextStep(sent, { now: due + 3 * DAY, reminders: [3], quiet: false })).toEqual({ action: 'send', kind: 'reminder' });
		const reminded = { ...sent, delivery: afterSent(sent, { now: due + 3 * DAY, reminders: [3], channel: 'email' }) };
		expect(reminded.delivery).toMatchObject({ state: 'done', sends: 2, nextAt: null });
		expect(nextStep(reminded, { now: due + 4 * DAY, reminders: [3], quiet: false })).toEqual({ action: 'done' });
		const lateReminder = afterSent(request, { now: due, reminders: [100], channel: 'email' });
		expect(lateReminder).toMatchObject({ state: 'done', nextAt: null }); // after the window closes
		expect(nextStep({ ...request, status: 'completed' }, { now: due, reminders: [], quiet: false })).toEqual({
			action: 'done',
		});
		expect(nextStep(request, { now: T0 + 40 * DAY, reminders: [], quiet: false })).toEqual({ action: 'expire' });
		expect(
			nextStep(
				{ ...request, items: request.items.map((item) => ({ ...item, reviewId: 'x' })) },
				{ now: due, reminders: [], quiet: false },
			),
		).toEqual({ action: 'done' });
		const failed = afterFailure(request, { now: due, maxAttempts: 2, error: 'boom' });
		expect(failed).toMatchObject({
			attempts: 1,
			state: 'scheduled',
			nextAt: new Date(due + 3_600_000).toISOString(),
			lastError: 'boom',
		});
		expect(afterFailure({ ...request, delivery: failed }, { now: due, maxAttempts: 2, error: 'boom' })).toMatchObject({
			state: 'failed',
			nextAt: null,
		});
		expect(afterFailure(request, { now: due, maxAttempts: 5, error: 'x', permanent: true }).state).toBe('failed');
	});
});

describe('reviews', () => {
	it('applies the collection policy and the one-review-per key', () => {
		expect(submissionRefusal({ via: 'server', customerId: null }, { who: 'verified_buyers', verified: false })).toBeNull();
		expect(submissionRefusal({ via: 'guest', customerId: null }, { who: 'anyone', verified: false })).toBeNull();
		expect(submissionRefusal({ via: 'guest', customerId: null }, { who: 'identified', verified: false })).toBe(
			'identity_required',
		);
		expect(submissionRefusal({ via: 'identity', customerId: 'c' }, { who: 'verified_buyers', verified: false })).toBe(
			'not_verified',
		);
		expect(submissionRefusal({ via: 'identity', customerId: 'c' }, { who: 'identified', verified: false })).toBeNull();
		expect(dedupeKeyOf({ customerId: null, itemId: 'i', orderId: 'o' }, 'item')).toBeNull();
		expect(dedupeKeyOf({ customerId: 'c', itemId: 'i', orderId: 'o' }, 'item')).toBe('c|i');
		expect(dedupeKeyOf({ customerId: 'c', itemId: 'i', orderId: 'o' }, 'order_item')).toBe('c|i|o');
		expect(dedupeKeyOf({ customerId: 'c', itemId: 'i', orderId: null }, 'order_item')).toBe('c|i');
	});

	it('builds stored reviews and their public / owner views', () => {
		const { value } = validateReview(
			{ itemId: 'i', rating: 4, body: 'Pretty good', author: { name: 'Ann Lee' } },
			{ content: CONTENT, maxPhotos: 3, server: false },
		);
		if (!value) throw new Error('invalid');
		const pending = buildReview({
			id: 'rev_1',
			value,
			customerId: 'c',
			orderId: null,
			requestId: null,
			verified: false,
			source: 'storefront',
			scale: 5,
			photos: [{ id: 'p', key: 'photos/p', contentType: 'image/png', size: 3 }],
			decision: { status: 'pending', by: 'default', ruleId: null, reason: null, flags: [], terms: [] },
			dedupeKey: 'c|i',
			now: '2026-10-01T10:00:00.000Z',
			authorName: 'Ann Lee',
			authorEmail: null,
		});
		expect(pending).toMatchObject({ status: 'pending', publishedAt: null, photoCount: 1, moderation: { decidedAt: null } });
		const approved = buildReview({
			id: 'rev_2',
			value,
			customerId: null,
			orderId: null,
			requestId: null,
			verified: true,
			source: 'api',
			scale: 5,
			photos: [],
			decision: { status: 'approved', by: 'rule', ruleId: 'r', reason: null, flags: [], terms: [] },
			dedupeKey: null,
			now: 't',
			authorName: null,
			authorEmail: null,
		});
		expect(approved).toMatchObject({ publishedAt: 't', moderation: { decidedAt: 't' } });
		const view = publicReview(pending, {
			nameFormat: 'first_name_initial',
			showReply: false,
			showVerified: false,
			photoUrl: (photo) => (photo.id === 'p' ? 'https://cdn/p' : null),
		});
		expect(view).toMatchObject({
			author: 'Ann L.',
			verifiedPurchase: null,
			reply: null,
			removed: false,
			photos: [{ id: 'p', url: 'https://cdn/p' }],
		});
		expect(
			publicReview(
				{ ...pending, photos: null, anonymizedAt: new Date(), author: null, reply: { body: 'x', at: 'a', by: null } },
				{ nameFormat: 'first_name', showReply: true, showVerified: true, photoUrl: () => null },
			),
		).toMatchObject({ removed: true, author: null, reply: { body: 'x', at: 'a' }, photos: [] });
		expect(publicReview(pending, { nameFormat: 'first_name', showReply: true, showVerified: true })).toMatchObject({
			photos: [],
		});
		expect(ownerReview({ ...pending, author: null, custom: null, attributes: /** @type {any} */ (undefined) })).toMatchObject({
			author: { name: null, email: null },
			custom: {},
			attributes: {},
			photos: [],
		});
	});

	it('renders request, question and form views', () => {
		const request = buildRequest({
			id: 'r',
			order: { ...orderFacts({ orderId: 'o', customerId: 'c', lines: [{ itemId: 'i' }] }), customerId: 'c' },
			completedAt: T0,
			delayHours: 1,
			windowDays: 1,
		});
		expect(customerRequestView(request, T0)).toMatchObject({ open: true, items: [{ itemId: 'i', reviewed: false }] });
		expect(customerRequestView(request, T0 + 2 * DAY).open).toBe(false);
		expect(requestView(request, T0)).toMatchObject({
			customerId: 'c',
			delivery: { state: 'scheduled' },
			items: [{ reviewId: null, reviewed: false }],
		});
		/** @type {import('../core/views.js').StoredQuestion} */
		const question = {
			id: 'q',
			itemId: 'i',
			body: 'Why?',
			author: { name: 'Sam Rivera', email: 's@x.y' },
			customerId: 'c',
			status: 'published',
			locale: null,
			askedAt: 't',
			answeredAt: null,
			answers: [
				{
					id: 'a1',
					body: 'Because',
					author: null,
					customerId: null,
					by: 'merchant',
					verifiedBuyer: false,
					status: 'published',
					answeredAt: 't',
				},
				{
					id: 'a2',
					body: 'Hmm',
					author: { name: 'Pat Lee' },
					customerId: 'c2',
					by: 'customer',
					verifiedBuyer: true,
					status: 'pending',
					answeredAt: 't',
				},
			],
		};
		expect(questionView(question, { nameFormat: 'first_name_initial' })).toMatchObject({
			author: 'Sam R.',
			answers: [{ id: 'a1', author: null }],
		});
		expect(questionView({ ...question, author: null }, { nameFormat: 'first_name', owner: true })).toMatchObject({
			author: { name: null, email: null },
			status: 'published',
			answers: [{ status: 'published' }, { status: 'pending', author: 'Pat', customerId: 'c2' }],
		});
		expect(formView(CONTENT, null)).toMatchObject({
			ratingScale: 5,
			title: { enabled: true },
			photos: { enabled: false },
			attributes: [{ key: 'fit', required: false, lowLabel: null }],
		});
		expect(
			formView(
				{ ...CONTENT, title_max_length: 0 },
				{ max_photos_per_review: 2, max_photo_bytes: 9, allowed_types: ['image/png'] },
			),
		).toMatchObject({ title: { enabled: false }, photos: { enabled: true, max: 2, types: ['image/png'] } });
	});
});

describe('structured data', () => {
	it('emits AggregateRating and Review nodes only from enough approved reviews', () => {
		expect(aggregateRatingNode({ count: 0, average: 0, scale: 5 }, 1)).toBeUndefined();
		expect(aggregateRatingNode({ count: 2, average: 4.5, scale: 5 }, 3)).toBeUndefined();
		expect(aggregateRatingNode({ count: 2, average: 7, scale: 5 }, 1)).toBeUndefined();
		expect(aggregateRatingNode({ count: 2.7, average: 4.5, scale: 5 }, 0)).toEqual({
			'@type': 'AggregateRating',
			ratingValue: 4.5,
			reviewCount: 2,
			ratingCount: 2,
			bestRating: 5,
			worstRating: 1,
		});
		expect(reviewNode({ rating: 6, scale: 5, title: null, body: null, authorName: 'A', submittedAt: 't' })).toBeNull();
		expect(
			reviewNode({ rating: 4, scale: 10, title: null, body: '  ', authorName: 'A', submittedAt: '2026-10-01T10:00:00Z' }),
		).toEqual({
			'@type': 'Review',
			reviewRating: { '@type': 'Rating', ratingValue: 4, bestRating: 10, worstRating: 1 },
			author: { '@type': 'Person', name: 'A' },
			datePublished: '2026-10-01',
		});
		const reviews = [
			{ rating: 5, scale: 5, title: 'T', body: 'short', authorName: 'A', submittedAt: '2026-10-02' },
			{ rating: 4, scale: 5, title: null, body: 'a much longer body', authorName: 'B', submittedAt: '2026-10-01' },
			{ rating: 3, scale: 5, title: null, body: null, authorName: 'C', submittedAt: '2026-10-03' },
		];
		expect(selectReviews(reviews, { limit: 2, selection: 'most_detailed' }).map((r) => r.authorName)).toEqual(['B', 'A']);
		expect(selectReviews(reviews, { limit: 1, selection: 'newest' }).map((r) => r.authorName)).toEqual(['A']);
		const jsonLd = productJsonLd({
			item: { itemId: 'i', name: 'Thing', url: 'https://s/p', image: 'https://s/i.png' },
			brand: 'Acme',
			summary: { count: 2, average: 4.5, scale: 5 },
			reviews: reviews.slice(0, 2),
			minReviews: 1,
		});
		expect(jsonLd).toMatchObject({
			'@id': 'https://s/p#product',
			sku: 'i',
			image: 'https://s/i.png',
			brand: { name: 'Acme' },
			review: [{ name: 'T' }, { reviewBody: 'a much longer body' }],
		});
		expect(
			productJsonLd({
				item: { itemId: 'i', name: 'Thing', sku: 'S' },
				summary: { count: 0, average: 0, scale: 5 },
				reviews,
				minReviews: 1,
			}),
		).toEqual({ '@context': 'https://schema.org', '@type': 'Product', name: 'Thing', sku: 'S' });
		expect(compact({ a: null, b: '', c: [], d: 0, e: undefined })).toEqual({ d: 0 });
	});
});

describe('csv import', () => {
	it('parses RFC 4180 CSV', () => {
		expect(parseCsv('﻿a,b\r\n"x, ""y""",z\n"multi\nline",\n\n')).toEqual({
			ok: true,
			rows: [
				['a', 'b'],
				['x, "y"', 'z'],
				['multi\nline', ''],
			],
		});
		expect(parseCsv('a;b\n1;2', { delimiter: ';' })).toEqual({
			ok: true,
			rows: [
				['a', 'b'],
				['1', '2'],
			],
		});
		expect(parseCsv('a\n"open')).toEqual({ ok: false, code: 'unterminated_quote', line: 2 });
		expect(parseCsv('a\nb\nc', { maxRows: 2 })).toMatchObject({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('a\nb\nc\n', { maxRows: 2 })).toMatchObject({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('')).toEqual({ ok: false, code: 'empty', line: 1 });
		expect(parseCsv('a"b,c')).toEqual({ ok: true, rows: [['a"b', 'c']] });
	});

	it('maps rows with configurable column names and validates each row', () => {
		const columns = {
			item_id: 'Product',
			rating: 'Stars',
			body: 'Text',
			author: 'Name',
			submitted_at: 'Date',
			verified: 'Verified',
			external_id: 'Id',
			order_id: 'Order',
			customer_id: 'Customer',
			reply: 'Reply',
			title: 'Title',
		};
		const rows = [
			['product', 'stars', 'text', 'name', 'date', 'verified', 'id', 'order', 'customer', 'reply', 'title'],
			['itm_1', '5.0', 'Great', 'Ann', '2025-01-01', 'Yes', 'x1', 'o1', 'c1', 'Thanks', 'T'],
			['itm_2', '4', '', '', '', '', '', '', '', '', ''],
			['bad id', '0', 'x'.repeat(30), '', '2999-01-01', 'maybe', 'bad id', 'bad id', 'bad customer', '', 'y'.repeat(30)],
		];
		const mapped = mapImportRows(rows, {
			columns,
			scale: 5,
			titleMax: 20,
			bodyMax: 20,
			authorMax: 20,
			trustVerified: true,
			now: T0,
		});
		expect(mapped.records).toEqual([
			{
				row: 2,
				itemId: 'itm_1',
				rating: 5,
				title: 'T',
				body: 'Great',
				author: 'Ann',
				submittedAt: '2025-01-01T00:00:00.000Z',
				verified: true,
				externalId: 'x1',
				reply: 'Thanks',
				orderId: 'o1',
				customerId: 'c1',
			},
			{
				row: 3,
				itemId: 'itm_2',
				rating: 4,
				title: null,
				body: null,
				author: null,
				submittedAt: null,
				verified: false,
				externalId: null,
				reply: null,
				orderId: null,
				customerId: null,
			},
		]);
		expect(mapped.errors.map((e) => `${e.row}${e.path}:${e.code}`)).toEqual([
			'4/item_id:id_invalid',
			'4/rating:rating_invalid',
			'4/title:too_long',
			'4/body:too_long',
			'4/submitted_at:date_invalid',
			'4/verified:boolean_invalid',
			'4/external_id:id_invalid',
			'4/order_id:id_invalid',
			'4/customer_id:customer_invalid',
		]);
		expect(
			mapImportRows([['other']], {
				columns: {},
				scale: 5,
				titleMax: 1,
				bodyMax: 1,
				authorMax: 1,
				trustVerified: false,
				now: T0,
			}).errors.map((e) => e.path),
		).toEqual(['/item_id', '/rating']);
		expect(
			mapImportRows([['item_id', 'rating'], ['a']], {
				columns: {},
				scale: 5,
				titleMax: 1,
				bodyMax: 1,
				authorMax: 1,
				trustVerified: false,
				now: T0,
			}).errors[0]?.code,
		).toBe('rating_invalid');
		expect(
			mapImportRows([], { columns: {}, scale: 5, titleMax: 1, bodyMax: 1, authorMax: 1, trustVerified: false, now: T0 })
				.errors,
		).toHaveLength(2);
	});
});

describe('sorting', () => {
	it('builds keyset filters for every order', () => {
		expect(sortSpec('oldest')).toEqual([
			['submittedAt', 1],
			['id', 1],
		]);
		expect(sortSpec('rating_low')[0]).toEqual(['rating', 1]);
		const spec = sortSpec('rating_high');
		const cursor = cursorOf({ rating: 4, submittedAt: '2026-10-01T10:00:00.000Z', id: 'rev_1' }, spec);
		expect(cursor).toBe('4|2026-10-01T10:00:00.000Z|rev_1');
		expect(afterFilter(spec, cursor)).toEqual({
			$or: [
				{ rating: { $lt: 4 } },
				{ rating: 4, submittedAt: { $lt: '2026-10-01T10:00:00.000Z' } },
				{ rating: 4, submittedAt: '2026-10-01T10:00:00.000Z', id: { $lt: 'rev_1' } },
			],
		});
		expect(afterFilter(sortSpec('oldest'), 'a|b')).toEqual({
			$or: [{ submittedAt: { $gt: 'a' } }, { submittedAt: 'a', id: { $gt: 'b' } }],
		});
		expect(afterFilter(spec, 'x|a|b')).toBeNull();
		expect(afterFilter(spec, '4||b')).toBeNull();
		expect(afterFilter(spec, 'a|b')).toBeNull();
		expect(afterFilter(spec, 5)).toBeNull();
		expect(pickSort('rating_low', { sorts: ['newest', 'rating_low'], fallback: 'newest' })).toBe('rating_low');
		expect(pickSort('bogus', { sorts: ['newest', 'oldest'], fallback: 'oldest' })).toBe('oldest');
		expect(pickSort(undefined, { sorts: ['rating_high', 'x'], fallback: 'newest' })).toBe('rating_high');
		expect(pickSort(undefined, { sorts: ['x'], fallback: 'y' })).toBe('newest');
	});
});

describe('analytics and time', () => {
	it('rolls daily rows into buckets with gaps filled', () => {
		const rows = /** @type {import('../core/analytics.js').DayRow[]} */ ([
			{ day: '2026-09-28', status: 'approved', count: 2, normalisedSum: 1.8, withPhotos: 1, verified: 2, replied: 1 },
			{ day: '2026-09-29', status: 'rejected', count: 1, normalisedSum: 0.2, withPhotos: 0, verified: 0, replied: 0 },
			{ day: '2026-10-05', status: 'pending', count: 1, normalisedSum: 1, withPhotos: 0, verified: 1, replied: 0 },
			{ day: '2030-01-01', status: 'approved', count: 1, normalisedSum: 1, withPhotos: 0, verified: 0, replied: 0 },
		]);
		const result = assembleAnalytics({
			rows,
			from: Date.parse('2026-09-27T00:00:00Z'),
			to: Date.parse('2026-10-06T00:00:00Z'),
			bucket: 'week',
			timeZone: 'UTC',
			scale: 5,
			requests: { created: 4, converted: 1 },
			topItems: [{ itemId: 'i', count: 2, normalisedSum: 1.8 }],
		});
		expect(result.series.map((point) => point.key)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2029-12-31']);
		expect(result.totals).toMatchObject({
			submitted: 5,
			approved: 3,
			rejected: 1,
			pending: 1,
			averageRating: 4.7,
			verifiedShare: 0.6,
			photoShare: 0.2,
			replyRate: 0.333,
			approvalRate: 0.75,
		});
		expect(result.requests).toEqual({ created: 4, converted: 1, conversion: 0.25 });
		expect(result.timing).toEqual({ decisionHours: null, replyHours: null });
		expect(result.topItems).toEqual([{ itemId: 'i', count: 2, averageRating: 4.5 }]);
		const empty = assembleAnalytics({ rows: [], from: T0, to: T0, bucket: 'month', timeZone: 'UTC', scale: 5 });
		expect(empty).toMatchObject({
			series: [{ key: '2026-10', submitted: 0, averageRating: null }],
			requests: null,
			totals: { averageRating: null, verifiedShare: 0 },
		});
		expect(analyticsRange({}, { now: T0, defaultDays: 30, maxDays: 90, defaultBucket: 'day' })).toEqual({
			ok: true,
			from: T0 - 30 * DAY,
			to: T0,
			bucket: 'day',
		});
		expect(analyticsRange({ to: 'x' }, { now: T0, defaultDays: 30, maxDays: 90, defaultBucket: 'day' })).toEqual({
			ok: false,
			path: '/to',
			code: 'date_invalid',
		});
		expect(
			analyticsRange({ from: '2026-10-02T00:00:00Z' }, { now: T0, defaultDays: 30, maxDays: 90, defaultBucket: 'day' }),
		).toMatchObject({ ok: false, path: '/from' });
		expect(
			analyticsRange({ from: '2020-01-01T00:00:00Z' }, { now: T0, defaultDays: 30, maxDays: 90, defaultBucket: 'day' }),
		).toMatchObject({ code: 'range_too_long' });
		expect(analyticsRange({ bucket: 'hour' }, { now: T0, defaultDays: 30, maxDays: 90, defaultBucket: 'day' })).toMatchObject({
			code: 'bucket_invalid',
		});
	});

	it('computes local times, windows and buckets in any zone', () => {
		expect(isTimeZone('Asia/Karachi')).toBe(true);
		expect(isTimeZone('Mars/Base')).toBe(false);
		expect(isTimeZone('')).toBe(false);
		expect(localParts(T0, 'Asia/Karachi')).toEqual({ year: 2026, month: 10, day: 1, hour: 15, minute: 0 });
		expect(localParts(T0, 'Bad/Zone').hour).toBe(10);
		expect(dayKey(Date.parse('2026-09-30T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-01');
		expect(parseClock('24:00')).toBe(1440);
		expect(parseClock('24:01')).toBeNull();
		expect(parseClock('12:60')).toBeNull();
		expect(parseClock('9:00')).toBeNull();
		expect(parseClock(5)).toBeNull();
		expect(inWindow(Date.parse('2026-10-01T23:00:00Z'), { start: '22:00', end: '07:00' }, 'UTC')).toBe(true);
		expect(inWindow(Date.parse('2026-10-01T06:00:00Z'), { start: '22:00', end: '07:00' }, 'UTC')).toBe(true);
		expect(inWindow(T0, { start: '22:00', end: '07:00' }, 'UTC')).toBe(false);
		expect(inWindow(T0, { start: '09:00', end: '11:00' }, 'UTC')).toBe(true);
		expect(inWindow(T0, { start: '09:00', end: '09:00' }, 'UTC')).toBe(false);
		expect(inWindow(T0, null, 'UTC')).toBe(false);
		expect(bucketKey(T0, 'day', 'UTC')).toBe('2026-10-01');
		expect(bucketKey(T0, 'week', 'UTC')).toBe('2026-09-28');
		expect(bucketKey(T0, 'month', 'UTC')).toBe('2026-10');
		expect(bucketKeys(T0, T0 + 2 * DAY + 3_600_000, 'day', 'UTC')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
		expect(bucketKeys(T0, T0 + DAY - 1, 'day', 'Asia/Tokyo')).toEqual(['2026-10-01', '2026-10-02']);
		expect(toMs(new Date(T0))).toBe(T0);
		expect(toMs(T0)).toBe(T0);
		expect(toMs({})).toBeNaN();
		expect(isoOrNull('2026-10-01T10:00:00Z')).toBe('2026-10-01T10:00:00.000Z');
		expect(isoOrNull('nope')).toBeNull();
	});

	it('overlays configuration on schema defaults by type', () => {
		const schema = {
			properties: {
				a: { type: 'integer', default: 1 },
				b: { type: 'string', default: 'x' },
				c: { type: 'boolean', default: true },
				d: { type: 'array', default: [] },
				e: { type: 'object', default: {} },
				f: { type: 'number', default: 1.5 },
				g: { default: null },
			},
		};
		expect(defaultsOf(schema)).toEqual({ a: 1, b: 'x', c: true, d: [], e: {}, f: 1.5, g: null });
		expect(effectiveConfig(schema, { a: 'no', b: 2, c: false, d: [1], e: [], f: Number.NaN, g: 'any', z: 1 })).toEqual({
			a: 1,
			b: 'x',
			c: false,
			d: [1],
			e: {},
			f: 1.5,
			g: 'any',
		});
		expect(effectiveConfig({}, null)).toEqual({});
	});
});
