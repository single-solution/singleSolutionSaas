/**
 * Redirects (pure; SEO audit G9): rules that send an old address of the website to its new page, or answer it as gone.
 * A rule is `{ from, match, to, code, note }`:
 *
 * - `from`: a path on the website (an address on the website's own domain, or its www. twin, is read as its path).
 *   Paths are normalized the same way for rules and for the addresses asked about: one leading slash, repeated slashes
 *   as one, `.` and `..` resolved, characters outside URLs percent-encoded with upper-case hex, no trailing slash except
 *   for `/`, letter case kept (`/Old` and `/old` are two paths). Rules match the path only: a `from` with `?` or `#` is
 *   refused, and the query string of an address asked about is ignored for matching and passed on (below).
 * - `match`: `exact` (the path itself) or `prefix` (the path and every path under it, segment by segment: `/blog`
 *   matches `/blog` and `/blog/news`, never `/blogger`). An exact rule wins; else the longest prefix wins.
 * - `to`: where the visitor goes, a path on the website (with its own query string and fragment if wanted) or an https
 *   address on another site (an https address on the website's own domain is kept as its path); null for 410. A prefix
 *   rule keeps the rest of the path: `/blog` → `/news` sends `/blog/a/b` to `/news/a/b`. The query string of the
 *   address asked about is added after the target's own (`/old?utm_source=x` → `/new?ref=a&utm_source=x`).
 * - `code`: 301 or 308 (permanent; 308 keeps the request method), or 410 (gone, no `to`).
 * - `note`: the staff's own words, at most 200 characters.
 *
 * At most {@link MAX_RULES} rules per website, one per `from`. A rule set never holds a loop or a chain: an address
 * that a rule redirects lands on a page no rule redirects or removes (Google: avoid chains; each hop costs a visitor
 * time and a crawler its patience). Every change is checked against the whole set ({@link newProblems}).
 * @module
 */
import { parseCsv, toCsv } from './csv.js';

/** Most rules of one website. */
export const MAX_RULES = 5000;
/** How a rule matches. */
export const MATCHES = Object.freeze(/** @type {const} */ (['exact', 'prefix']));
/** The answers a rule gives. */
export const CODES = Object.freeze(/** @type {const} */ ([301, 308, 410]));
/** Longest `from`, in characters (after normalization). */
export const MAX_FROM = 1000;
/** Longest `to`, in characters (after normalization). */
export const MAX_TO = 2048;
/** Longest note. */
export const MAX_NOTE = 200;
/** Longest query string of an address asked about. */
const MAX_QUERY = 2048;
/** Hops followed when a set is checked for loops and chains. */
const MAX_HOPS = 5;
/** The columns of the CSV file, in order. */
export const CSV_COLUMNS = Object.freeze(['from', 'match', 'to', 'code', 'note']);
/** Header names read as each column (any letter case): ours, then the names other platforms' exports use. */
const COLUMN_NAMES = Object.freeze({
	from: ['from', 'redirect from', 'source'],
	to: ['to', 'redirect to', 'destination'],
	match: ['match'],
	code: ['code', 'status'],
	note: ['note'],
});
/** A child path of a prefix (no normalized path holds a raw `…`): it stands for "any path under it". */
const CHILD = '/…';
/** `…` as a URL path holds it. */
const ANY_CHILD = '%E2%80%A6';
/** The base of relative URLs (never fetched). */
const BASE = 'https://redirect.invalid';

/** @typedef {'exact' | 'prefix'} Match */
/** @typedef {301 | 308 | 410} Code */
/** @typedef {{ from: string, match: Match, to: string | null, code: Code, note: string }} RuleInput a checked rule */
/** @typedef {RuleInput & { id: string, createdAt?: Date, updatedAt?: Date }} Rule a stored rule */
/** @typedef {{ path: string, code: string, message: string }} FieldProblem `path`: the field as a JSON pointer */
/**
 * @typedef {{ kind: 'loop' | 'chain', steps: string[], gone: boolean, first: string, second: string }} SetProblem a
 *   loop or chain: the addresses one request goes through (`steps`, the first is the address asked about; `/…` stands
 *   for any path under a prefix), whether it ends at a removed page (`gone`), and the `from` of the first two rules
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Runs of spaces and control characters (a note keeps one space for each). */
// eslint-disable-next-line no-control-regex
const SPACES = /[\s\u0000-\u001f\u007f]+/g;

