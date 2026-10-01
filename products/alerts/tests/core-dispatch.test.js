import { describe, expect, it } from 'vitest';
import {
	afterFailure,
	alertVars,
	backoffMs,
	capCounters,
	catalogText,
	deferForQuiet,
	fill,
	formatMoney,
	isRetryable,
	languageChain,
	plannedAt,
	renderMessage,
	templateFor,
	tidy,
} from '../core/dispatch.js';
import en from '../strings/en.json' with { type: 'json' };

/** @type {import('../core/dispatch.js').DispatchSettings} */
const settings = {
	timeZone: 'UTC',
	quietHoursEnabled: false,
	quietStart: '21:00',
	quietEnd: '08:00',
	batchWindowMinutes: 0,
	maxPerDay: 5,
	maxPerWeek: 20,
	capAction: 'defer',
	maxAttempts: 3,
	retryBaseMinutes: 2,
};
const catalogs = { en, de: { 'template.back_in_stock.subject': '{item} ist wieder da' } };
const sources = { overrides: [], catalogs, defaultLang: 'en' };
const NOON = Date.parse('2026-10-01T12:00:00Z');

describe('timing', () => {
	it('plans sends with batching windows and quiet hours', () => {
		expect(plannedAt(NOON, settings)).toBe(NOON);
		expect(plannedAt(NOON, { ...settings, batchWindowMinutes: 10 })).toBe(NOON + 600_000);
		const quiet = { ...settings, quietHoursEnabled: true };
		expect(deferForQuiet(Date.parse('2026-10-01T23:00:00Z'), quiet)).toBe(Date.parse('2026-10-02T08:00:00Z'));
		expect(deferForQuiet(NOON, quiet)).toBe(NOON);
	});

	it('keys frequency caps per local day and week', () => {
		expect(capCounters('ck_1', NOON, settings)).toEqual([
			{ key: 'cap:ck_1:d:2026-10-01', limit: 5, resetsAt: Date.parse('2026-10-02T00:00:00Z') },
			{ key: 'cap:ck_1:w:2026-W40', limit: 20, resetsAt: Date.parse('2026-10-05T00:00:00Z') },
		]);
		expect(capCounters('ck_1', NOON, { ...settings, maxPerDay: 0, maxPerWeek: 0 })).toEqual([]);
	});

	it('backs off exponentially and retries only transient failures', () => {
		expect(backoffMs(1, 2)).toBe(120_000);
		expect(backoffMs(3, 2)).toBe(480_000);
		expect(backoffMs(40, 60)).toBe(86_400_000);
		expect(isRetryable({ status: 503 })).toBe(true);
		expect(isRetryable({ status: 429 })).toBe(true);
		expect(isRetryable({ status: 400 })).toBe(false);
		expect(isRetryable({ code: 'timeout' })).toBe(true);
		expect(isRetryable({ code: 'not_implemented' })).toBe(false);
		expect(afterFailure({ attempts: 1, failure: { status: 500 }, now: NOON }, settings)).toEqual({
			action: 'retry',
			at: NOON + 120_000,
		});
		expect(afterFailure({ attempts: 3, failure: { status: 500 }, now: NOON }, settings)).toEqual({ action: 'fail' });
		expect(afterFailure({ attempts: 1, failure: { status: 404 }, now: NOON }, settings)).toEqual({ action: 'fail' });
	});
});

