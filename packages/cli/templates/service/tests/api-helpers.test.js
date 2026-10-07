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
		assert.deepEqual(sessionView({ kind: 'admin', role: 'support', subject: 'stf_1', scope: { merchantId: 'mer_1' } }), {
			kind: 'admin',
			role: 'support',
			scope: { merchantId: 'mer_1' },
			user: 'stf_1',
		});
		assert.deepEqual(sessionView({ kind: 'merchant', role: 'viewer' }), {
			kind: 'merchant',
			role: 'viewer',
			scope: {},
			user: null,
		});
	});

	it('translates with placeholders and shows missing keys', () => {
		const t = createTranslator({ greeting: 'Hi {name}, {missing}' });
		assert.equal(t('greeting', { name: 'Ada' }), 'Hi Ada, {missing}');
		assert.equal(t('greeting'), 'Hi {name}, {missing}');
		assert.equal(t('absent.key'), 'absent.key');
	});
});