/**
 * Whether a host is the website's: its domain, or the same with or without `www.`.
 * @param {string} host
 * @param {string} domain
 */
const ownHost = (host, domain) => {
	const name = host.toLowerCase();
	const own = domain.toLowerCase();
	return own !== '' && (name === own || name === `www.${own}` || `www.${name}` === own);
};

/**
 * A path normalized (see the module), with its query string and fragment when they are kept.
 * @param {unknown} raw a path from `/`, or an http(s) address on the website's own domain
 * @param {{ domain?: string, keepQuery?: boolean }} [options] `keepQuery`: keep `?…` and `#…` (a target), else refuse them
 * @returns {{ ok: true, path: string, query: string, fragment: string }
 *   | { ok: false, code: 'required' | 'not_path' | 'other_host' | 'query' }}
 */
export const normalizePath = (raw, { domain = '', keepQuery = false } = {}) => {
	if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === ''))
		return { ok: false, code: 'required' };
	if (typeof raw !== 'string' || CONTROL.test(raw)) return { ok: false, code: 'not_path' };
	let text = raw.trim();
	if (/^https?:\/\//i.test(text)) {
		/** @type {URL} */
		let url;
		try {
			url = new URL(text);
		} catch {
			return { ok: false, code: 'not_path' };
		}
		if (!ownHost(url.hostname, domain)) return { ok: false, code: 'other_host' };
		text = `${url.pathname}${url.search}${url.hash}`;
	}
	if (!text.startsWith('/')) return { ok: false, code: 'not_path' };
	const cut = text.search(/[?#]/);
	const tail = cut === -1 ? '' : text.slice(cut);
	if (tail !== '' && !keepQuery) return { ok: false, code: 'query' };
	// backslashes count as slashes, and `//` would name a host: both become one slash before the URL parser sees them
	const head = (cut === -1 ? text : text.slice(0, cut)).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	const url = new URL(`${head}${tail}`, BASE);
	const path = url.pathname.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase()).replace(/\/{2,}/g, '/');
	return {
		ok: true,
		path: path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path,
		query: url.search.slice(1),
		fragment: url.hash.slice(1),
	};
};

/**
 * A target (`to`) normalized: a path on the website with its query string and fragment, or an https address on another
 * site; an https address on the website's own domain becomes its path.
 * @param {unknown} raw
 * @param {string} domain
 * @returns {{ ok: true, to: string } | { ok: false, code: 'required' | 'not_target' | 'not_https' }}
 */
export const normalizeTarget = (raw, domain) => {
	if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === ''))
		return { ok: false, code: 'required' };
	if (typeof raw !== 'string' || CONTROL.test(raw)) return { ok: false, code: 'not_target' };
	const text = raw.trim();
	/** @param {string} value */
	const local = (value) => {
		const found = normalizePath(value, { domain, keepQuery: true });
		if (!found.ok) return /** @type {const} */ ({ ok: false, code: 'not_target' });
		const to = `${found.path}${found.query ? `?${found.query}` : ''}${found.fragment ? `#${found.fragment}` : ''}`;
		return /** @type {const} */ ({ ok: true, to });
	};
	if (text.startsWith('/')) return local(text);
	if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https:/i.test(text)) return { ok: false, code: 'not_https' };
	/** @type {URL} */
	let url;
	try {
		url = new URL(text);
	} catch {
		return { ok: false, code: 'not_target' };
	}
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !url.hostname.includes('.'))
		return { ok: false, code: 'not_target' };
	if (ownHost(url.hostname, domain)) return local(`${url.pathname}${url.search}${url.hash}`);
	return { ok: true, to: url.href };
};

/** The English words of each field problem (widgets show their own texts by field). */
const MESSAGES = Object.freeze({
	'from:required': 'from is the old path, for example /old-page.',
	'from:not_path': 'from is a path on this website, starting with /.',
	'from:other_host': 'from is an address on this website, not on another site.',
	'from:query': 'from is a path only (rules match the path): leave out ? and #.',
	'from:too_long': `from is at most ${MAX_FROM} characters.`,
	'match:not_match': 'match is exact or prefix.',
	'code:not_code': 'code is 301, 308 or 410.',
	'to:required': 'to is the new path or an https address (only a 410 rule has none).',
	'to:not_target': 'to is a path on this website or an https address.',
	'to:not_https': 'to is a path on this website or an https address (not http or another scheme).',
	'to:too_long': `to is at most ${MAX_TO} characters.`,
	'to:gone': 'A 410 rule answers the page as gone, so it has no to.',
	'note:not_text': 'note is a text.',
	'note:too_long': `note is at most ${MAX_NOTE} characters.`,
});

