/**
 * Teams and routing (C12; pure): the merchant's teams (the list `teams`: a name, its members by email address or
 * Accounts user id, and the chats it takes by the visitor's language or the page), the team a chat goes to, and who in
 * it gets the chat: round robin (the online member who got one the longest ago) or least busy (the fewest open chats,
 * then the longest ago). Members away, offline or full (max chats) get none.
 * @module
 */
import { USER_ID } from './conversation.js';
import { primary } from './language.js';
import { pathMatches } from './text.js';

/** The list's limits. */
const TEAM_LIMITS = Object.freeze({ teams: 20, name: 60, members: 100, languages: 20, pages: 20 });

/** How chats are given out automatically (setting Assign automatically of Assignment). */
export const ROUTED = Object.freeze(/** @type {const} */ (['round_robin', 'least_busy']));

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/**
 * @typedef {{ name: string, members: string[], languages: string[], pages: string[] }} Team `members`: email addresses
 *   (lower-case) or Accounts user ids; `languages`: codes such as en; `pages`: path patterns such as /wholesale/**
 */

/** @param {unknown} value */
const lines = (value) =>
	(Array.isArray(value) ? value : [])
		.map((line) => (typeof line === 'string' ? line.trim() : line))
		.filter((line) => line !== '');

/**
 * Check the list `teams`.
 * @param {unknown} raw
 * @returns {{ ok: true, value: Team[] } | { ok: false, errors: string[] }}
 */
export const checkTeams = (raw) => {
	if (!Array.isArray(raw)) return { ok: false, errors: ['Send a list of teams.'] };
	if (raw.length > TEAM_LIMITS.teams) return { ok: false, errors: [`Up to ${TEAM_LIMITS.teams} teams.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {Team[]} */
	const value = [];
	raw.forEach((item, index) => {
		const at = `Team ${index + 1}:`;
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			errors.push(`${at} not valid.`);
			return;
		}
		const name = typeof item.name === 'string' ? item.name.trim() : '';
		if (name === '' || [...name].length > TEAM_LIMITS.name)
			errors.push(`${at} give it a name of up to ${TEAM_LIMITS.name} characters.`);
		const members = lines(item.members).map((member) =>
			typeof member === 'string' && member.includes('@') ? member.toLowerCase() : member,
		);
		if (
			members.length === 0 ||
			members.length > TEAM_LIMITS.members ||
			members.some((member) => typeof member !== 'string' || !(EMAIL.test(member) || USER_ID.test(member)))
		)
			errors.push(`${at} list 1 to ${TEAM_LIMITS.members} members by email address or user id.`);
		const languages = lines(item.languages);
		if (
			languages.length > TEAM_LIMITS.languages ||
			languages.some((language) => typeof language !== 'string' || !LANGUAGE.test(language))
		)
			errors.push(`${at} languages are codes such as en or pt-BR, up to ${TEAM_LIMITS.languages}.`);
		const pages = lines(item.pages);
		if (
			pages.length > TEAM_LIMITS.pages ||
			pages.some((page) => typeof page !== 'string' || !page.startsWith('/') || page.length > 200)
		)
			errors.push(`${at} pages are paths that start with /, up to ${TEAM_LIMITS.pages}.`);
		value.push({
			name,
			members: /** @type {string[]} */ (members),
			languages: /** @type {string[]} */ (languages),
			pages: /** @type {string[]} */ (pages),
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
};

/**
 * The team a chat goes to: the first whose languages hold the visitor's language or whose pages match the page, else
 * the first team with neither (it takes the rest); null: every member of staff.
 * @param {Team[]} teams
 * @param {{ language: string | null, path: string | null }} chat
 * @returns {Team | null}
 */
export const teamFor = (teams, { language, path }) =>
	teams.find(
		(team) =>
			(language !== null && team.languages.some((code) => primary(code) === primary(language))) ||
			(path !== null && team.pages.some((pattern) => pathMatches(pattern, path))),
	) ??
	teams.find((team) => team.languages.length === 0 && team.pages.length === 0) ??
	null;

/**
 * Whether a member of staff is in a team (by user id, or by email address, any case).
 * @param {Team} team
 * @param {{ id: string, email?: string | null }} member
 */
export const inTeam = (team, member) =>
	team.members.includes(member.id) || (typeof member.email === 'string' && team.members.includes(member.email.toLowerCase()));

/**
 * Who gets a chat among the members who can take one (online, not full): round robin, the one who got a chat the
 * longest ago (never first); least busy, the fewest open chats, then the longest ago; then by id. Null: nobody.
 * @param {Array<{ id: string, open: number, lastAssignedAt: number }>} candidates
 * @param {(typeof ROUTED)[number]} mode
 */
export const pickAssignee = (candidates, mode) =>
	[...candidates].sort(
		(a, b) => (mode === 'least_busy' ? a.open - b.open : 0) || a.lastAssignedAt - b.lastAssignedAt || (a.id < b.id ? -1 : 1),
	)[0] ?? null;
