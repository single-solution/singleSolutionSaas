import { describe, expect, it } from 'vitest';
import { RULES, validateMessageDefaults } from '../src/index.js';
import { checkMessageDefaults } from '../src/semantics.js';
import {
	BUILT_IN_VALUES,
	LONG_VALUE_LIMIT,
	MAX_VALUES,
	SUBJECT_LIMIT,
	TEMPLATE_CHANNELS,
	TEMPLATE_KEY,
	TEXT_LIMITS,
	VALUES_TOTAL_LIMIT,
	VALUE_LIMIT,
	VALUE_NAME,
	isTitled,
	longValueProblem,
	placeholdersOf,
	sectionProblem,
	valueNamesOf,
	wordsProblem,
} from '../src/templates.js';
import { expectProblem, expectRule } from './helpers.js';

/**
 * A valid declaration of one product with every kind of channel.
 * @returns {{ productId: string, messages: any[] }}
 */
const declaration = () => ({
	productId: 'notes',
	messages: [
		{
			key: 'notes.shared',
			name: 'Note shared',
			description: 'Sent when someone shares a note with you.',
			values: ['name', 'title', 'link', 'business'],
			channels: {
				email: {
					subject: '{name} shared a note with you',
					text: '{name} shared “{title}” with you.{?link}\n\nOpen it: {link}{/link}\n\nUnsubscribe: {unsubscribeUrl}',
				},
				sms: { text: '{name} shared “{title}” on {business}.' },
				whatsapp: null,
				push: { subject: 'Shared with you', text: '{title}' },
				staff_push: { subject: 'Shared', text: '{title}' },
			},
		},
		{
			key: 'notes.code',
			name: 'Code',
			values: ['code'],
			required: true,
			urgent: true,
			sensitive: true,
			channels: { sms: { text: 'Your code is {code}.' } },
		},
		{
			key: 'notes.copy',
			name: 'Copy of a note',
			values: ['title', 'body'],
			longValues: ['body'],
			channels: {
				email: { subject: 'Your note {title}', text: '{body}\n\nUnsubscribe: {unsubscribeUrl}' },
				sms: { text: '{title}: {body}' },
			},
		},
	],
});

