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
 * - **AI disclosure** check, only when the merchant chose `present_as_human`.
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

/** Self-disclosure phrasings (English), checked only when the merchant asked the assistant to present as human. */
const DISCLOSURE =
	/\b(?:as an ai|i(?:'m| am) (?:an? )?(?:ai|bot|chat ?bot|language model|virtual assistant|automated (?:assistant|system))|large language model)\b/i;

/**
 * Leak check of an AI answer.
 * @param {string} text
 * @param {{ phrases?: readonly string[], presentAsHuman?: boolean }} [options]
 * @returns {{ ok: boolean, reason: 'secret' | 'internals' | 'disclosure' | null }}
 */
export const leakCheck = (text, { phrases = [], presentAsHuman = false } = {}) => {
	const value = String(text ?? '');
	if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return { ok: false, reason: 'secret' };
	const plain = normalise(value);
	if (phrases.some((phrase) => phrase.trim() && plain.includes(normalise(phrase)))) return { ok: false, reason: 'internals' };
	if (presentAsHuman && DISCLOSURE.test(value)) return { ok: false, reason: 'disclosure' };
	return { ok: true, reason: null };
};

/**
 * @typedef {object} LinkPolicy
 * @property {'any' | 'website_only' | 'allow_list' | 'none'} mode
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
	if (policy.mode === 'website_only' && policy.websiteDomain) hosts.push(policy.websiteDomain.toLowerCase());
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
 * Split an answer into bubbles on a line holding only the separator; each bubble is tidied; empty ones dropped.
 * @param {string} raw
 * @param {{ separator: string, maxBubbles: number, maxLength: number }} options
 * @returns {string[]}
 */
export const splitBubbles = (raw, { separator, maxBubbles, maxLength }) => {
	const lines = String(raw ?? '').split('\n');
	/** @type {string[][]} */
	const groups = [[]];
	for (const line of lines) {
		if (line.trim() === separator) groups.push([]);
		else groups[groups.length - 1]?.push(line);
	}
	return groups
		.map((group) => tidy(group.join('\n'), maxLength))
		.filter((bubble) => bubble.length > 0)
		.slice(0, maxBubbles);
};

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
 * @typedef {object} ModerationConfig
 * @property {string[]} redact_inbound
 * @property {string[]} redact_outbound
 * @property {boolean} redact_before_ai
 * @property {boolean} leak_filter
 * @property {string[]} leak_phrases
 * @property {'any' | 'website_only' | 'allow_list' | 'none'} link_policy
 * @property {string[]} allowed_link_hosts
 * @property {string[]} blocked_terms
 * @property {'mask' | 'reject'} blocked_terms_action
 */

/**
 * Inbound pipeline for a customer message: blocked terms, then PII redaction (stored text).
 * @param {string} text
 * @param {ModerationConfig | null} config null = moderation off
 * @param {Record<string, string>} labels
 * @returns {{ ok: true, text: string, redacted: Record<string, number>, masked: number } | { ok: false, reason: 'blocked_term' }}
 */
export const moderateInbound = (text, config, labels) => {
	if (!config) return { ok: true, text, redacted: {}, masked: 0 };
	const terms = applyBlockedTerms(text, config.blocked_terms, config.blocked_terms_action);
	if (!terms.ok) return { ok: false, reason: 'blocked_term' };
	const redacted = redact(terms.text, config.redact_inbound, labels);
	return { ok: true, text: redacted.text, redacted: redacted.found, masked: terms.hits };
};

/**
 * Outbound pipeline for one AI bubble: link policy, PII redaction, leak check.
 * @param {string} text
 * @param {ModerationConfig | null} config
 * @param {{ labels: Record<string, string>, websiteDomain: string | null, presentAsHuman: boolean }} context
 * @returns {{ ok: boolean, text: string, reason: string | null }}
 */
export const moderateOutbound = (text, config, { labels, websiteDomain, presentAsHuman }) => {
	if (!config) {
		const leak = leakCheck(text, { presentAsHuman });
		return { ok: leak.ok, text, reason: leak.reason };
	}
	const linked = applyLinkPolicy(text, {
		mode: config.link_policy,
		hosts: config.allowed_link_hosts,
		websiteDomain,
	});
	const cleaned = redact(linked, config.redact_outbound, labels).text;
	if (!config.leak_filter) {
		const disclosure = presentAsHuman ? leakCheck(cleaned, { presentAsHuman }) : { ok: true, reason: null };
		return { ok: disclosure.ok, text: cleaned, reason: disclosure.reason };
	}
	const leak = leakCheck(cleaned, { phrases: config.leak_phrases, presentAsHuman });
	return { ok: leak.ok, text: cleaned, reason: leak.reason };
};
