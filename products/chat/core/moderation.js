/**
 * Moderation (pure): the checks on what visitors and the AI write:
 *
 * - **PII redaction** in and out: the merchant's own patterns first (the list `redaction_patterns`, a safe subset of
 *   regular expressions that can never hang the server, C14), then payment cards (Luhn-checked), IBANs (mod-97),
 *   emails, phone numbers (8–15 digits), IPv6 and IPv4 addresses — replaced by a label so the conversation stays
 *   readable.
 * - **Leak filter** for AI answers: credential shapes (connection strings, API-key formats, bearer tokens, private
 *   keys, environment variable names, `process.env`) and merchant-configured phrases that reveal internals. A hit
 *   replaces the whole answer (never a partial burst).
 * - **Link policy**: markdown links keep their label when the target is not allowed; bare disallowed URLs are removed.
 * - **Blocked terms** (the merchant's own list in any language): masked or rejected.
 * - **The website's own contact** (PLAN 0.8.10 C15, always): the business.json email and phone are never redacted.
 *
 * Without the Moderation feature, AI answers still go through the credential check (never switchable).
 * @module
 */
import { luhnValid } from '@ss/contracts/text';
import { MARKDOWN_LINK } from './markdown.js';
import { compilePattern, replacePattern } from './patterns.js';
import { normalize } from './text.js';

/** @typedef {'card' | 'iban' | 'email' | 'phone' | 'ip'} PiiKind */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const PHONE_CANDIDATE = /(?<![\w.])\+?\d[\d ()./-]{6,20}\d(?![\w])/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
/** An IPv6 candidate (hex digits, colons and dots, bounded), checked by `isIPv6`. */
const IPV6_CANDIDATE = /(?<![\p{L}\p{N}:.])[0-9a-f:.]{3,45}(?![\p{L}\p{N}:])/giu;

/**
 * An IPv6 address (RFC 4291 text forms): eight groups of 1–4 hex digits, or fewer around one `::`, the last two may be
 * an IPv4 address.
 * @param {string} value
 */
