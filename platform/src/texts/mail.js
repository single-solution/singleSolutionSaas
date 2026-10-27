/**
 * Texts of the Portal emails (PLAN 0.5.10), in English. Every email shows the Branding name and ends with the
 * support contact (added by the mailer). Variables come from `data` (single line, bounded) and are HTML-escaped.
 * @module
 */
import { supportContactLine } from '@ss/contracts/text';

/**
 * @typedef {object} MailText
 * @property {(d: Record<string, string>) => string} subject
 * @property {(d: Record<string, string>) => string[]} lines paragraphs before the button
 * @property {string | null} action button label (null: the email has no link)
 * @property {string} footer paragraph after the button
 */

/** @type {Readonly<Record<string, MailText>>} */
export const MAIL_TEXTS = Object.freeze({
	merchant_setup: {
		subject: (d) => `Your ${d.merchantName ?? 'merchant'} account on ${d.brand}`,
		lines: (d) => [
			`An account for ${d.merchantName ?? 'your business'} was created for you on ${d.brand}.`,
			'Choose a password to sign in.',
		],
		action: 'Set your password',
		footer: 'The link works once and expires in 72 hours. If you did not expect this, ignore this message.',
	},
	admin_invite: {
		subject: (d) => `You are invited to ${d.brand}`,
		lines: (d) => [`You have been invited to ${d.brand} as ${d.role ?? 'an admin'}.`, 'Choose your name and password to join.'],
		action: 'Accept the invite',
		footer: 'The link works once and expires in 24 hours. If you did not expect this, ignore this message.',
	},
	password_reset: {
		subject: (d) => `Reset your ${d.brand} password`,
		lines: () => ['We received a request to reset your password.'],
		action: 'Choose a new password',
		footer:
			'The link works once and expires in 30 minutes. If you did not ask for a reset, ignore this message; your password is unchanged.',
	},
	step_up_otp: {
		subject: (d) => `Your ${d.brand} verification code`,
		lines: (d) => [
			`Your single-use verification code is ${d.otp ?? '000000'}.`,
			'Enter this code to complete your step-up action in the Portal.',
		],
		action: null,
		footer: 'The code expires in 10 minutes. If you did not ask for this code, ignore this message.',
	},
	email_change_confirm: {
		subject: (d) => `Confirm your new ${d.brand} sign-in email`,
		lines: () => ['Confirm this address to use it as your sign-in email. Until you do, your old address stays in use.'],
		action: 'Confirm this email',
		footer: 'The link works once and expires in 24 hours. If you did not ask for this change, ignore this message.',
	},
	email_change_notice: {
		subject: (d) => `Your ${d.brand} sign-in email is changing`,
		lines: (d) => [
			`Someone asked to change the sign-in email of your ${d.brand} account to ${d.newEmail ?? 'another address'}.`,
			'The change takes effect only when the new address is confirmed.',
		],
		action: null,
		footer: 'If this was not you, contact support at once.',
	},
	two_step_off: {
		subject: (d) => `Two-step sign-in was turned off on your ${d.brand} account`,
		lines: (d) => [
			`An Owner of ${d.brand} turned off two-step sign-in on your account and deleted your recovery codes.`,
			'You can set two-step sign-in up again from your account page.',
		],
		action: null,
		footer: 'If you did not ask for this, contact support.',
	},
	connection_changed: {
		subject: (d) => `${d.brand}: a connection of ${d.website ?? 'your website'} was changed`,
		lines: (d) => [
			`${d.what ?? 'A connection'} for ${d.website ?? 'your website'}. ${d.who ?? 'Someone'} did it.`,
			'The products on the website pick the change up on their own. The value itself is never shown again.',
		],
		action: null,
		footer: 'If this was not you, sign in to the Portal and replace the connection, and change your password.',
	},
	connection_fetch_alert: {
		subject: (d) =>
			d.kind === 'cap'
				? `${d.brand}: ${d.product} hit the hourly limit for website connections`
				: `${d.brand}: ${d.product} is fetching website connections unusually often`,
		lines: (d) => [
			`${d.product} fetched the connections (database, storage, AI key) of websites ${d.count} times in the last hour. The warning line is ${d.warning} and the hourly limit is ${d.cap}.`,
			d.kind === 'cap'
				? 'The Portal now refuses further fetches from this product until the hour is over.'
				: 'Nothing is refused yet. The Portal stops further fetches from this product at the hourly limit.',
			'A stolen product key would look like this. If the product is not doing something unusual, renew its key in the Portal.',
		],
		action: null,
		footer: 'This alert is sent once an hour per product and kind.',
	},
	low_balance: {
		subject: (d) => `${d.brand}: credits are running low`,
		lines: (d) => [
			`${d.merchantName ?? 'Your account'} has ${d.balance ?? 'few credits'} left, about ${d.daysLeft ?? 'a few days'} at the current spend.`,
			'Add credits to keep the products running.',
		],
		action: null,
		footer: 'Contact support to add credits.',
	},
	grace_started: {
		subject: (d) => `Credits ran out: products stop on ${d.stopAt ?? 'the end of the grace period'}`,
		lines: (d) => [
			`The credits of ${d.merchantName ?? 'your account'} ran out. The products keep working until ${d.stopAt ?? 'the end of the grace period'}, and those hours are charged.`,
			'Add credits before then to keep them running; new credits pay the debt first.',
		],
		action: null,
		footer: 'Contact support to add credits.',
	},
	products_stopped: {
		subject: (d) => `${d.brand}: products stopped`,
		lines: (d) => [
			`The grace period of ${d.merchantName ?? 'your account'} ended on ${d.stoppedAt ?? 'its end date'} with no credits left, so its products stopped.`,
			'They restart as soon as new credits bring the balance above 0.',
		],
		action: null,
		footer: 'Contact support to add credits.',
	},
	credits_added: {
		subject: (d) => `${d.credits ?? 'Credits'} added to your ${d.brand} account`,
		lines: (d) => [
			`${d.credits ?? 'Credits'} were added to ${d.merchantName ?? 'your account'}.`,
			`The balance is now ${d.balance ?? 'updated'}.`,
		],
		action: null,
		footer: 'No action is needed.',
	},
	test_email: {
		subject: (d) => `${d.brand} test email`,
		lines: () => ['This is a test email from the Portal. Email sending works.'],
		action: null,
		footer: 'No action is needed.',
	},
});

/** Closing line with the support contact (its channels), or null without channels. */
export const supportLine = (/** @type {{ channels: import('@ss/contracts/text').SupportChannel[] }} */ support) =>
	support.channels.length > 0 ? `Support: ${supportContactLine(support.channels)}.` : null;