/**
 * A field problem.
 * @param {'from' | 'match' | 'code' | 'to' | 'note'} field
 * @param {string} code
 * @returns {FieldProblem}
 */
const fieldProblem = (field, code) => ({
	path: `/${field}`,
	code,
	message: MESSAGES[/** @type {keyof typeof MESSAGES} */ (`${field}:${code}`)],
});

/**
 * A rule as staff or a file give it, checked and normalized: `from` and `to` as strings (an address or a path),
 * `match` (default exact), `code` (default 301; a number, or digits from a file) and `note` (default empty).
 * @param {{ from?: unknown, match?: unknown, to?: unknown, code?: unknown, note?: unknown }} input
 * @param {string} domain the website's domain
 * @returns {{ ok: true, rule: RuleInput } | { ok: false, errors: FieldProblem[] }}
 */
export const checkRule = (input, domain) => {
	/** @type {FieldProblem[]} */
	const errors = [];
	const from = normalizePath(input.from, { domain });
	if (!from.ok) errors.push(fieldProblem('from', from.code));
	else if (from.path.length > MAX_FROM) errors.push(fieldProblem('from', 'too_long'));
	const match = input.match === undefined || input.match === '' ? 'exact' : String(input.match).toLowerCase();
	if (!MATCHES.includes(/** @type {Match} */ (match))) errors.push(fieldProblem('match', 'not_match'));
	const code =
		input.code === undefined || input.code === ''
			? 301
			: typeof input.code === 'string' && /^\d{3}$/.test(input.code.trim())
				? Number(input.code.trim())
				: input.code;
	if (!CODES.includes(/** @type {Code} */ (code))) errors.push(fieldProblem('code', 'not_code'));
	/** @type {string | null} */
	let to = null;
	const blank = input.to === undefined || input.to === null || input.to === '';
	if (code === 410) {
		if (!blank) errors.push(fieldProblem('to', 'gone'));
	} else {
		const target = normalizeTarget(input.to, domain);
		if (!target.ok) errors.push(fieldProblem('to', target.code));
		else if (target.to.length > MAX_TO) errors.push(fieldProblem('to', 'too_long'));
		else to = target.to;
	}
	const note = input.note === undefined || input.note === null ? '' : input.note;
	if (typeof note !== 'string') errors.push(fieldProblem('note', 'not_text'));
	else if ([...note.trim()].length > MAX_NOTE) errors.push(fieldProblem('note', 'too_long'));
	if (errors.length > 0 || !from.ok) return { ok: false, errors };
	return {
		ok: true,
		rule: {
			from: from.path,
			match: /** @type {Match} */ (match),
			to,
			code: /** @type {Code} */ (code),
			note: String(note).replace(SPACES, ' ').trim(),
		},
	};
};

/** The members a rule body may have. */
const MEMBERS = Object.freeze(['from', 'match', 'to', 'code', 'note']);

/**
 * A request body for a new rule (`POST`), or the changes to a stored one (`PATCH`, merged into it): only the members
 * of a rule; a change of `code` to 410 drops the stored `to`.
 * @param {unknown} body
 * @param {string} domain
 * @param {RuleInput} [stored] the rule a `PATCH` changes
 * @returns {{ ok: true, rule: RuleInput } | { ok: false, errors: FieldProblem[] }}
 */
export const ruleOfBody = (body, domain, stored) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', code: 'not_object', message: 'Send a JSON object.' }] };
	const unknown = Object.keys(body).filter((name) => !MEMBERS.includes(name));
	if (unknown.length > 0)
		return {
			ok: false,
			errors: unknown.map((name) => ({ path: `/${name}`, code: 'unknown', message: `${name} is not a member of a rule.` })),
		};
	if (!stored) return checkRule(body, domain);
	const gone = Number(body.code) === 410 && !Object.hasOwn(body, 'to');
	return checkRule({ ...stored, ...body, ...(gone ? { to: null } : {}) }, domain);
};

/**
 * Whether two rules say the same.
 * @param {RuleInput} a
 * @param {RuleInput} b
 */
