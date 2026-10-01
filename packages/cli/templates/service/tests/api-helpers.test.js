import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { fail, reply } from '../api/reply.js';
import { sessionView } from '../api/session.js';
import { createTranslator } from '../headless/strings.js';

describe('api helpers', () => {
	it('builds framework-free replies and problems', () => {
		assert.deepEqual(reply({ a: 1 }), { kind: 'ok', status: 200, body: { a: 1 } });
		assert.deepEqual(reply(null, { status: 201, headers: { location: '/v1/x' } }), {
			kind: 'ok',
			status: 201,
			body: null,
			headers: { location: '/v1/x' },
		});
		assert.deepEqual(fail('not_found'), { kind: 'problem', code: 'not_found' });
		assert.deepEqual(fail('validation_failed', 'bad input', [{ path: '/text', message: 'required' }]), {
			kind: 'problem',
			code: 'validation_failed',
			detail: 'bad input',
			errors: [{ path: '/text', message: 'required' }],
		});
	});

	it('describes launch sessions of every kind', () => {
		assert.deepEqual(sessionView({ kind: 'staff', role: 'support', subject: 'stf_1', scope: { actor: 'stf_1' } }), {
			kind: 'staff',
			role: 'support',
			scope: { actor: 'stf_1' },
			user: 'stf_1',
			actor: 'stf_1',
		});
		assert.deepEqual(sessionView({ kind: 'demo', role: 'viewer' }), {
			kind: 'demo',
			role: 'viewer',
			scope: {},
			user: null,
			actor: null,
		});
	});

	it('translates with placeholders and shows missing keys', () => {
		const t = createTranslator({ greeting: 'Hi {name}, {missing}' });
		assert.equal(t('greeting', { name: 'Ada' }), 'Hi Ada, {missing}');
		assert.equal(t('greeting'), 'Hi {name}, {missing}');
		assert.equal(t('absent.key'), 'absent.key');
	});
});
