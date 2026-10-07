/**
 * Texts of the Portal e-mails (PLAN 0.5.10), in English. Every e-mail shows the Branding name and ends with the
 * support contact (added by the mailer). Variables come from `data` (single line, bounded) and are HTML-escaped.
 * @module
 */

/**
 * @typedef {object} MailText
 * @property {(d: Record<string, string>) => string} subject
 * @property {(d: Record<string, string>) => string[]} lines paragraphs before the button
 * @property {string | null} action button label (null: the e-mail has no link)
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
	email_change_confirm: {
		subject: (d) => `Confirm your new ${d.brand} sign-in e-mail`,
		lines: () => ['Confirm this address to use it as your sign-in e-mail. Until you do, your old address stays in use.'],
		action: 'Confirm this e-mail',
		footer: 'The link works once and expires in 24 hours. If you did not ask for this change, ignore this message.',
	},
	email_change_notice: {
		subject: (d) => `Your ${d.brand} sign-in e-mail is changing`,
		lines: (d) => [
			`Someone asked to change the sign-in e-mail of your ${d.brand} account to ${d.newEmail ?? 'another address'}.`,
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
	test_email: {
		subject: (d) => `${d.brand} test e-mail`,
		lines: () => ['This is a test e-mail from the Portal. E-mail sending works.'],
		action: null,
		footer: 'No action is needed.',
	},
	issuer_request: {
		subject: (d) => `${d.productName ?? 'A product'} wants to become the identity issuer of ${d.domain ?? 'your website'}`,
		lines: (d) => [
			`${d.productName ?? 'A product'} asked to become the customer identity issuer of ${d.domain ?? 'your website'} on ${d.brand}.`,
			'Once you approve, every product on the website accepts the sign-ins it issues. Nothing changes until you decide.',
		],
		action: 'Review the request',
		footer: 'If you did not install this product or do not expect the request, reject it in the console.',
	},
});

/** Closing line with the support contact. */
export const supportLine = (/** @type {{ email: string | null, phone: string | null, whatsapp: string | null }} */ support) => {
	const parts = [
		support.email ? `e-mail ${support.email}` : null,
		support.phone ? `phone ${support.phone}` : null,
		support.whatsapp ? `WhatsApp ${support.whatsapp}` : null,
	].filter(Boolean);
	return parts.length > 0 ? `Support: ${parts.join(', ')}.` : null;
};
