import { createServer } from 'node:net';
import { createOutboundPolicy } from '@ss/net';
import { describe, expect, it } from 'vitest';
import { SMTP_PORTS, createSmtpMessaging, smtpSettingsOf } from '../src/adapters/smtp.js';

const publicResolve = async () => [{ address: '93.184.215.14', family: 4 }];
const policy = createOutboundPolicy({ resolve: publicResolve });
/** An SMTP connection value. */
const PORTAL = {
	provider: 'smtp',
	baseUrl: 'smtps://smtp.example.com:465',
	apiKey: 'smtp-secret-password',
	username: 'mailer@example.com',
	from: 'shop@example.com',
};

/**
 * A fake nodemailer transport factory recording what it was given.
 * @param {(mail: Record<string, any>) => any} [answer]
 */
const fakeTransport = (answer = (mail) => ({ messageId: '<m1@example.com>', accepted: mail.to, rejected: [] })) => {
	/** @type {{ options: any[], mails: any[], closed: number }} */
	const seen = { options: [], mails: [], closed: 0 };
	/** @type {import('../src/adapters/smtp.js').CreateSmtpTransport} */
	const createTransport = (options) => {
		seen.options.push(options);
		return {
			sendMail: async (mail) => {
				seen.mails.push(mail);
				return answer(mail);
			},
			close: () => {
				seen.closed += 1;
			},
		};
	};
	return { seen, createTransport };
};

describe('SMTP descriptor', () => {
	it('reads the Portal form (smtps:// / smtp:// URL, apiKey = password) and the explicit form', () => {
		expect(smtpSettingsOf(PORTAL, policy)).toEqual({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			allowlisted: false,
			ip: false,
			username: 'mailer@example.com',
			password: 'smtp-secret-password',
			from: 'shop@example.com',
		});
		expect(smtpSettingsOf({ ...PORTAL, baseUrl: 'smtp://smtp.example.com:587' }, policy)).toMatchObject({
			port: 587,
			secure: false,
		});
		expect(smtpSettingsOf({ ...PORTAL, baseUrl: 'smtp://smtp.example.com' }, policy).port).toBe(587);
		expect(smtpSettingsOf({ ...PORTAL, baseUrl: 'smtps://smtp.example.com' }, policy).port).toBe(465);
		const explicit = { host: 'smtp.example.com', username: 'u', password: 'p' };
		expect(smtpSettingsOf(explicit, policy)).toMatchObject({ port: 465, secure: true });
		expect('from' in smtpSettingsOf(explicit, policy)).toBe(false);
		expect(smtpSettingsOf({ ...explicit, port: 587 }, policy)).toMatchObject({ port: 587, secure: false });
		expect(smtpSettingsOf({ ...explicit, secure: false }, policy)).toMatchObject({ port: 587, secure: false });
		expect(SMTP_PORTS).toEqual([25, 465, 587, 2525]);
	});

	it('refuses internal hosts, odd ports, credentials in the URL and incomplete descriptors (connection_invalid)', () => {
		const refused = [
			{ ...PORTAL, baseUrl: 'smtps://localhost:465' },
			{ ...PORTAL, baseUrl: 'smtps://10.0.0.5:465' },
			{ ...PORTAL, baseUrl: 'smtps://169.254.169.254:465' },
			{ ...PORTAL, baseUrl: 'smtps://mail.internal:465' },
			{ ...PORTAL, baseUrl: 'smtps://smtp.example.com:22' },
			{ ...PORTAL, baseUrl: 'smtps://user:pw@smtp.example.com:465' },
			{ ...PORTAL, baseUrl: 'https://smtp.example.com' },
			{ ...PORTAL, baseUrl: 'smtps://smtp.example.com/path' },
			{ ...PORTAL, baseUrl: 'not a url' },
			{ ...PORTAL, apiKey: '' },
			{ ...PORTAL, username: undefined },
			{ ...PORTAL, from: 'not-an-address' },
			{ provider: 'smtp', username: 'u', password: 'p' },
			{ host: 'smtp.example.com', port: '465', username: 'u', password: 'p' },
			{ host: 'smtp.example.com', secure: 'yes', username: 'u', password: 'p' },
		];
		for (const descriptor of refused) {
			expect(() => createSmtpMessaging({ descriptor, policy }), JSON.stringify(descriptor)).toThrow(
				expect.objectContaining({ code: 'connection_invalid' }),
			);
		}
		// the development allowlist admits a local server on any port
		const dev = createOutboundPolicy({ allowHosts: ['localhost'] });
		expect(smtpSettingsOf({ ...PORTAL, baseUrl: 'smtp://localhost:1025' }, dev)).toMatchObject({
			allowlisted: true,
			port: 1025,
		});
	});
});

