/**
 * The consent list (A2), pure: what the merchant asks people to agree to, and what each user gave.
 */
import { describe, expect, it } from 'vitest';
import { CONSENT_TEMPLATES, answerConsents, checkConsent, consentsToAsk, ownConsents } from '../core/consents.js';

const terms = {
	key: 'terms',
	label: 'I accept the terms',
	url: 'https://shop.example.com/terms',
	version: '2',
	required: true,
	purpose: 'agreement',
};
const privacy = {
	key: 'privacy',
	label: 'I read the privacy policy',
	url: '',
	version: '1',
	required: false,
	purpose: 'agreement',
};
const news = { key: 'news', label: 'Send me offers by email', url: '', version: '1', required: false, purpose: 'marketing' };
const list = /** @type {import('../core/consents.js').Consent[]} */ ([terms, privacy, news]);
const at = new Date('2026-10-16T00:00:00Z');

describe('consents (A2)', () => {
	it('seeds today’s terms consent', () => {
		expect(CONSENT_TEMPLATES).toEqual([
			{ key: 'terms', label: 'I accept the terms', url: '', version: '1', required: true, purpose: 'agreement' },
		]);
	});

	it('checks a consent as the merchant saves it; marketing consent is never required', () => {
		expect(checkConsent('terms', { ...terms })).toEqual({ ok: true, value: terms });
		expect(checkConsent('Bad Key', terms)).toMatchObject({ ok: false, field: 'key' });
		expect(checkConsent('x', { ...terms, label: '' })).toMatchObject({ ok: false, field: 'label' });
		expect(checkConsent('x', { ...terms, url: 'javascript:alert(1)' })).toMatchObject({ ok: false, field: 'url' });
		expect(checkConsent('x', { ...terms, version: '' })).toMatchObject({ ok: false, field: 'version' });
		expect(checkConsent('x', { ...terms, purpose: 'other' })).toMatchObject({ ok: false, field: 'purpose' });
		expect(checkConsent('x', { ...news, required: true })).toMatchObject({ ok: false, field: 'required' });
		expect(checkConsent('x', { label: 'Minimal' })).toEqual({
			ok: true,
			value: { key: 'x', label: 'Minimal', url: '', version: '1', required: false, purpose: 'agreement' },
		});
	});

	it('asks the required agreements a user has not given in their current version', () => {
		expect(consentsToAsk(list, {}).map((c) => c.key)).toEqual(['terms']);
		expect(consentsToAsk(list, { terms: { version: '1', given: true, at } }).map((c) => c.key)).toEqual(['terms']);
		expect(consentsToAsk(list, { terms: { version: '2', given: true, at } })).toEqual([]);
	});

	it('records the answers: agreements in their version, marketing given or withdrawn; a required one stays given', () => {
		const first = answerConsents(list, {}, { terms: true, news: true }, at);
		expect(first).toEqual({
			ok: true,
			value: { terms: { version: '2', given: true, at }, news: { version: '1', given: true, at } },
		});
		const later = new Date('2026-11-01T00:00:00Z');
		expect(answerConsents(list, first.ok ? first.value : {}, { news: false, privacy: true }, later)).toEqual({
			ok: true,
			value: {
				terms: { version: '2', given: true, at },
				news: { version: '1', given: false, at: later },
				privacy: { version: '1', given: true, at: later },
			},
		});
		expect(answerConsents(list, {}, { terms: false }, at)).toMatchObject({ ok: false, field: 'consents/terms' });
		expect(answerConsents(list, {}, { nope: true }, at)).toMatchObject({ ok: false, field: 'consents/nope' });
		expect(answerConsents(list, {}, { news: 'yes' }, at)).toMatchObject({ ok: false, field: 'consents/news' });
		expect(answerConsents(list, {}, 'x', at)).toMatchObject({ ok: false, field: 'consents' });
	});

	it('shows a user their answers as text times', () => {
		expect(ownConsents({ news: { version: '1', given: false, at } })).toEqual({
			news: { version: '1', given: false, at: at.toISOString() },
		});
	});
});