export const sameRule = (a, b) =>
	a.from === b.from && a.match === b.match && a.to === b.to && a.code === b.code && a.note === b.note;

// --------------------------------------------------------------------------------------------------------- matching

/**
 * A path and every path above it, the longest first (`/a/b` → `/a/b`, `/a`, `/`).
 * @param {string} path
 */
export const ancestorsOf = (path) => {
	const out = [path];
	for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) out.push(path.slice(0, cut));
	if (path !== '/') out.push('/');
	return out;
};

/**
 * The rest of a path under a prefix rule's `from` (`''` or a path from `/`).
 * @param {string} from
 * @param {string} path
 */
const restOf = (from, path) => (from === '/' ? (path === '/' ? '' : path) : path.slice(from.length));

/**
 * A path with a rest added (`/news` + `/a` → `/news/a`).
 * @param {string} base
 * @param {string} rest
 */
const joinPath = (base, rest) => (rest === '' ? base : base === '/' ? rest : `${base.replace(/\/$/, '')}${rest}`);

/**
 * The rules of a website, indexed for matching.
 * @template {RuleInput} R
 * @param {ReadonlyArray<R>} rules
 */
export const createIndex = (rules) => {
	/** @type {Map<string, R>} */
	const exact = new Map();
	/** @type {Map<string, R>} */
	const prefix = new Map();
	for (const rule of rules) (rule.match === 'prefix' ? prefix : exact).set(rule.from, rule);
	const sorted = [...rules].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
	return Object.freeze({
		/**
		 * The rule that answers a normalized path: the exact rule of the path, else the prefix rule of the longest path
		 * above it (the path itself included), else null.
		 * @param {string} path
		 * @returns {R | null}
		 */
		match: (path) =>
			exact.get(path) ??
			ancestorsOf(path)
				.map((above) => prefix.get(above))
				.find(Boolean) ??
			null,
		/**
		 * The rules strictly under a path (`from` starts with `<path>/`; every rule but `/` under `/`).
		 * @param {string} path
		 * @returns {R[]}
		 */
		under: (path) => {
			const start = path === '/' ? '/' : `${path}/`;
			let low = 0;
			let high = sorted.length;
			while (low < high) {
				const middle = (low + high) >> 1;
				if (/** @type {R} */ (sorted[middle]).from < start) low = middle + 1;
				else high = middle;
			}
			/** @type {R[]} */
			const out = [];
			for (let i = low; i < sorted.length && /** @type {R} */ (sorted[i]).from.startsWith(start); i += 1) {
				const rule = /** @type {R} */ (sorted[i]);
				if (rule.from !== path) out.push(rule);
			}
			return out;
		},
	});
};

/**
 * Where a rule sends a request for a normalized path (with the request's query string, if any), or null for 410.
 * @param {RuleInput} rule
 * @param {string} path the normalized path the rule answers
 * @param {string} [query] the request's query string (without `?`)
 */
export const locationOf = (rule, path, query = '') => {
	if (rule.to === null) return null;
	const url = new URL(rule.to, BASE);
	if (rule.match === 'prefix') url.pathname = joinPath(url.pathname, restOf(rule.from, path));
	url.search = [url.search.slice(1), query].filter(Boolean).join('&');
	return rule.to.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.href;
};

/**
 * An address the website's server asks about (`GET /v1/redirects/match?path=`): its normalized path and its query
 * string; null when it is not a path. A path longer than any rule's `from` can be is answered by no rule (`path: null`).
 * @param {unknown} raw a path from `/`, with its query string if any (a fragment is ignored)
 * @returns {{ path: string | null, query: string } | null}
 */
export const requestOf = (raw) => {
	if (typeof raw !== 'string' || !raw.startsWith('/') || CONTROL.test(raw)) return null;
	const text = raw.split('#')[0] ?? '';
	const cut = text.indexOf('?');
	const query = cut === -1 ? '' : text.slice(cut + 1);
	if (query.length > MAX_QUERY) return null;
	const found = normalizePath(cut === -1 ? text : text.slice(0, cut));
	if (!found.ok) return null;
	return { path: found.path.length > MAX_FROM ? null : found.path, query };
};

// ------------------------------------------------------------------------------------------ loops and chains

/**
 * The path a location reaches on the website (query string and fragment cut), or null on another site.
 * @param {string} location
 */