describe('SMTP messaging adapter', () => {
	it('connects to the vetted IP with TLS required, the host as servername, and timeouts', async () => {
		const { seen, createTransport } = fakeTransport();
		const smtp = createSmtpMessaging({ descriptor: PORTAL, policy, createTransport });
		expect(smtp).toMatchObject({ kind: 'messaging', provider: 'smtp' });
		const result = await smtp.send({ to: 'buyer@example.org', subject: 'Back in stock', text: 'Hello' });
		expect(result).toEqual({ id: '<m1@example.com>', accepted: ['buyer@example.org'], rejected: [] });
		expect(seen.options[0]).toEqual({
			host: '93.184.215.14',
			port: 465,
			secure: true,
			requireTLS: false,
			servername: 'smtp.example.com',
			auth: { user: 'mailer@example.com', pass: 'smtp-secret-password' },
			tls: { servername: 'smtp.example.com', minVersion: 'TLSv1.2', rejectUnauthorized: true },
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
			socketTimeout: 30_000,
			pool: false,
		});
		expect(seen.mails[0]).toEqual({
			from: 'shop@example.com',
			to: ['buyer@example.org'],
			subject: 'Back in stock',
			text: 'Hello',
			disableFileAccess: true,
			disableUrlAccess: true,
		});
		expect(seen.closed).toBe(1);
		const starttls = fakeTransport();
		await createSmtpMessaging({
			descriptor: { ...PORTAL, baseUrl: 'smtp://smtp.example.com:587' },
			policy,
			createTransport: starttls.createTransport,
			timeouts: { socketMs: 5_000 },
		}).send({ to: ['a@example.org', 'b@example.org'], subject: 's', html: '<p>x</p>', replyTo: 'Help <help@example.com>' });
		expect(starttls.seen.options[0]).toMatchObject({ port: 587, secure: false, requireTLS: true, socketTimeout: 5_000 });
		expect(starttls.seen.mails[0]).toMatchObject({
			to: ['a@example.org', 'b@example.org'],
			replyTo: 'Help <help@example.com>',
		});
	});

	it('vets every DNS answer at send time (rebinding) and refuses before connecting', async () => {
		let answer = '93.184.215.14';
		const rebinding = createOutboundPolicy({ resolve: async () => [{ address: answer, family: 4 }] });
		const { seen, createTransport } = fakeTransport();
		const smtp = createSmtpMessaging({ descriptor: PORTAL, policy: rebinding, createTransport });
		await smtp.send({ to: 'a@example.org', subject: 's', text: 't' });
		answer = '10.1.2.3';
		const error = await smtp.send({ to: 'a@example.org', subject: 's', text: 't' }).catch((e) => e);
		expect(error).toMatchObject({ code: 'upstream_error', details: { reason: 'ssrf_blocked' } });
		expect(seen.options).toHaveLength(1);
		// an IP literal host is checked up front and used as is (no servername)
		const literal = fakeTransport();
		await createSmtpMessaging({
			descriptor: { ...PORTAL, baseUrl: 'smtps://93.184.215.14:465' },
			policy,
			createTransport: literal.createTransport,
		}).send({ to: 'a@example.org', subject: 's', text: 't' });
		expect(literal.seen.options[0]).toMatchObject({ host: '93.184.215.14', tls: { minVersion: 'TLSv1.2' } });
		expect(literal.seen.options[0].servername).toBeUndefined();
	});

	it('validates messages against header injection', async () => {
		const { seen, createTransport } = fakeTransport();
		const smtp = createSmtpMessaging({ descriptor: { ...PORTAL, from: undefined }, policy, createTransport });
		const bad = [
			{ to: 'a@example.org\r\nBcc: x@evil.test', subject: 's', text: 't' },
			{ to: 'Name <a@example.org>', subject: 's', text: 't' },
			{ to: [], subject: 's', text: 't' },
			{ to: Array.from({ length: 51 }, (_, i) => `a${i}@example.org`), subject: 's', text: 't' },
			{ to: 'a@example.org', subject: 'hi\r\nBcc: x@evil.test', text: 't' },
			{ to: 'a@example.org', subject: '', text: 't' },
			{ to: 'a@example.org', subject: 's' },
			{ to: 'a@example.org', subject: 's', text: 42 },
			{ to: 'a@example.org', subject: 's', text: 't', from: 'x@example.com\nBcc: y@evil.test' },
			{ to: 'a@example.org', subject: 's', text: 't', replyTo: 'nope' },
			{ to: 'a@example.org', subject: 's', text: 't', headers: { Bcc: 'x@evil.test' } },
			{ to: 'a@example.org', subject: 's', text: 't', headers: { 'X-Tag': 'a\r\nBcc: x@evil.test' } },
			{ to: 'a@example.org', subject: 's', text: 't', headers: { 'X Tag': 'a' } },
			'not an object',
		];
		for (const message of bad) {
			await expect(smtp.send(/** @type {any} */ (message)), JSON.stringify(message)).rejects.toMatchObject({
				code: 'invalid_argument',
			});
		}
		expect(seen.options).toHaveLength(0);
		// from defaults to the username when it is an address; extra headers pass through
		await smtp.send({
			to: 'a@example.org',
			subject: 's',
			text: 't',
			from: 'Shop <shop@example.com>',
			headers: { 'List-Unsubscribe': '<https://example.com/u>' },
		});
		expect(seen.mails[0]).toMatchObject({
			from: 'Shop <shop@example.com>',
			headers: { 'List-Unsubscribe': '<https://example.com/u>' },
		});
		await smtp.send({ to: 'a@example.org', subject: 's', text: 't' });
		expect(seen.mails[1].from).toBe('mailer@example.com');
		const noFrom = createSmtpMessaging({
			descriptor: { ...PORTAL, from: undefined, username: 'apikey' },
			policy,
			createTransport,
		});
		await expect(noFrom.send({ to: 'a@example.org', subject: 's', text: 't' })).rejects.toMatchObject({
			code: 'invalid_argument',
		});
	});

	it('maps transport failures to timeout / upstream_error without credentials', async () => {
		/** @param {Record<string, unknown>} fields */
		const failing = (fields) =>
			fakeTransport(() => {
				throw Object.assign(new Error(`535 auth failed for mailer@example.com smtp-secret-password`), fields);
			});
		const timeout = failing({ code: 'ETIMEDOUT' });
		const err1 = await createSmtpMessaging({ descriptor: PORTAL, policy, createTransport: timeout.createTransport })
			.send({ to: 'a@example.org', subject: 's', text: 't' })
			.catch((e) => e);
		expect(err1).toMatchObject({ code: 'timeout', details: { reason: 'ETIMEDOUT' } });
		expect(timeout.seen.closed).toBe(1);
		const auth = failing({ code: 'EAUTH', responseCode: 535 });
		const err2 = await createSmtpMessaging({ descriptor: PORTAL, policy, createTransport: auth.createTransport })
			.send({ to: 'a@example.org', subject: 's', text: 't' })
			.catch((e) => e);
		expect(err2).toMatchObject({ code: 'upstream_error', details: { reason: 'EAUTH', responseCode: 535 } });
		expect(`${err2.message} ${JSON.stringify(err2.details)}`).not.toMatch(/smtp-secret-password|mailer@example\.com/);
		const dns = createOutboundPolicy({
			resolve: async () => {
				throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
			},
		});
		await expect(
			createSmtpMessaging({ descriptor: PORTAL, policy: dns, createTransport: auth.createTransport }).send({
				to: 'a@example.org',
				subject: 's',
				text: 't',
			}),
		).rejects.toMatchObject({ code: 'upstream_error', details: { reason: 'network' } });
	});
});

