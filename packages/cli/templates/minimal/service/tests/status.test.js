import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { MAX_GREETING, statusOf } from '../core/status.js';
import { sessionView } from '../api/session.js';
import { createTranslator } from '../headless/strings.js';

describe('status (placeholder element)', () => {
	it('reports the configured greeting, bounded', () => {
		assert.deepEqual(statusOf({ websiteId: 'web_1', config: { greeting: 'Hi' } }), {
			websiteId: 'web_1',
			ok: true,
			greeting: 'Hi',
		});
		assert.equal(statusOf({ websiteId: 'web_1', config: {} }).greeting, 'Hello');
		assert.equal(statusOf({ websiteId: 'web_1', config: { greeting: 'x'.repeat(200) } }).greeting.length, MAX_GREETING);
	});

	it('describes dashboard sessions and translates strings', () => {
		assert.deepEqual(sessionView({ kind: 'merchant', role: 'owner', user: { id: 'usr_1' } }), {
			kind: 'merchant',
			role: 'owner',
			scope: {},
			user: 'usr_1',
		});
		assert.equal(createTranslator({ 'a.b': 'Hi {name}' })('a.b', { name: 'Ada' }), 'Hi Ada');
	});
});