const pathOfLocation = (location) => (location.startsWith('/') ? (location.split(/[?#]/)[0] ?? '/') : null);

/**
 * Follow a request through the rules: a problem when more than one rule acts on it (a chain), it comes back to an
 * address it passed or to a rule it used (a loop), or a redirect lands on a page a rule removes (410).
 * @template {RuleInput} R
 * @param {ReturnType<typeof createIndex<R>>} index
 * @param {string} start
 * @returns {SetProblem | null}
 */
const traceOf = (index, start) => {
	const steps = [start];
	const visited = new Set([start]);
	/** @type {R[]} */
	const used = [];
	let path = start;
	while (used.length < MAX_HOPS) {
		const rule = index.match(path);
		if (rule === null) break;
		const location = locationOf(rule, path);
		if (location === null) {
			if (used.length === 0) return null;
			const first = /** @type {R} */ (used[0]);
			return { kind: 'chain', steps, gone: true, first: first.from, second: rule.from };
		}
		const next = pathOfLocation(location);
		// back at an address it passed, or the same prefix rule again on a longer path (it would grow for ever)
		const loops = next !== null && (visited.has(next) || (used.includes(rule) && next.length > path.length));
		used.push(rule);
		// a path under a prefix rule stands for any of them: shown as `…`, not percent-encoded
		steps.push(location.replaceAll(ANY_CHILD, '…'));
		if (loops) {
			const first = /** @type {R} */ (used[0]);
			return { kind: 'loop', steps, gone: false, first: first.from, second: (used[1] ?? first).from };
		}
		if (next === null) break;
		visited.add(next);
		path = next;
	}
	if (used.length < 2) return null;
	return {
		kind: 'chain',
		steps,
		gone: false,
		first: /** @type {R} */ (used[0]).from,
		second: /** @type {R} */ (used[1]).from,
	};
};

/**
 * Every loop and chain of a rule set (at most one per rule): for each rule, the addresses it answers that could reach
 * another rule — its `from`; for a prefix rule also any path under it, and the path under it that lands on each rule
 * under its target (the rest of a prefix rule's path is kept).
 * @template {RuleInput} R
 * @param {ReadonlyArray<R>} rules
 * @returns {SetProblem[]}
 */
export const findProblems = (rules) => {
	const index = createIndex(rules);
	/** @type {SetProblem[]} */
	const found = [];
	for (const rule of rules) {
		if (rule.to === null || !rule.to.startsWith('/')) continue;
		const target = /** @type {string} */ (pathOfLocation(rule.to));
		const candidates = [rule.from];
		if (rule.match === 'prefix') {
			candidates.push(joinPath(rule.from, CHILD));
			// the rule itself under its target (a prefix moved up, `/old` → `/`) only meets itself on made-up paths
			for (const other of index.under(target).filter((under) => under !== rule)) {
				const landing = joinPath(rule.from, restOf(target, other.from));
				candidates.push(landing);
				if (other.match === 'prefix') candidates.push(joinPath(landing, CHILD));
			}
		}
		for (const path of candidates) {
			if (index.match(path) !== rule) continue;
			const problem = traceOf(index, path);
			if (problem) {
				found.push(problem);
				break;
			}
		}
	}
	return found;
};

/** @param {SetProblem} problem */
const keyOfProblem = (problem) => `${problem.kind}\n${problem.first}\n${problem.second}`;

/**
 * The loops and chains a change brings: those of the set after it that the set before it did not have.
 * @param {ReadonlyArray<RuleInput>} before
 * @param {ReadonlyArray<RuleInput>} after
 */
export const newProblems = (before, after) => {
	const known = new Set(findProblems(before).map(keyOfProblem));
	return findProblems(after).filter((problem) => !known.has(keyOfProblem(problem)));
};

/**
 * The English words of a loop or chain.
 * @param {SetProblem} problem
 */
export const problemMessage = (problem) =>
	problem.kind === 'loop'
		? `This makes a redirect loop: ${problem.steps.join(' → ')}.`
		: problem.gone
			? `This redirects to a page another rule removes (410): ${problem.steps.join(' → ')}.`
			: `This makes a redirect chain: ${problem.steps.join(' → ')}. Point the first rule at the final page.`;

// ------------------------------------------------------------------------------------------------------ CSV files

/**
 * The CSV export: one line per rule, A to Z by `from`.
 * @param {ReadonlyArray<RuleInput>} rules
 */
export const csvOf = (rules) =>
	toCsv(
		CSV_COLUMNS,
		[...rules]
			.sort((a, b) => (a.from < b.from ? -1 : 1))
			.map((rule) => [rule.from, rule.match, rule.to ?? '', rule.code, rule.note]),
	);

/**
 * @typedef {{ line: number, path: string, code: string, message: string, steps?: string[] }} RowProblem a problem of
 *   one line of a file (`line` 1 is the header; `path`: the column, '' for the whole file or line)
 */
/**
 * @typedef {{ line: number, action: 'create' | 'update', rule: RuleInput, before: RuleInput | null }} Change
 */
/**
 * @typedef {object} ImportPlan
 * @property {number} rows the file's rules (lines without the header)
 * @property {Change[]} changes what the file creates and changes, in file order (lines with a problem left out)
 * @property {number} unchanged rules of the file that are already as written
 * @property {RowProblem[]} errors every problem (an import with any writes nothing)
 * @property {Array<Rule | RuleInput>} next the rule set after the import
 */

/**
 * What a CSV file of rules does to a website's rules (pure; the dry run's answer, and the real import's plan): each
 * line is checked as a rule (columns `from`, `match`, `to`, `code`, `note`, in any order and letter case; `redirect
 * from` and `source` are read as `from`, `redirect to` and `destination` as `to`, `status` as `code`; other columns are
 * ignored). A `from` that has a rule changes it, a new one is created; nothing is deleted. Refused: a `from` twice in
 * the file, more than {@link MAX_RULES} rules in all, and loops and chains the file would bring.
 * @param {{ csv: string, existing: ReadonlyArray<Rule>, domain: string }} input
 * @returns {ImportPlan}
 */
export const planImport = ({ csv, existing, domain }) => {
	/** @param {RowProblem[]} errors @returns {ImportPlan} */
	const refused = (errors) => ({ rows: 0, changes: [], unchanged: 0, errors, next: [...existing] });
	const parsed = parseCsv(csv, { maxRows: MAX_RULES });
	if (!parsed.ok) {
		const message = {
			empty: 'The file is empty.',
			unterminated_quote: 'A quoted field of the file never ends.',
			too_many_rows: `The file has more than ${MAX_RULES} rules.`,
		}[parsed.code];
		return refused([{ line: 1, path: '', code: parsed.code, message }]);
	}
	/** @type {Record<string, string | undefined>} */
	const columns = Object.fromEntries(
		Object.entries(COLUMN_NAMES).map(([column, names]) => [column, names.find((name) => parsed.header.includes(name))]),
	);
	if (columns.from === undefined)
		return refused([{ line: 1, path: '', code: 'columns', message: 'The header names no from column.' }]);
	/** @type {RowProblem[]} */
	const errors = [];
	/** @type {Change[]} */
	const changes = [];
	let unchanged = 0;
	const stored = new Map(existing.map((rule) => [rule.from, rule]));
	/** @type {Map<string, number>} the line of each `from` in the file */
	const lines = new Map();
	/** @type {Map<string, Rule | RuleInput>} */
	const next = new Map(existing.map((rule) => [rule.from, rule]));
	for (const { line, values } of parsed.records) {
		/** @param {keyof typeof COLUMN_NAMES} column */
		const value = (column) => {
			const name = columns[column];
			return name === undefined ? undefined : values[name];
		};
		const checked = checkRule(
			{ from: value('from'), match: value('match'), to: value('to'), code: value('code'), note: value('note') },
			domain,
		);
		if (!checked.ok) {
			errors.push(...checked.errors.map((error) => ({ line, ...error })));
			continue;
		}
		const rule = checked.rule;
		const twice = lines.get(rule.from);
		if (twice !== undefined) {
			errors.push({ line, path: '/from', code: 'twice', message: `from is already on line ${twice} of the file.` });
			continue;
		}
		lines.set(rule.from, line);
		const before = stored.get(rule.from);
		if (before && sameRule(before, rule)) {
			unchanged += 1;
			continue;
		}
		changes.push({ line, action: before ? 'update' : 'create', rule, before: before ?? null });
		next.set(rule.from, before ? { ...before, ...rule } : rule);
	}
	if (next.size > MAX_RULES)
		errors.push({
			line: 1,
			path: '',
			code: 'too_many',
			message: `The website would have ${next.size} rules; it may have at most ${MAX_RULES}.`,
		});
	const after = [...next.values()];
	for (const problem of newProblems(existing, after))
		errors.push({
			line: lines.get(problem.first) ?? lines.get(problem.second) ?? 1,
			path: '/to',
			code: problem.kind === 'loop' ? 'loop' : problem.gone ? 'removed' : 'chain',
			message: problemMessage(problem),
			steps: problem.steps,
		});
	const refusedLines = new Set(errors.map((error) => error.line));
	return {
		rows: parsed.records.length,
		changes: changes.filter((change) => !refusedLines.has(change.line)),
		unchanged,
		errors: errors.sort((a, b) => a.line - b.line),
		next: after,
	};
};

// ------------------------------------------------------------------------------------------------- 404 suggestions

/**
 * The last segment of a path (`/a/blue-lamp` → `blue-lamp`).
 * @param {string} path
 */
const lastOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Rules to add, from the 404 log: the most-hit missing paths no rule answers, each with a target when a page that
 * visitors did open has the same last segment (`/old/blue-lamp` → `/lamps/blue-lamp`; the most viewed one), else null.
 * @param {{ totals: ReadonlyArray<{ metric: string, key: string, count: number }>, rules: ReadonlyArray<RuleInput>,
 *   limit: number }} input `totals`: the daily totals of the range (`not_found` and `page` are read)
 * @returns {Array<{ path: string, hits: number, to: string | null }>}
 */
export const suggestionsOf = ({ totals, rules, limit }) => {
	const index = createIndex(rules);
	/** @type {Map<string, number>} hits of each missing path no rule answers */
	const missing = new Map();
	/** @type {Set<string>} */
	const gone = new Set();
	for (const row of totals) {
		if (row.metric !== 'not_found') continue;
		const found = normalizePath(row.key);
		if (!found.ok) continue;
		gone.add(found.path);
		if (index.match(found.path) === null) missing.set(found.path, (missing.get(found.path) ?? 0) + row.count);
	}
	/** @type {Map<string, string>} the most viewed open page of each last segment */
	const pages = new Map();
	for (const row of [...totals].filter((total) => total.metric === 'page').sort((a, b) => b.count - a.count)) {
		const found = normalizePath(row.key);
		if (!found.ok || gone.has(found.path) || index.match(found.path) !== null) continue;
		const last = lastOf(found.path);
		if (last !== '' && !pages.has(last)) pages.set(last, found.path);
	}
	return [...missing]
		.map(([path, hits]) => ({ path, hits, to: pages.get(lastOf(path)) ?? null }))
		.sort((a, b) => b.hits - a.hits || (a.path < b.path ? -1 : 1))
		.slice(0, limit);
};

// -------------------------------------------------------------------------------------------- the activity log

/**
 * A rule in a few words (`To /new, 301, exact`; `Gone (410), prefix`).
 * @param {RuleInput} rule
 */
const ruleWords = (rule) => (rule.to === null ? `Gone (410), ${rule.match}` : `To ${rule.to}, ${rule.code}, ${rule.match}`);

/**
 * The activity-log texts of a created or deleted rule (PLAN 0.8.10 K9): its `from` as the label, what it does as the
 * detail.
 * @param {RuleInput} rule
 */
export const ruleActivity = (rule) => ({ label: rule.from, detail: `${ruleWords(rule)}.` });

/**
 * The activity-log texts of a changed rule: what changed, before → after.
 * @param {RuleInput} before
 * @param {RuleInput} after
 */
export const changeActivity = (before, after) => ({
	label: after.from,
	detail: `${[
		before.from === after.from ? null : `from ${before.from} → ${after.from}`,
		before.match === after.match ? null : `match ${before.match} → ${after.match}`,
		before.code === after.code ? null : `code ${before.code} → ${after.code}`,
		before.to === after.to ? null : `to ${before.to ?? 'none'} → ${after.to ?? 'none'}`,
		before.note === after.note ? null : 'note changed',
	]
		.filter(Boolean)
		.join('; ')}.`,
});

/**
 * The activity-log texts of an import.
 * @param {{ created: number, updated: number, unchanged: number }} counts
 */
export const importActivity = ({ created, updated, unchanged }) => ({
	label: 'redirects.csv',
	detail: `${created} new, ${updated} changed, ${unchanged} unchanged.`,
});
