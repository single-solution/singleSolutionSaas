/**
 * Moderation (pure), ported and generalised from the ibrahimMobiles assistant sanitiser and leak filter:
 *
 * - **PII redaction** in and out: payment cards (Luhn-checked), IBANs (mod-97), e-mails, phone numbers (8–15 digits),
 *   IPv4 addresses — replaced by a label so the conversation stays readable.
 * - **Leak filter** for AI answers: credential shapes (connection strings, API-key formats, bearer tokens, private
 *   keys, environment variable names, `process.env`) and merchant-configured phrases that reveal internals. A hit
 *   replaces the whole answer (never a partial burst).
 * - **Link policy**: markdown links keep their label when the target is not allowed; bare disallowed URLs are removed.
 * - **Blocked terms** (the merchant's own list in any language): masked or rejected.
 *
 * Without the Moderation feature, AI answers still go through the credential check (never switchable).
 * @module
 */
import { normalise } from './text.js';

/** PII kinds this module can redact. */
export const PII_KINDS = Object.freeze(/** @type {const} */ (['card', 'iban', 'email', 'phone', 'ip']));

/** @typedef {(typeof PII_KINDS)[number]} PiiKind */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const PHONE_CANDIDATE = /(?<![\w.])\+?\d[\d ()./-]{6,20}\d(?![\w])/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

/**
 * Luhn checksum.
 * @param {string} digits
 */
export const luhn = (digits) => {
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i -= 1) {
		let d = Number(digits[i]);
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return digits.length >= 13 && sum % 10 === 0;
};

/**
 * IBAN mod-97 check.
 * @param {string} raw
 */
export const ibanValid = (raw) => {
	const iban = raw.replace(/\s+/g, '').toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
	const moved = `${iban.slice(4)}${iban.slice(0, 4)}`;
	let remainder = 0;
	for (const ch of moved) {
		const value = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
		for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
};

/**
 * Redact the selected PII kinds.
 * @param {string} text
 * @param {readonly string[]} kinds
 * @param {Record<string, string>} labels replacement per kind (from the string catalog)
 * @returns {{ text: string, found: Record<string, number> }}
 */
export const redact = (text, kinds, labels) => {
	let out = String(text ?? '');
	/** @type {Record<string, number>} */
	const found = {};
	const hit = (/** @type {string} */ kind) => {
		found[kind] = (found[kind] ?? 0) + 1;
		return labels[kind] ?? `[${kind}]`;
	};
	const want = new Set(kinds);
	// order matters: cards and IBANs before phones (long digit runs)
	if (want.has('card')) out = out.replace(CARD_CANDIDATE, (match) => (luhn(match.replace(/\D/g, '')) ? hit('card') : match));
	if (want.has('iban')) out = out.replace(IBAN_CANDIDATE, (match) => (ibanValid(match) ? hit('iban') : match));
	if (want.has('email')) out = out.replace(EMAIL, () => hit('email'));
	if (want.has('ip')) out = out.replace(IPV4, () => hit('ip'));
	if (want.has('phone'))
		out = out.replace(PHONE_CANDIDATE, (match) => {
			const digits = match.replace(/\D/g, '');
			return digits.length >= 8 && digits.length <= 15 && !/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(match.trim())
				? hit('phone')
				: match;
		});
	return { text: out, found };
};

/** Credential and infrastructure shapes an answer must never contain. */
const SECRET_PATTERNS = Object.freeze([
	/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqps?):\/\/\S+/i,
	/\bprocess\.env\b/,
	/\b[A-Z][A-Z0-9]*_(?:API_KEY|SECRET|SECRET_KEY|ACCESS_TOKEN|PRIVATE_KEY|TOKEN|PASSWORD|URI)\b/,
	/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_-]{10,}/,
	/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
	/\bAIza[0-9A-Za-z_-]{20,}/,
	/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
	/\bxox[abpr]-[A-Za-z0-9-]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
]);

/**
 * Leak check of an AI answer.
 * @param {string} text
 * @param {{ phrases?: readonly string[] }} [options]
 * @returns {{ ok: boolean, reason: 'secret' | 'internals' | null }}
 */
export const leakCheck = (text, { phrases = [] } = {}) => {
	const value = String(text ?? '');
	if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return { ok: false, reason: 'secret' };
	const plain = normalise(value);
	if (phrases.some((phrase) => phrase.trim() && plain.includes(normalise(phrase)))) return { ok: false, reason: 'internals' };
	return { ok: true, reason: null };
};

/**
 * @typedef {object} LinkPolicy
 * @property {'any' | 'website' | 'allow_list' | 'none'} mode
 * @property {readonly string[]} [hosts] allowed hosts (exact or subdomains)
 * @property {string | null} [websiteDomain] the website's own domain (from its key binding)
 */