export const isIPv6 = (value) => {
	const halves = value.split('::');
	if (halves.length > 2) return false;
	/** @param {string} part */
	const groups = (part) => (part === '' ? [] : part.split(':'));
	const head = groups(/** @type {string} */ (halves[0]));
	const tail = halves.length === 2 ? groups(/** @type {string} */ (halves[1])) : [];
	const all = [...head, ...tail];
	let count = all.length;
	const last = all.at(-1) ?? '';
	if (last.includes('.')) {
		if (!/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(last)) return false;
		count += 1;
		all.pop();
	}
	if (!all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
	return halves.length === 2 ? count < 8 : count === 8;
};

/** The list's limits: patterns, and the longest name and replacement. */
export const REDACTION_LIMITS = Object.freeze({ patterns: 30, name: 60, replacement: 60 });

/**
 * A merchant redaction pattern (C14).
 * @typedef {{ name: string, pattern: string, replacement: string }} RedactionPattern
 */

/**
 * Check the list `redaction_patterns`: each `{ name, pattern, replacement }`, the pattern in the safe subset
 * (`core/patterns.js`); `replacement` empty = the name in brackets.
 * @param {unknown} raw
 * @returns {{ ok: true, value: RedactionPattern[] } | { ok: false, errors: string[] }}
 */
export const checkRedactionPatterns = (raw) => {
	if (!Array.isArray(raw)) return { ok: false, errors: ['Send a list of patterns.'] };
	if (raw.length > REDACTION_LIMITS.patterns) return { ok: false, errors: [`Up to ${REDACTION_LIMITS.patterns} patterns.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {RedactionPattern[]} */
	const value = [];
	raw.forEach((item, index) => {
		const at = `Pattern ${index + 1}:`;
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			errors.push(`${at} not valid.`);
			return;
		}
		const name = typeof item.name === 'string' ? item.name.trim() : '';
		const pattern = typeof item.pattern === 'string' ? item.pattern : '';
		const replacement = typeof item.replacement === 'string' ? item.replacement.trim() : '';
		if (name === '' || [...name].length > REDACTION_LIMITS.name)
			errors.push(`${at} give it a name of up to ${REDACTION_LIMITS.name} characters.`);
		const compiled = compilePattern(pattern);
		if (!compiled.ok) errors.push(`${at} ${compiled.error}`);
		if ([...replacement].length > REDACTION_LIMITS.replacement)
			errors.push(`${at} the replacement is up to ${REDACTION_LIMITS.replacement} characters.`);
		value.push({ name, pattern, replacement });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The saved patterns ready to run (one that no longer compiles is left out).
 * @param {unknown} items
 * @returns {CompiledPattern[]}
 */
export const compileRedactionPatterns = (items) =>
	(Array.isArray(items) ? items : []).flatMap((item) => {
		const compiled = compilePattern(item?.pattern);
		if (!compiled.ok || typeof item?.name !== 'string') return [];
		const replacement =
			typeof item.replacement === 'string' && item.replacement.trim() ? item.replacement.trim() : `[${item.name}]`;
		return [{ name: item.name, program: compiled.program, replacement }];
	});

/** @typedef {{ name: string, program: import('./patterns.js').Instruction[], replacement: string }} CompiledPattern */

/**
 * A payment card number: 13 to 19 digits that pass the Luhn check.
 * @param {string} digits
 */
const isCard = (digits) => digits.length >= 13 && luhnValid(digits);

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

/** The digits of a phone without the leading zeros of `00` or a trunk `0`. @param {string} value */
const phoneDigits = (value) => value.replace(/\D/g, '').replace(/^0+/, '');

/** The fewest digits that name one number (a national number without its country code). */
const MIN_PHONE_DIGITS = 7;

/**
 * Whether two phones (`phoneDigits`) are one number in national or international form: the shorter, of at least 7
 * digits, ends the longer (`020 7946 0123` is `+44 20 7946 0123`, `6123 4567` is `+65 6123 4567`), in any country.
 * @param {string} a
 * @param {string} b
 */
const samePhone = (a, b) => {
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return shorter.length >= MIN_PHONE_DIGITS && longer.endsWith(shorter);
};

/**
 * The website's own contact, kept by redaction (C15).
 * @typedef {{ email?: string | null, phone?: string | null }} OwnContact
 */

/**
 * Redact the selected PII kinds; the website's own email and phone stay.
 * @param {string} text
 * @param {readonly string[]} kinds
 * @param {Record<string, string>} labels replacement per kind (from the string catalog)
 * @param {OwnContact} [own] the business.json contact, never redacted
 * @param {CompiledPattern[]} [patterns] the merchant's own patterns, run first (C14)
 * @returns {{ text: string, found: Record<string, number> }}
 */
export const redact = (text, kinds, labels, own = {}, patterns = []) => {
	const ownEmail = typeof own.email === 'string' ? own.email.trim().toLowerCase() : '';
	const ownPhone = typeof own.phone === 'string' ? phoneDigits(own.phone) : '';
	let out = String(text ?? '');
	/** @type {Record<string, number>} */
	const found = {};
	const hit = (/** @type {string} */ kind) => {
		found[kind] = (found[kind] ?? 0) + 1;
		return labels[kind] ?? `[${kind}]`;
	};
	const want = new Set(kinds);
	for (const pattern of patterns)
		out = replacePattern(out, pattern.program, () => {
			found[pattern.name] = (found[pattern.name] ?? 0) + 1;
			return pattern.replacement;
		});
	// order matters: cards and IBANs before phones (long digit runs), IPv6 before IPv4 (an IPv4 tail)
	if (want.has('card')) out = out.replace(CARD_CANDIDATE, (match) => (isCard(match.replace(/\D/g, '')) ? hit('card') : match));
	if (want.has('iban')) out = out.replace(IBAN_CANDIDATE, (match) => (ibanValid(match) ? hit('iban') : match));
	if (want.has('email'))
		out = out.replace(EMAIL, (match) => (ownEmail !== '' && match.toLowerCase() === ownEmail ? match : hit('email')));
	if (want.has('ip'))
		out = out
			.replace(IPV6_CANDIDATE, (match) => {
				const trailing = /\.+$/.exec(match)?.[0] ?? '';
				const address = match.slice(0, match.length - trailing.length);
				return address.includes(':') && isIPv6(address) ? `${hit('ip')}${trailing}` : match;
			})
			.replace(IPV4, () => hit('ip'));
	if (want.has('phone'))
		out = out.replace(PHONE_CANDIDATE, (match) => {
			const digits = match.replace(/\D/g, '');
			if (samePhone(phoneDigits(digits), ownPhone)) return match;
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
	const plain = normalize(value);
	if (phrases.some((phrase) => phrase.trim() && plain.includes(normalize(phrase)))) return { ok: false, reason: 'internals' };
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
	// the website's own links are always in the allow-list too (PLAN 0.8.10 C2)
	if (policy.websiteDomain) hosts.push(policy.websiteDomain.toLowerCase());
	return hostIn(host, hosts);
};

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
const tidy = (text, max) =>
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
 * Blocked terms: whole-word (normalized) matches.
 * @param {string} text
 * @param {readonly string[]} terms
 * @param {'mask' | 'reject'} action
 * @returns {{ ok: boolean, text: string, hits: number }}
 */
const applyBlockedTerms = (text, terms, action) => {
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
 * @property {CompiledPattern[]} [patterns] the merchant's own redaction patterns, compiled (C14)
 */

/**
 * A visitor message before it is stored: blocked terms, then personal data hidden (the website's own contact stays).
 * @param {string} text
 * @param {ModerationConfig | null} config null = moderation off
 * @param {Record<string, string>} labels
 * @param {OwnContact} [own]
 * @returns {{ ok: true, text: string } | { ok: false }}
 */
export const moderateInbound = (text, config, labels, own = {}) => {
	if (!config) return { ok: true, text };
	const terms = applyBlockedTerms(text, config.blockedTerms, config.blockedAction);
	if (!terms.ok) return { ok: false };
	return { ok: true, text: redact(terms.text, config.redact, labels, own, config.patterns).text };
};

/**
 * An AI answer before it is stored: link policy, personal data hidden, then the leak check (credentials always; the
 * merchant's phrases with moderation on). A failed check drops the whole answer.
 * @param {string} text
 * @param {ModerationConfig | null} config
 * @param {{ labels: Record<string, string>, websiteDomain: string, own?: OwnContact }} context `own`: the website's own
 *   contact, never redacted
 * @returns {{ ok: boolean, text: string }}
 */
export const moderateOutbound = (text, config, { labels, websiteDomain, own = {} }) => {
	if (!config) return { ok: leakCheck(text).ok, text };
	const linked = applyLinkPolicy(text, { mode: config.linkPolicy, hosts: config.allowedLinkHosts, websiteDomain });
	const cleaned = tidy(redact(linked, config.redact, labels, own, config.patterns).text, 8000);
	return { ok: leakCheck(cleaned, { phrases: config.leakPhrases }).ok, text: cleaned };
};