describe('SMTP over a local server (allowlisted development host, real nodemailer)', () => {
	it('delivers through nodemailer to the vetted address', async () => {
		/** @type {string[]} */
		const commands = [];
		let data = '';
		const server = createServer((socket) => {
			let inData = false;
			let buffer = '';
			socket.write('220 localhost ESMTP test\r\n');
			socket.on('data', (chunk) => {
				buffer += chunk.toString('utf8');
				let index;
				while ((index = buffer.indexOf('\r\n')) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					if (inData) {
						if (line === '.') {
							inData = false;
							socket.write('250 2.0.0 queued as T1\r\n');
						} else data += `${line}\n`;
						continue;
					}
					commands.push(line.split(' ')[0]?.toUpperCase() ?? '');
					if (/^(EHLO|HELO)/i.test(line)) socket.write('250-localhost\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
					else if (/^AUTH/i.test(line)) socket.write('235 2.7.0 ok\r\n');
					else if (/^DATA/i.test(line)) {
						inData = true;
						socket.write('354 go\r\n');
					} else if (/^QUIT/i.test(line)) {
						socket.write('221 bye\r\n');
						socket.end();
					} else socket.write('250 ok\r\n');
				}
			});
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
		const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
		try {
			const dev = createOutboundPolicy({
				allowHosts: ['mail.test'],
				resolve: async () => [{ address: '127.0.0.1', family: 4 }],
			});
			const smtp = createSmtpMessaging({
				descriptor: { ...PORTAL, baseUrl: `smtp://mail.test:${port}` },
				policy: dev,
				timeouts: { connectionMs: 2_000, greetingMs: 2_000, socketMs: 2_000 },
			});
			const result = await smtp.send({
				to: 'buyer@example.org',
				subject: 'Back in stock',
				text: 'Your item is back.',
				headers: { 'X-Alert-Id': 'al_1' },
			});
			expect(result.accepted).toEqual(['buyer@example.org']);
			expect(result.rejected).toEqual([]);
			expect(typeof result.id).toBe('string');
			expect(commands).toEqual(expect.arrayContaining(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']));
			expect(data).toMatch(/Subject: Back in stock/);
			expect(data).toMatch(/X-Alert-Id: al_1/i);
			expect(data).toMatch(/From: shop@example.com/);
		} finally {
			await new Promise((resolve) => server.close(() => resolve(undefined)));
		}
	});
});