/**
 * @param {string} host
 * @param {readonly string[]} hosts
 */
const hostIn = (host, hosts) => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * Is a link target allowed? Relative paths (`/…`) are always allowed except under `none`.
 * @param {string} target
 * @param {LinkPolicy} policy
 */
export const linkAllowed = (target, policy) => {
	const value = target.trim();
	if (policy.mode === 'none') return false;
	if (value.startsWith('/') && !value.startsWith('//')) return true;
	if (/^(?:mailto|tel):/i.test(value)) return true;
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
	if (url.username || url.password) return false;
	if (policy.mode === 'any') return true;
	const host = url.hostname.toLowerCase();
	const hosts = [...(policy.hosts ?? [])].map((h) => h.toLowerCase());
	if (policy.mode === 'website' && policy.websiteDomain) hosts.push(policy.websiteDomain.toLowerCase());
	return hostIn(host, hosts);
};

const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/**
 * Apply the link policy: disallowed markdown links keep their label, disallowed bare URLs are removed.
 * @param {string} text
 * @param {LinkPolicy} policy
 */
export const applyLinkPolicy = (text, policy) => {
	/** @type {string[]} */
	const kept = [];
	let out = String(text ?? '').replace(MARKDOWN_LINK, (_match, label, target) => {
		if (linkAllowed(target, policy)) {
			kept.push(target);
			return `[${label}](\uE000${kept.length - 1}\uE001)`;
		}
		return label;
	});
	out = out.replace(BARE_URL, (url) => (linkAllowed(url, policy) ? url : ''));
	return out.replace(/\uE000(\d+)\uE001/g, (_m, index) => kept[Number(index)] ?? '');
};

/**
 * Tidy whitespace, keep single newlines (lists), cap the length.
 * @param {string} text
 * @param {number} max
 */
export const tidy = (text, max) =>
	[
		...String(text ?? '')
			.replace(/[ \t]{2,}/g, ' ')
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
	]
		.slice(0, max)
		.join('');

/**
 * Blocked terms: whole-word (normalised) matches.
 * @param {string} text
 * @param {readonly string[]} terms
 * @param {'mask' | 'reject'} action
 * @returns {{ ok: boolean, text: string, hits: number }}
 */
export const applyBlockedTerms = (text, terms, action) => {
	let hits = 0;
	let out = String(text ?? '');
	for (const term of terms) {
		const needle = term.trim();
		if (!needle) continue;
		const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
		out = out.replace(pattern, (match) => {
			hits += 1;
			return '•'.repeat([...match].length);
		});
	}
	if (hits > 0 && action === 'reject') return { ok: false, text: String(text ?? ''), hits };
	return { ok: true, text: out, hits };
};

/**
 * The Moderation settings (schemas/moderation.settings.json).
 * @typedef {object} ModerationConfig
 * @property {string[]} redact
 * @property {string[]} blockedTerms
 * @property {'mask' | 'reject'} blockedAction
 * @property {'website' | 'allow_list' | 'none' | 'any'} linkPolicy
 * @property {string[]} allowedLinkHosts
 * @property {string[]} leakPhrases
 */

/**
 * A visitor message before it is stored: blocked terms, then personal data hidden.
 * @param {string} text
 * @param {ModerationConfig | null} config null = moderation off
 * @param {Record<string, string>} labels
 * @returns {{ ok: true, text: string } | { ok: false }}
 */
export const moderateInbound = (text, config, labels) => {
	if (!config) return { ok: true, text };
	const terms = applyBlockedTerms(text, config.blockedTerms, config.blockedAction);
	if (!terms.ok) return { ok: false };
	return { ok: true, text: redact(terms.text, config.redact, labels).text };
};

/**
 * An AI answer before it is stored: link policy, personal data hidden, then the leak check (credentials always; the
 * merchant's phrases with moderation on). A failed check drops the whole answer.
 * @param {string} text
 * @param {ModerationConfig | null} config
 * @param {{ labels: Record<string, string>, websiteDomain: string }} context
 * @returns {{ ok: boolean, text: string }}
 */
export const moderateOutbound = (text, config, { labels, websiteDomain }) => {
	if (!config) return { ok: leakCheck(text).ok, text };
	const linked = applyLinkPolicy(text, { mode: config.linkPolicy, hosts: config.allowedLinkHosts, websiteDomain });
	const cleaned = tidy(redact(linked, config.redact, labels).text, 8000);
	return { ok: leakCheck(cleaned, { phrases: config.leakPhrases }).ok, text: cleaned };
};
