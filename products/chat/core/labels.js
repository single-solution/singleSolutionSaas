/**
 * Conversation tags, topics and priorities (pure, C7): the merchant's three lists, each `{ key, name, description }`
 * (the description tells the AI when it fits). A conversation has any number of tags, one topic and one priority,
 * set by staff (inbox, server API) or, with the inbox setting AI tagging, by the AI, which may only pick keys of these
 * lists. Priorities are seeded with Urgent, High, Normal and Low (most urgent first); tags and topics start empty.
 * @module
 */

/** The three lists, by what a conversation keeps. */
export const LABEL_LISTS = Object.freeze(/** @type {const} */ (['tags', 'topics', 'priorities']));

/** Most entries of each list, tags on one conversation, and the longest name and description. */
export const LABEL_LIMITS = Object.freeze({ entries: 50, priorities: 10, perConversation: 10, name: 40, description: 200 });

/** A key of a tag, topic or priority. */
export const LABEL_KEY = /^[a-z][a-z0-9_-]{0,39}$/;
const KEY = LABEL_KEY;

/** @typedef {{ key: string, name: string, description: string }} Label */
/** @typedef {{ tags: readonly Label[], topics: readonly Label[], priorities: readonly Label[] }} Labels */
/** @typedef {{ tags: string[], topic: string | null, priority: string | null }} Labeled */

/** What a website starts with for priorities (most urgent first). @type {readonly Label[]} */
export const PRIORITY_SEED = Object.freeze(
	[
		['urgent', 'Urgent'],
		['high', 'High'],
		['normal', 'Normal'],
		['low', 'Low'],
	].map(([key, name]) => Object.freeze({ key: String(key), name: String(name), description: '' })),
);

/** @param {unknown} value */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The check of one of the lists: unique keys, a name and an optional description.
 * @param {string} noun `Tag`, `Topic` or `Priority`
 * @param {number} max
 * @returns {(items: unknown) => { ok: true, value: Label[] } | { ok: false, errors: string[] }}
 */