describe('template rules (@ss/contracts/templates)', () => {
	it('names the channels, keys, value names and limits Notifications uses', () => {
		expect(TEMPLATE_CHANNELS).toEqual(['email', 'sms', 'whatsapp', 'push', 'staff_push']);
		expect(TEMPLATE_KEY.test('accounts.password_reset')).toBe(true);
		expect(TEMPLATE_KEY.test('Accounts.reset')).toBe(false);
		expect(TEMPLATE_KEY.test(`a${'b'.repeat(64)}`)).toBe(false);
		expect(VALUE_NAME.test('orderNumber')).toBe(true);
		expect(VALUE_NAME.test('1st')).toBe(false);
		expect(TEXT_LIMITS).toEqual({ email: 100_000, sms: 1600, whatsapp: 4096, push: 500, staff_push: 500 });
		expect(SUBJECT_LIMIT).toBe(200);
		expect(BUILT_IN_VALUES).toEqual(['unsubscribeUrl']);
		expect(TEMPLATE_CHANNELS.filter(isTitled)).toEqual(['email', 'push', 'staff_push']);
		// a send's values: 50 of 1,000 characters, a declared long value 50,000, all together 100,000
		expect([MAX_VALUES, VALUE_LIMIT, LONG_VALUE_LIMIT, VALUES_TOTAL_LIMIT]).toEqual([50, 1000, 50_000, 100_000]);
	});

	it('keeps long values out of the parts that stay short (subjects, titles, buttons)', () => {
		expect(longValueProblem('Your chat with {business}', ['transcript'])).toBeNull();
		expect(longValueProblem('Chat {?transcript}{transcript}{/transcript}', ['transcript'])).toBe(
			'{transcript} is long text: use it in the message only.',
		);
		expect(longValueProblem('{transcript}', [])).toBeNull();
	});

	it('finds placeholders and value names in order of first use', () => {
		expect(placeholdersOf('{a} {b} {a} {?c}x{/c}')).toEqual(['a', 'b']);
		expect(valueNamesOf('{a} {?c}{b}{/c} {a}')).toEqual(['a', 'c', 'b']);
	});

	it('checks optional sections', () => {
		expect(sectionProblem('{?a}x{?b}y{/b}{/a}')).toBeNull();
		expect(sectionProblem('{?a}x{?a}y{/a}{/a}')).toBe('{?a} is already open: close it with {/a} first.');
		expect(sectionProblem('{?a}{?b}{/a}{/b}')).toBe('Close {?b} before {/a}.');
		expect(sectionProblem('{/a}')).toBe('{/a} closes no {?a}.');
		expect(sectionProblem('{?a}x')).toBe('Close {?a} with {/a}.');
	});

	it('checks the words of each channel as Notifications does', () => {
		expect(wordsProblem('email', { subject: 'Hi', text: 'Hello' })).toBeNull();
		expect(wordsProblem('sms', { subject: '', text: 'Hello' })).toBeNull();
		expect(wordsProblem('sms', { subject: '', text: '' })).toEqual({ field: 'text', message: 'Write the message.' });
		expect(wordsProblem('sms', { subject: '', text: 'x'.repeat(1601) })).toEqual({
			field: 'text',
			message: 'The message can have at most 1600 characters.',
		});
		expect(wordsProblem('email', { subject: '', text: 'x' })).toEqual({ field: 'subject', message: 'Write the subject.' });
		expect(wordsProblem('push', { subject: '', text: 'x' })).toEqual({ field: 'subject', message: 'Write the title.' });
		expect(wordsProblem('email', { subject: 'a\nb', text: 'x' })).toEqual({
			field: 'subject',
			message: 'Use one line of at most 200 characters.',
		});
		expect(wordsProblem('email', { subject: 'Hi', text: '{?a}x' })).toEqual({
			field: 'text',
			message: 'Close {?a} with {/a}.',
		});
		expect(wordsProblem('email', { subject: '{?a}Hi', text: 'x' })).toEqual({
			field: 'subject',
			message: 'Close {?a} with {/a}.',
		});
	});
});

