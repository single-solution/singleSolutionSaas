/**
 * Teams and routing (C12): the list check, the team a chat goes to, and who gets it.
 */
import { describe, expect, it } from 'vitest';
import { checkTeams, inTeam, pickAssignee, teamFor } from '../core/routing.js';

describe('teams and routing (C12)', () => {
	it('checks the list of teams', () => {
		expect(checkTeams('x')).toEqual({ ok: false, errors: ['Send a list of teams.'] });
		expect(
			checkTeams([
				{
					name: ' Sales ',
					members: [' Ana@Shop.example.com ', 'usr_lee', ''],
					languages: ['fr', ''],
					pages: ['/wholesale/**'],
				},
			]),
		).toEqual({
			ok: true,
			value: [{ name: 'Sales', members: ['ana@shop.example.com', 'usr_lee'], languages: ['fr'], pages: ['/wholesale/**'] }],
		});
		expect(checkTeams([{ name: '', members: [], languages: ['French'], pages: ['wholesale'] }, 3])).toEqual({
			ok: false,
			errors: [
				'Team 1: give it a name of up to 60 characters.',
				'Team 1: list 1 to 100 members by email address or user id.',
				'Team 1: languages are codes such as en or pt-BR, up to 20.',
				'Team 1: pages are paths that start with /, up to 20.',
				'Team 2: not valid.',
			],
		});
	});

	it('finds the team by language or page, else the team for the rest, else everyone', () => {
		const french = { name: 'French', members: ['usr_a'], languages: ['fr'], pages: [] };
		const wholesale = { name: 'Wholesale', members: ['usr_b'], languages: [], pages: ['/wholesale/**'] };
		const rest = { name: 'Everyone else', members: ['usr_c'], languages: [], pages: [] };
		expect(teamFor([french, wholesale, rest], { language: 'fr-CA', path: '/wholesale/x' })?.name).toBe('French');
		expect(teamFor([french, wholesale, rest], { language: 'en', path: '/wholesale/x' })?.name).toBe('Wholesale');
		expect(teamFor([french, wholesale, rest], { language: null, path: '/shop' })?.name).toBe('Everyone else');
		expect(teamFor([french, wholesale], { language: null, path: null })).toBeNull();
		expect(inTeam({ ...french, members: ['ana@shop.example.com'] }, { id: 'usr_x', email: 'Ana@shop.example.com' })).toBe(true);
		expect(inTeam(french, { id: 'usr_x' })).toBe(false);
	});

	it('gives the chat by round robin or to the least busy', () => {
		const candidates = [
			{ id: 'usr_a', open: 3, lastAssignedAt: 100 },
			{ id: 'usr_b', open: 1, lastAssignedAt: 300 },
			{ id: 'usr_c', open: 1, lastAssignedAt: 200 },
		];
		expect(pickAssignee(candidates, 'round_robin')?.id).toBe('usr_a');
		expect(pickAssignee(candidates, 'least_busy')?.id).toBe('usr_c');
		expect(pickAssignee([...candidates, { id: 'usr_d', open: 0, lastAssignedAt: 0 }], 'round_robin')?.id).toBe('usr_d');
		expect(pickAssignee([], 'least_busy')).toBeNull();
	});
});
