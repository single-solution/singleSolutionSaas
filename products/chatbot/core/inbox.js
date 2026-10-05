/**
 * Inbox and handoff decisions (pure): when to hand off, to which team and agent (manual, round-robin, least loaded,
 * rules@1), whether a team is open, SLA due times (optionally in working time only), breach detection, canned
 * replies and the queue position text.
 * @module
 */
import { conditionMatches } from './rules.js';
import { containsPhrase, fill } from './text.js';
import { addWorkingMinutes, isOpenAt, nextOpenAt, zoneOr, MINUTE_MS } from './time.js';

/** @typedef {import('./conversation.js').Conversation} Conversation */
/** @typedef {{ key: string, name?: string, time_zone?: string, hours?: import('./time.js').HoursWindow[], first_response_minutes?: number, resolution_minutes?: number }} Team */
/** @typedef {{ id: string, name: string, status: 'online' | 'away' | 'offline', teams: string[], active: boolean, maxConcurrent: number | null }} Agent */

/**
 * @typedef {object} HandoffConfig
 * @property {boolean} allow_customer_request
 * @property {string[]} escalation_phrases
 * @property {string} when
 * @property {number} after_ai_failures
 */

/**
 * Should this customer message go to a person?
 * @param {{ text: string, conversation: Conversation, identified: boolean }} input
 * @param {HandoffConfig | null} config null = handoff off
 * @param {{ now: number, timeZone: string }} options
 * @returns {{ handoff: boolean, reason: string | null }}
 */
export const shouldHandoff = ({ text, conversation, identified }, config, { now, timeZone }) => {
	if (!config) return { handoff: false, reason: null };
	if (config.allow_customer_request && config.escalation_phrases.some((phrase) => containsPhrase(text, phrase)))
		return { handoff: true, reason: 'customer_request' };
	if (config.after_ai_failures > 0 && conversation.ai.failures >= config.after_ai_failures)
		return { handoff: true, reason: 'ai_failures' };
	if (config.when && config.when.trim()) {
		const { matched } = conditionMatches(
			config.when,
			{
				message: { text, length: [...text].length },
				conversation: {
					status: conversation.status,
					messages: conversation.counts.messages,
					customerMessages: conversation.counts.customer,
					tags: conversation.tags,
					priority: conversation.priority,
					language: conversation.language,
				},
				customer: { identified },
				ai: { failures: conversation.ai.failures, paused: conversation.ai.paused },
			},
			{ now, timeZone, whenEmpty: false },
		);
		if (matched) return { handoff: true, reason: 'rule' };
	}
	return { handoff: false, reason: null };
};

/**
 * May the AI answer while a handoff is pending? Only once nobody replied within the grace window.
 * @param {Conversation} conversation
 * @param {{ resumeAfterMinutes: number, now: number }} options
 */
export const aiMayResume = (conversation, { resumeAfterMinutes, now }) => {
	if (!conversation.ai.paused) return true;
	if (conversation.ai.reason === 'manual') return false;
	if (resumeAfterMinutes <= 0) return false;
	if (conversation.sla?.firstResponseAt) return false; // a person is handling it
	const since = Date.parse(conversation.ai.pausedAt ?? conversation.handoff?.at ?? '');
	return Number.isFinite(since) && now - since >= resumeAfterMinutes * MINUTE_MS;
};

/**
 * The team record (default team when the key is unknown or empty).
 * @param {Team[]} teams
 * @param {string | null | undefined} key
 * @param {string} defaultKey
 * @returns {Team}
 */
export const teamOf = (teams, key, defaultKey) =>
	teams.find((team) => team.key === key) ?? teams.find((team) => team.key === defaultKey) ?? teams[0] ?? { key: defaultKey };

/**
 * Is the team working now?
 * @param {Team} team
 * @param {number} now
 * @param {string} websiteZone
 */
export const teamOpen = (team, now, websiteZone) => isOpenAt(team.hours ?? [], now, zoneOr(team.time_zone, websiteZone));

/**
 * Next opening of a team (ISO) or null.
 * @param {Team} team
 * @param {number} now
 * @param {string} websiteZone
 */
export const teamOpensAt = (team, now, websiteZone) => {
	const at = nextOpenAt(team.hours ?? [], now, zoneOr(team.time_zone, websiteZone));
	return at === null ? null : new Date(at).toISOString();
};

/**
 * Rule-based routing: first matching rule (team / agent / priority).
 * @param {Array<{ when: string, team?: string, agent_id?: string, priority?: string }>} rules
 * @param {Record<string, unknown>} context
 * @param {{ now: number, timeZone: string }} options
 */
export const routeByRules = (rules, context, options) => {
	for (const rule of rules) {
		if (conditionMatches(rule.when, context, { ...options, whenEmpty: true }).matched)
			return { team: rule.team || null, agentId: rule.agent_id || null, priority: rule.priority || null };
	}
	return { team: null, agentId: null, priority: null };
};

/**
 * Pick an agent for a team.
 * @param {{ strategy: 'manual' | 'round_robin' | 'least_loaded' | 'rules', agents: Agent[], team: string,
 *   loads: Record<string, number>, defaultMax: number, cursor: number, preferred?: string | null }} input
 * @returns {{ agentId: string | null, cursor: number }}
 */
