/**
 * The fixed limits of Accounts (core/limits.js) are the old defaults of the merchant settings they replaced, so
 * nothing changed for any website, and no settings schema offers them any more.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as limits from '../core/limits.js';

/** The settings that became constants: `feature.setting` and the value they had by default (settings-ownership class C). */
const GOLDEN = /** @type {Array<[string, number, string]>} */ ([
	['custom_fields.maxFields', 50, 'MAX_CUSTOM_FIELDS'],
	['custom_fields.maxChoices', 50, 'MAX_CHOICES'],
	['email_code.codeLength / phone.codeLength', 6, 'CODE_LENGTH'],
	['email_code.codeMinutes / phone.codeMinutes', 10, 'CODE_MINUTES'],
	['email_code.cooldownSeconds / phone.cooldownSeconds', 30, 'CODE_COOLDOWN_SECONDS'],
	['email_code.perHour / phone.perHour', 6, 'CODES_PER_HOUR'],
	['email_code.codeTries / phone.codeTries', 5, 'CODE_ATTEMPTS'],
	['staff_links.codeMinutes', 15, 'STAFF_CODE_MINUTES'],
	['email_password.maxLength / phone_password.maxLength', 256, 'PASSWORD_MAX_LENGTH'],
	['email_password.maxAttempts / phone_password.maxAttempts', 5, 'PASSWORD_MAX_ATTEMPTS'],
	['email_password.lockMinutes / phone_password.lockMinutes', 15, 'PASSWORD_LOCK_MINUTES'],
	['email_password.forgetHours / phone_password.forgetHours', 24, 'PASSWORD_FORGET_HOURS'],
	['email_password.resetMinutes', 60, 'RESET_MINUTES'],
	['email_password.resetLimit', 3, 'RESET_LIMIT'],
	['roles.maxRoles', 100, 'MAX_ROLES'],
	['profile.maxAddresses', 10, 'ADDRESSES_PER_USER'],
]);

/** Behaviour that was a switch and is now fixed in the code: breachedCheck on, lockMode fixed, networkLimit off, revealStatus off. */
const REMOVED_KEYS = [
	'maxFields',
	'maxChoices',
	'codeLength',
	'codeMinutes',
	'cooldownSeconds',
	'perHour',
	'codeTries',
	'maxLength',
	'breachedCheck',
	'maxAttempts',
	'lockMinutes',
	'forgetHours',
	'resetMinutes',
	'resetLimit',
	'lockMode',
	'networkLimit',
	'maxAddresses',
	'revealStatus',
	'maxRoles',
];

describe('fixed limits', () => {
	it.each(GOLDEN)('%s is %s (the old default)', (_setting, value, name) => {
		expect(/** @type {Record<string, unknown>} */ (limits)[name]).toBe(value);
	});

	it('no settings schema offers a removed limit', () => {
		const folder = new URL('../schemas/', import.meta.url);
		const offered = [];
		for (const file of readdirSync(folder).filter((name) => /\.(settings|shared)\.json$/.test(name)))
			for (const key of Object.keys(JSON.parse(readFileSync(new URL(file, folder), 'utf8')).properties))
				if (REMOVED_KEYS.includes(key)) offered.push(`${file}: ${key}`);
		expect(offered).toEqual([]);
	});
});