describe('templates', () => {
	it('fills placeholders and tidies text', () => {
		expect(fill('{a} and {b} and {c}', { a: 1, b: 'two' })).toBe('1 and two and {c}');
		expect(tidy('one  \n\n\n\ntwo   three\n\n')).toBe('one\n\ntwo three');
		expect(languageChain('pt-BR', 'de')).toEqual(['pt-BR', 'pt', 'de', 'en']);
		expect(catalogText('template.line.price', { price: '€1' }, { catalogs, lang: 'de', defaultLang: 'en' })).toBe('Price: €1');
		expect(catalogText('missing.key', {}, { catalogs, lang: 'en', defaultLang: 'en' })).toBe('');
	});

	it('picks merchant overrides first, most specific first, then the catalog', () => {
		const overrides = [
			{ type: '*', channel: '*', lang: '*', body: 'any {item}' },
			{ type: 'back_in_stock', channel: 'sms', lang: '*', body: 'sms {item}' },
			{ type: 'custom', channel: '*', lang: 'en', subject: 'custom subject', body: 'custom {item}' },
			{ type: 'price_drop', channel: 'email', lang: 'de', body: '' },
		];
		const with_ = { ...sources, overrides };
		expect(templateFor({ type: 'back_in_stock', channel: 'sms', lang: 'en', part: 'body' }, with_)).toBe('sms {item}');
		expect(templateFor({ type: 'custom:vip', channel: 'email', lang: 'en', part: 'subject' }, with_)).toBe('custom subject');
		expect(templateFor({ type: 'price_drop', channel: 'email', lang: 'de', part: 'body' }, with_)).toBe('any {item}');
		expect(templateFor({ type: 'back_in_stock', channel: 'email', lang: 'de', part: 'subject' }, sources)).toBe(
			'{item} ist wieder da',
		);
		expect(templateFor({ type: 'back_in_stock', channel: 'sms', lang: 'de', part: 'body' }, sources)).toBe(
			en['template.back_in_stock.sms.body'],
		);
		expect(templateFor({ type: 'digest', channel: 'email', lang: 'en', part: 'line' }, with_)).toBe(en['template.digest.line']);
		expect(templateFor({ type: 'nothing', channel: 'email', lang: 'en', part: 'body' }, sources)).toBeNull();
		expect(
			templateFor({ type: 'nothing', channel: 'email', lang: 'xx', part: 'body' }, { ...sources, catalogs: {} }),
		).toBeNull();
	});

	it('formats money in minor units for the language', () => {
		expect(formatMoney({ amount: 129_900, currency: 'EUR' }, 'en')).toBe('€1,299.00');
		expect(formatMoney({ amount: 1500, currency: 'JPY' }, 'en')).toBe('¥1,500');
		expect(formatMoney({ amount: 100, currency: 'ZZZ' }, 'en')).toMatch(/1\.00/);
		expect(formatMoney(null, 'en')).toBe('');
		expect(formatMoney({ amount: 100, currency: 'EUR' }, 'not a lang!')).toBe('1.00 EUR');
	});

	it('computes alert placeholders', () => {
		const vars = alertVars(
			{
				type: 'price_drop',
				typeName: 'price drop',
				itemName: 'Watch',
				url: 'https://s.example/w',
				price: { amount: 19_900, currency: 'EUR' },
				oldPrice: { amount: 25_000, currency: 'EUR' },
				dropPercent: 20,
				quantity: 3,
			},
			{ catalogs, lang: 'en', defaultLang: 'en' },
		);
		expect(vars).toMatchObject({
			item: 'Watch',
			price: '€199.00',
			old_price: '€250.00',
			drop_percent: 20,
			quantity: 3,
			price_line: 'Price: €199.00',
			link_line: 'Order here: https://s.example/w',
			status_text: 'now €199.00',
		});
		const bare = alertVars(
			{ type: 'custom:vip', typeName: 'VIP', itemName: 'X', url: '', dropPercent: 0 },
			{ catalogs, lang: 'en', defaultLang: 'en' },
		);
		expect(bare).toMatchObject({ price_line: '', link_line: '', quantity: '', status_text: 'VIP' });
	});

	it('renders single alerts, digests and confirmations', () => {
		const item = (/** @type {string} */ id, /** @type {string} */ type) => ({
			subscriptionId: id,
			cycle: 1,
			type,
			vars: { item: `Item ${id}`, url: '', price_line: '', link_line: '', status_text: 'back in stock' },
		});
		const common = { site: 'Shop', unsubscribe_url: 'https://u', unsubscribe_line: 'Stop: https://u' };
		const one = renderMessage(
			{ kind: 'alert', items: [item('a', 'back_in_stock')], channel: 'email', lang: 'en', common },
			sources,
		);
		expect(one).toEqual({
			subject: 'Item a is back in stock',
			text: 'Good news — Item a is back in stock at Shop.\n\nStop: https://u',
		});
		const sms = renderMessage(
			{ kind: 'alert', items: [item('a', 'back_in_stock')], channel: 'sms', lang: 'en', common },
			sources,
		);
		expect(sms).toEqual({ subject: null, text: 'Shop: Item a is back in stock. Stop: https://u' });
		const digest = renderMessage(
			{ kind: 'alert', items: [item('a', 'back_in_stock'), item('b', 'back_in_stock')], channel: 'email', lang: 'en', common },
			sources,
		);
		expect(digest?.subject).toBe('2 updates from Shop');
		expect(digest?.text).toContain('• Item a — back in stock');
		expect(digest?.text).toContain('• Item b — back in stock');
		const confirm = renderMessage(
			{
				kind: 'confirm',
				items: [{ ...item('a', 'back_in_stock'), vars: { item: 'Phone', confirm_url: 'https://c' } }],
				channel: 'email',
				lang: 'en',
				common,
			},
			sources,
		);
		expect(confirm?.subject).toBe('Confirm your alert for Phone');
		expect(confirm?.text).toContain('https://c');
		expect(
			renderMessage({ kind: 'alert', items: [item('a', 'unknown')], channel: 'email', lang: 'en', common }, sources),
		).toBeNull();
		expect(
			renderMessage(
				{ kind: 'alert', items: [item('a', 'x'), item('b', 'x')], channel: 'email', lang: 'en', common },
				{ ...sources, catalogs: {} },
			),
		).toBeNull();
		expect(
			renderMessage({ kind: 'alert', items: [item('a', 'x'), item('b', 'x')], channel: 'sms', lang: 'en', common }, sources)
				?.subject,
		).toBeNull();
	});
});