export const pickAgent = ({ strategy, agents, team, loads, defaultMax, cursor, preferred = null }) => {
	const available = agents
		.filter((a) => a.active && a.status === 'online' && (a.teams.length === 0 || a.teams.includes(team)))
		.filter((a) => (loads[a.id] ?? 0) < (a.maxConcurrent ?? defaultMax))
		.sort((a, b) => a.id.localeCompare(b.id));
	if (preferred && available.some((a) => a.id === preferred)) return { agentId: preferred, cursor };
	if (strategy === 'manual' || available.length === 0) return { agentId: null, cursor };
	if (strategy === 'least_loaded' || strategy === 'rules') {
		const best = [...available].sort((a, b) => (loads[a.id] ?? 0) - (loads[b.id] ?? 0) || a.id.localeCompare(b.id))[0];
		return { agentId: best?.id ?? null, cursor };
	}
	const index = ((cursor % available.length) + available.length) % available.length;
	return { agentId: available[index]?.id ?? null, cursor: cursor + 1 };
};

/**
 * SLA due times from a handoff instant.
 * @param {{ at: number, team: Team, firstResponseMinutes: number, resolutionMinutes: number, businessHoursOnly: boolean, websiteZone: string }} input
 */
export const slaFor = ({ at, team, firstResponseMinutes, resolutionMinutes, businessHoursOnly, websiteZone }) => {
	const first = team.first_response_minutes || firstResponseMinutes;
	const resolve = team.resolution_minutes || resolutionMinutes;
	const zone = zoneOr(team.time_zone, websiteZone);
	const add = (/** @type {number} */ minutes) =>
		new Date(
			businessHoursOnly ? addWorkingMinutes(team.hours ?? [], at, minutes, zone) : at + minutes * MINUTE_MS,
		).toISOString();
	return { firstResponseDueAt: add(first), firstResponseAt: null, resolutionDueAt: add(resolve), breached: [] };
};

/**
 * SLA targets missed by now (not yet recorded).
 * @param {Conversation} conversation
 * @param {number} now
 * @returns {string[]}
 */
export const slaBreaches = (conversation, now) => {
	const sla = conversation.sla;
	if (!sla || conversation.status === 'closed') return [];
	/** @type {string[]} */
	const out = [];
	if (
		!sla.firstResponseAt &&
		sla.firstResponseDueAt &&
		Date.parse(sla.firstResponseDueAt) <= now &&
		!sla.breached.includes('first_response')
	)
		out.push('first_response');
	if (
		!['resolved', 'closed'].includes(conversation.status) &&
		sla.resolutionDueAt &&
		Date.parse(sla.resolutionDueAt) <= now &&
		!sla.breached.includes('resolution')
	)
		out.push('resolution');
	return out;
};

/**
 * Render a canned reply with its placeholders.
 * @param {{ body: string }} reply
 * @param {{ customer_name?: string | null, agent_name?: string | null, conversation_id: string }} values
 */
export const renderCanned = (reply, values) =>
	fill(reply.body, {
		customer_name: values.customer_name ?? '',
		agent_name: values.agent_name ?? '',
		conversation_id: values.conversation_id,
	});

/**
 * Validate an agent body (create or patch).
 * @param {unknown} body
 * @param {{ partial?: boolean, teams: string[] }} options
 * @returns {Array<{ path: string, code: string }>}
 */
export const validateAgent = (body, { partial = false, teams }) => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ path: '', code: 'object_required' }];
	const b = /** @type {Record<string, any>} */ (body);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	for (const key of Object.keys(b))
		if (!['name', 'email', 'teams', 'status', 'active', 'maxConcurrent', 'userId'].includes(key))
			problems.push({ path: `/${key}`, code: 'unknown_field' });
	if (!partial || b.name !== undefined)
		if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) problems.push({ path: '/name', code: 'required' });
	if (
		b.email !== undefined &&
		b.email !== null &&
		(typeof b.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(b.email) || b.email.length > 320)
	)
		problems.push({ path: '/email', code: 'invalid' });
	if (b.teams !== undefined && (!Array.isArray(b.teams) || b.teams.some((t) => !teams.includes(t))))
		problems.push({ path: '/teams', code: 'unknown_team' });
	if (b.status !== undefined && !['online', 'away', 'offline'].includes(b.status))
		problems.push({ path: '/status', code: 'invalid' });
	if (b.active !== undefined && typeof b.active !== 'boolean') problems.push({ path: '/active', code: 'invalid' });
	if (
		b.maxConcurrent !== undefined &&
		b.maxConcurrent !== null &&
		(!Number.isInteger(b.maxConcurrent) || b.maxConcurrent < 1 || b.maxConcurrent > 200)
	)
		problems.push({ path: '/maxConcurrent', code: 'invalid' });
	if (b.userId !== undefined && (typeof b.userId !== 'string' || b.userId.length > 128))
		problems.push({ path: '/userId', code: 'invalid' });
	return problems;
};