describe('message defaults (validateMessageDefaults)', () => {
	it('accepts a declaration with every channel kind, with or without the product id', () => {
		expect(validateMessageDefaults(declaration())).toMatchObject({ ok: true });
		expect(validateMessageDefaults({ messages: declaration().messages })).toMatchObject({ ok: true });
		expect(validateMessageDefaults({ messages: [] })).toMatchObject({ ok: true });
	});

	it('refuses shapes JSON Schema catches', () => {
		const wrong = declaration();
		expectProblem(validateMessageDefaults({ ...wrong, extra: 1 }), '/extra');
		expectProblem(validateMessageDefaults({ messages: [{ ...wrong.messages[0], channels: {} }] }), '/messages/0/channels');
		expectProblem(
			validateMessageDefaults({ messages: [{ ...wrong.messages[0], channels: { whatsapp: { text: 'x' } } }] }),
			'/messages/0/channels/whatsapp',
		);
		expectProblem(
			validateMessageDefaults({ messages: [{ ...wrong.messages[0], channels: { email: { text: 'x' } } }] }),
			'/messages/0/channels/email/subject',
		);
		expectProblem(
			validateMessageDefaults({ messages: [{ ...wrong.messages[0], channels: { sms: { subject: 'a', text: 'x' } } }] }),
			'/messages/0/channels/sms/subject',
		);
		expectProblem(validateMessageDefaults({ messages: [{ ...wrong.messages[0], key: 'Notes.x' }] }), '/messages/0/key');
		expectProblem(validateMessageDefaults({ messages: [{ ...wrong.messages[0], values: ['a', 'a'] }] }), '/messages/0/values');
		expectProblem(
			validateMessageDefaults({ messages: [{ ...wrong.messages[2], longValues: ['body', 'body'] }] }),
			'/messages/0/longValues',
		);
		expectProblem(
			validateMessageDefaults({ messages: [{ ...wrong.messages[2], longValues: ['1st'] }] }),
			'/messages/0/longValues/0',
		);
	});

	it('refuses repeated keys, keys of another product, words that break the rules and unknown values', () => {
		const repeated = declaration();
		repeated.messages.push({ ...repeated.messages[1] });
		expectProblem(validateMessageDefaults(repeated), '/messages/3/key', RULES.duplicateKey);

		const elsewhere = declaration();
		elsewhere.messages[1] = { ...elsewhere.messages[1], key: 'other.code' };
		expectProblem(validateMessageDefaults(elsewhere), '/messages/1/key', RULES.keyPrefix);

		const spaced = declaration();
		spaced.messages[1] = { ...spaced.messages[1], channels: { sms: { text: 'Your code is {code}. ' } } };
		expectProblem(validateMessageDefaults(spaced), '/messages/1/channels/sms/text', RULES.templateWords);

		const sections = declaration();
		sections.messages[1] = { ...sections.messages[1], channels: { sms: { text: '{?code}x' } } };
		expectProblem(validateMessageDefaults(sections), '/messages/1/channels/sms/text', RULES.templateWords);

		const long = declaration();
		long.messages[1] = { ...long.messages[1], channels: { sms: { text: 'x'.repeat(1601) } } };
		expectProblem(validateMessageDefaults(long), '/messages/1/channels/sms/text', RULES.templateWords);

		const unknown = declaration();
		unknown.messages[1] = { ...unknown.messages[1], channels: { sms: { text: 'Hi {name}' } } };
		expectProblem(validateMessageDefaults(unknown), '/messages/1/channels/sms', RULES.unknownValue);

		// {unsubscribeUrl} is filled in optional messages only
		const unsubscribe = declaration();
		unsubscribe.messages[1] = { ...unsubscribe.messages[1], channels: { sms: { text: '{code} {unsubscribeUrl}' } } };
		expectProblem(validateMessageDefaults(unsubscribe), '/messages/1/channels/sms', RULES.unknownValue);

		const builtIn = declaration();
		builtIn.messages[1] = { ...builtIn.messages[1], values: ['code', 'unsubscribeUrl'] };
		expectProblem(validateMessageDefaults(builtIn), '/messages/1/values/1', RULES.unknownValue);

		// a long value is one of the message's values, and goes in no subject or title
		const undeclared = declaration();
		undeclared.messages[2] = { ...undeclared.messages[2], longValues: ['body', 'summary'] };
		expectProblem(validateMessageDefaults(undeclared), '/messages/2/longValues/1', RULES.unknownValue);
		const titled = declaration();
		titled.messages[2] = {
			...titled.messages[2],
			channels: { email: { subject: 'Note: {body}', text: '{body}' }, push: { subject: '{title}', text: '{body}' } },
		};
		expectProblem(validateMessageDefaults(titled), '/messages/2/channels/email/subject', RULES.templateWords);
		expect(checkMessageDefaults(titled)).toEqual([
			expect.objectContaining({
				path: '/messages/2/channels/email/subject',
				message: '{body} is long text: use it in the message only.',
			}),
		]);
	});

	it('checks a declaration that passed its schema (checkMessageDefaults)', () => {
		expect(checkMessageDefaults(declaration())).toEqual([]);
		const wrong = declaration();
		wrong.messages[0] = { ...wrong.messages[0], channels: { push: { subject: 'Hi\nthere', text: 'x' } } };
		expectRule(checkMessageDefaults(wrong), RULES.templateWords, '/messages/0/channels/push/subject');
	});
});