const labelCheck = (noun, max) => (items) => {
	if (!Array.isArray(items) || items.length > max) return { ok: false, errors: [`Up to ${max} entries.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {Label[]} */
	const value = [];
	const keys = new Set();
	items.forEach((item, index) => {
		const at = `${noun} ${index + 1}`;
		const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
		const key = typeof entry.key === 'string' ? entry.key : '';
		const name = typeof entry.name === 'string' ? entry.name.trim() : '';
		const description = typeof entry.description === 'string' ? entry.description.trim() : '';
		if (!KEY.test(key) || keys.has(key)) return void errors.push(`${at}: a unique key (lower-case letters, digits, - or _).`);
		if (name.length === 0 || name.length > LABEL_LIMITS.name)
			return void errors.push(`${at}: a name of up to ${LABEL_LIMITS.name} characters.`);
		if (description.length > LABEL_LIMITS.description)
			return void errors.push(`${at}: a description of up to ${LABEL_LIMITS.description} characters.`);
		keys.add(key);
		value.push({ key, name, description });
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

export const checkTags = labelCheck('Tag', LABEL_LIMITS.entries);
export const checkTopics = labelCheck('Topic', LABEL_LIMITS.entries);
export const checkPriorities = labelCheck('Priority', LABEL_LIMITS.priorities);

/**
 * Check what staff set on a conversation: `tags` (keys of the tags list, each once, the whole set), `topic` and
 * `priority` (a key of their list, or null to clear). Only the members sent are returned.
 * @param {Record<string, unknown>} body
 * @param {Labels} labels
 * @returns {{ ok: true, value: Partial<Labeled> } | { ok: false, errors: string[] }}
 */
export const checkLabeled = (body, labels) => {
	/** @type {Partial<Labeled>} */
	const value = {};
	/** @type {string[]} */
	const errors = [];
	if (body.tags !== undefined) {
		const tags = Array.isArray(body.tags) ? [...new Set(body.tags)] : null;
		if (
			!tags ||
			tags.length > LABEL_LIMITS.perConversation ||
			tags.some((tag) => !labels.tags.some((each) => each.key === tag))
		)
			errors.push(`tags: up to ${LABEL_LIMITS.perConversation} keys of your tags.`);
		else value.tags = /** @type {string[]} */ (tags);
	}
	for (const [member, list] of /** @type {const} */ ([
		['topic', 'topics'],
		['priority', 'priorities'],
	])) {
		const raw = body[member];
		if (raw === undefined) continue;
		if (raw === null) value[member] = null;
		else if (typeof raw === 'string' && labels[list].some((each) => each.key === raw)) value[member] = raw;
		else errors.push(`${member}: a key of your ${list}, or null.`);
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The names of a conversation's labels for the activity log (`Tags: VIP, Refund`), in the lists' words.
 * @param {Partial<Labeled>} set
 * @param {Labels} labels
 */
export const labeledDetail = (set, labels) => {
	/** @param {readonly Label[]} list @param {string | null | undefined} key */
	const nameOf = (list, key) => (key ? (list.find((each) => each.key === key)?.name ?? key) : 'none');
	return [
		...(set.tags !== undefined ? [`Tags: ${set.tags.map((key) => nameOf(labels.tags, key)).join(', ') || 'none'}`] : []),
		...(set.topic !== undefined ? [`Topic: ${nameOf(labels.topics, set.topic)}`] : []),
		...(set.priority !== undefined ? [`Priority: ${nameOf(labels.priorities, set.priority)}`] : []),
	].join('; ');
};

/**
 * The AI's instructions for tagging a conversation: pick only from the merchant's lists, answer JSON.
 * @param {Labels} labels
 */
export const taggingPrompt = (labels) => {
	/** @param {readonly Label[]} list */
	const lines = (list) =>
		list.length === 0
			? '(none)'
			: list.map((each) => `- ${each.key}: ${each.name}${each.description ? ` — ${each.description}` : ''}`).join('\n');
	return [
		'You label a customer conversation for the business’s staff. Use only the keys listed below; never invent one.',
		'Answer with JSON only: {"topic": key or null, "tags": [keys], "priority": key or null}.',
		'Pick the one topic that fits best, the tags that clearly apply (none is fine), and the priority; null when none fits.',
		'',
		'Topics:',
		lines(labels.topics),
		'',
		'Tags:',
		lines(labels.tags),
		'',
		'Priorities (most urgent first):',
		lines(labels.priorities),
	].join('\n');
};

/**
 * The AI's answer, kept to the merchant's keys (anything else is dropped).
 * @param {string} text
 * @param {Labels} labels
 * @returns {Labeled | null} null when the answer is not the JSON asked for
 */
export const parseTagging = (text, labels) => {
	const match = /\{[\s\S]*\}/.exec(text);
	if (!match) return null;
	let raw;
	try {
		raw = JSON.parse(match[0]);
	} catch {
		return null;
	}
	if (!isObject(raw)) return null;
	/** @param {readonly Label[]} list @param {unknown} key */
	const known = (list, key) => (typeof key === 'string' && list.some((each) => each.key === key) ? key : null);
	/** @type {string[]} */
	const tags = Array.isArray(raw.tags)
		? raw.tags
				.map((/** @type {unknown} */ tag) => known(labels.tags, tag))
				.filter((/** @type {string | null} */ tag) => tag !== null)
		: [];
	return {
		tags: [...new Set(tags)].slice(0, LABEL_LIMITS.perConversation),
		topic: known(labels.topics, raw.topic),
		priority: known(labels.priorities, raw.priority),
	};
};

/**
 * Conversations by each tag, topic and priority of the lists, in the lists' order (reports, C7).
 * @param {ReadonlyArray<{ tags: string[], topic: string | null, priority: string | null }>} rows
 * @param {Labels} labels
 */
export const labelCounts = (rows, labels) => {
	/** @param {readonly Label[]} list @param {(row: (typeof rows)[number], key: string) => boolean} has */
	const count = (list, has) =>
		list.map((each) => ({ key: each.key, name: each.name, conversations: rows.filter((row) => has(row, each.key)).length }));
	return {
		tags: count(labels.tags, (row, key) => row.tags.includes(key)),
		topics: count(labels.topics, (row, key) => row.topic === key),
		priorities: count(labels.priorities, (row, key) => row.priority === key),
	};
};
