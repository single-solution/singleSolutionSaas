import { createServer } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
	MAIL_TEMPLATES,
	createLogMailer,
	createPlatformMailer,
	createSmtpMailer,
	createUnavailableMailer,
	escapeHtml,
	renderMail,
	smtpTransportOptions,
} from '../src/infra/mailer.js';
import { isProblem } from '../src/infra/http.js';
import { createTestLogger } from './helpers.js';

const LINK = 'https://portal.test/verify?token=abc&x=1';
const SMTP = { host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p' };

/**
 * Minimal SMTP server (no TLS, no auth): records every DATA payload.
 * @returns {Promise<{ port: number, messages: string[], close: () => Promise<void> }>}
 */
const startSmtp = async () => {
	/** @type {string[]} */
	const messages = [];
	const server = createServer((socket) => {
		let data = false;
		let buffer = '';
		socket.write('220 test ESMTP\r\n');
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			for (;;) {
				if (data) {
					const end = buffer.indexOf('\r\n.\r\n');
					if (end === -1) return;
					messages.push(buffer.slice(0, end));
					buffer = buffer.slice(end + 5);
					data = false;
					socket.write('250 queued\r\n');
					continue;
				}
				const eol = buffer.indexOf('\r\n');
				if (eol === -1) return;
				const line = buffer.slice(0, eol).toUpperCase();
				buffer = buffer.slice(eol + 2);
				if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write('250-test\r\n250 OK\r\n');
				else if (line.startsWith('DATA')) {
					data = true;
					socket.write('354 go\r\n');
				} else if (line.startsWith('QUIT')) socket.end('221 bye\r\n');
				else socket.write('250 OK\r\n');
			}
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	return {
		port: address.port,
		messages,
		close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
	};
};

describe('mail templates', () => {
	it('renders every template as text and simple HTML without external assets', () => {
		for (const template of MAIL_TEMPLATES) {
			const mail = renderMail(template, { link: LINK, merchantName: 'Acme <b>&</b>' });
			expect(mail.subject.length).toBeGreaterThan(5);
			expect(mail.text).toContain(LINK);
			expect(mail.html).toContain(escapeHtml(LINK));
			expect(mail.html).not.toMatch(/<img|<link|<script|src=|url\(/i);
			expect(mail.html).not.toContain('<b>&</b>');
		}
		expect(renderMail('invite', { link: LINK, merchantName: 'Acme' }).subject).toBe(
			'You are invited to Acme on Single Solution',
		);
		expect(renderMail('invite', { link: LINK }).subject).toBe('You are invited to Single Solution');
		expect(renderMail('verify_email', { link: LINK }).text).toContain('your Single Solution account');
		expect(renderMail('verify_email', { link: LINK, merchantName: 'Acme' }).text).toContain('the Acme account');
		// header injection through data is flattened
		expect(renderMail('invite', { link: LINK, merchantName: 'A\r\nBcc: x@y.z' }).subject).not.toMatch(/[\r\n]/);
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
	});

	it('refuses unknown templates and unsafe links', () => {
		expect(() => renderMail(/** @type {any} */ ('other'), { link: LINK })).toThrow(/unknown mail template/);
		expect(() => renderMail('invite', {})).toThrow(/link is required/);
		expect(() => renderMail('invite', { link: 'not a url' })).toThrow(/absolute/);
		expect(() => renderMail('invite', { link: 'javascript:alert(1)' })).toThrow(/http/);
		expect(() => renderMail('invite', { link: 'https://u:p@portal.test/x' })).toThrow(/credentials/);
	});
});

describe('platform mailer', () => {
	/** @type {Array<() => Promise<void>>} */
	const cleanups = [];
	afterAll(async () => {
		for (const cleanup of cleanups) await cleanup();
	});

	it('builds pooled, timed-out, TLS-enforcing transport options', () => {
		const prod = smtpTransportOptions(SMTP, { isProduction: true });
		expect(prod).toMatchObject({
			pool: true,
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			requireTLS: true,
			auth: { user: 'u', pass: 'p' },
			tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
			connectionTimeout: 10_000,
			greetingTimeout: 10_000,
			socketTimeout: 10_000,
			disableFileAccess: true,
			disableUrlAccess: true,
		});
		expect(smtpTransportOptions({ ...SMTP, secure: true, port: 465 }, { isProduction: true }).requireTLS).toBe(false);
		expect(smtpTransportOptions(SMTP, { isProduction: false }).requireTLS).toBe(false);
		expect(smtpTransportOptions({ ...SMTP, user: null, pass: null }, { isProduction: false })).not.toHaveProperty('auth');
		expect(smtpTransportOptions({ ...SMTP, pass: null }, { isProduction: false }).auth).toEqual({ user: 'u', pass: '' });
	});

	it('sends through one lazily created transport and maps failures to 503', async () => {
		/** @type {any[]} */
		const sent = [];
		let created = 0;
		let closed = 0;
		let fail = false;
		const { logger, entries } = createTestLogger();
		const mailer = createSmtpMailer({
			smtp: SMTP,
			from: 'Portal <no-reply@example.com>',
			isProduction: true,
			logger,
			createTransport: (options) => {
				created += 1;
				expect(options.requireTLS).toBe(true);
				return {
					sendMail: async (message) => {
						if (fail) throw new Error('smtp down');
						sent.push(message);
					},
					close: () => void (closed += 1),
				};
			},
		});
		expect(mailer.available).toBe(true);
		await mailer.send({ to: 'a@example.com', template: 'password_reset', data: { link: LINK } });
		await mailer.send({ to: 'b@example.com', template: 'staff_welcome', data: { link: LINK } });
		expect(created).toBe(1);
		expect(sent.map((m) => [m.from, m.to])).toEqual([
			['Portal <no-reply@example.com>', 'a@example.com'],
			['Portal <no-reply@example.com>', 'b@example.com'],
		]);
		expect(sent[0]).toMatchObject({ subject: 'Reset your Single Solution password' });
		expect(sent[0].text).toContain(LINK);
		fail = true;
		const error = await mailer.send({ to: 'a@example.com', template: 'invite', data: { link: LINK } }).catch((e) => e);
		expect(isProblem(error) && error.code).toBe('unavailable');
		const warning = entries.find((e) => e.msg === 'mail delivery failed');
		expect(JSON.stringify(warning)).not.toContain('token=abc');
		await expect(mailer.send({ to: 'not an address', template: 'invite', data: { link: LINK } })).rejects.toThrow(/recipient/);
		await expect(mailer.send({ to: 'a@example.com\r\nBcc: x@y.z', template: 'invite', data: { link: LINK } })).rejects.toThrow(
			/recipient/,
		);
		await mailer.close?.();
		await mailer.close?.();
		expect(closed).toBe(1);
	});

	it('delivers through nodemailer to an SMTP server', async () => {
		const smtp = await startSmtp();
		cleanups.push(smtp.close);
		const { logger } = createTestLogger();
		const mailer = createSmtpMailer({
			smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: null, pass: null },
			from: 'Portal <no-reply@example.com>',
			isProduction: false,
			logger,
		});
		cleanups.unshift(async () => mailer.close?.());
		await mailer.send({ to: 'owner@example.com', template: 'invite', data: { link: LINK, merchantName: 'Acme' } });
		expect(smtp.messages).toHaveLength(1);
		expect(smtp.messages[0]).toContain('To: owner@example.com');
		expect(smtp.messages[0]).toContain('Subject: You are invited to Acme on Single Solution');
	});

	it('chooses SMTP, logging or unavailable from the configuration', async () => {
		const { logger, entries } = createTestLogger();
		const smtpConfig = {
			env: /** @type {const} */ ('production'),
			isProduction: true,
			mail: { smtp: SMTP, from: 'a@example.com' },
		};
		/** @type {any[]} */
		const sent = [];
		const viaSmtp = createPlatformMailer({
			config: smtpConfig,
			logger,
			createTransport: () => ({ sendMail: async (m) => void sent.push(m), close: () => {} }),
		});
		await viaSmtp.send({ to: 'x@example.com', template: 'verify_email', data: { link: LINK } });
		expect(sent).toHaveLength(1);
		expect(createPlatformMailer({ config: smtpConfig, logger }).available).toBe(true);

		for (const env of /** @type {const} */ (['production'])) {
			const none = createPlatformMailer({
				config: { env, isProduction: env === 'production', mail: { smtp: null, from: null } },
				logger,
			});
			expect(none.available).toBe(false);
			const error = await none.send({ to: 'x@example.com', template: 'invite', data: { link: LINK } }).catch((e) => e);
			expect(isProblem(error) && error.code).toBe('unavailable');
		}
		const dev = createPlatformMailer({
			config: { env: 'development', isProduction: false, mail: { smtp: null, from: null } },
			logger,
		});
		await dev.send({ to: 'x@example.com', template: 'invite', data: { link: LINK } });
		expect(entries.find((e) => e.msg === 'mail (development mailer)')?.fields).toMatchObject({
			to: 'x@example.com',
			template: 'invite',
			link: LINK,
		});
		expect(createLogMailer(logger).available).toBe(true);
		expect(createUnavailableMailer().available).toBe(false);
	});
});
