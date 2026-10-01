/**
 * The `mailer` port of the identity module. Identity never talks to an e-mail provider itself: the composition
 * root injects a mailer (`createIdentityModule({ mailer })`). A real SMTP/provider mailer is a connector concern
 * (PLAN §1a); until one is wired, development and tests use the logging mailer, and production refuses to send.
 * @module
 */
import { problem } from '../../infra/http.js';

/**
 * @typedef {'verify_email' | 'account_exists' | 'password_reset' | 'invite' | 'staff_welcome'} MailTemplate
 *
 * @typedef {object} MailMessage
 * @property {string} to recipient address (already normalised)
 * @property {MailTemplate} template
 * @property {Record<string, string>} data template variables, e.g. `{ link, merchantName }`
 *
 * @typedef {object} Mailer
 * @property {boolean} [available] false when nothing can be sent (requests that must send answer 503)
 * @property {(message: MailMessage) => Promise<void>} send
 */

/**
 * Development mailer: writes the message (including its one-time link) to the logger. Never use in production —
 * the link carries a live token.
 * @param {import('../../infra/logger.js').Logger} logger
 * @returns {Mailer}
 */
export const createLogMailer = (logger) =>
	Object.freeze({
		available: true,
		send: async (/** @type {MailMessage} */ { to, template, data }) => {
			logger.info('mail (development mailer)', { to, template, ...data });
		},
	});

/**
 * Production default until a mail connector exists: every send fails with 503.
 * @returns {Mailer}
 */
export const createUnavailableMailer = () =>
	Object.freeze({
		available: false,
		send: async () => {
			throw problem('unavailable', 'E-mail delivery is not configured.', { headers: { 'retry-after': '3600' } });
		},
	});
