// @vitest-environment jsdom
/**
 * Chat's feature settings in the dashboard (premium layout 2026-10-16): the kit's grouped settings cards on Chat's own
 * schema. AI replies declares `x-ui.group` and `x-ui.order`, so its settings are two titled cards in the order
 * the schema asks for (the tuning knobs of the AI are fixed limits in `core/limits.js` and have no form), on/off settings are toggles, and one sticky Save changes bar (with Discard) appears only while
 * something is edited.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byText, cleanup, click, render, type } from '@ss/ui/testing';
import { DashboardProvider, SettingsForms } from '@ss/ui/dashboard';
import manifest from '../manifest.json' with { type: 'json' };
import aiReplies from '../schemas/ai_replies.settings.json' with { type: 'json' };
import { TEXTS } from '../app/dashboard/texts.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** The AI replies feature with every setting at its default. */
const feature = () => ({
	key: 'ai_replies',
	name: 'AI replies',
	on: true,
	schema: aiReplies,
	values: Object.fromEntries(
		Object.entries(aiReplies.properties).map(([name, node]) => [
			name,
			{ value: /** @type {any} */ (node).default, source: 'default' },
		]),
	),
});

/** @param {import('react').ReactNode} node */
const inDashboard = (node) => (
	<DashboardProvider manifest={manifest} texts={TEXTS}>
		{node}
	</DashboardProvider>
);

describe('Chat settings in the dashboard', () => {
	it('shows AI replies as titled cards in the schema order, with toggles', () => {
		const { container } = render(
			inDashboard(
				<SettingsForms
					features={[feature()]}
					saveUrl={(key) => `/s/${key}`}
					resetBody={false}
					savedSource="website"
					reload={() => undefined}
				/>,
			),
		);
		// the feature is the heading; its groups are cards in `x-ui.order`, and Advanced is open after them
		expect(container.querySelector('h3')?.textContent).toBe('AI replies');
		// two groups are two titled cards; the tab strip starts at three groups
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
		const fields = () => [...container.querySelectorAll('[data-field]')].map((f) => f.getAttribute('data-field'));
		expect(fields()).toEqual([
			'style',
			'dontKnow',
			'onFailure',
			'bubbles',
			'tableBubble',
			'showAiLabel',
			'neverDisclose',
			'extraBotPhrases',
		]);
		// on/off settings are toggles, not checkboxes
		expect(container.querySelectorAll('[role="switch"]')).toHaveLength(3);
		expect(container.querySelector('input[type="checkbox"]')).toBeNull();
		// three choices with long words are a radio list
		expect(container.querySelectorAll('[role="radiogroup"] input[type="radio"]')).toHaveLength(3);
		// nothing is edited: no bar
		expect(container.textContent).not.toContain('Save changes');
	});

	it('offers Save changes and Discard only while something is edited, and saves every edited setting', async () => {
		/** @type {Array<{ method: string, path: string, body: unknown }>} */
		const requests = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
				requests.push({
					method: init.method ?? 'GET',
					path,
					body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
				});
				return { ok: true, status: 200, json: async () => ({}) };
			}),
		);
		const reload = vi.fn();
		const { container } = render(
			inDashboard(
				<SettingsForms
					features={[feature()]}
					saveUrl={(key) => `/s/${key}`}
					resetBody={false}
					savedSource="website"
					reload={reload}
				/>,
			),
		);
		const bar = () => container.ownerDocument.querySelector('[role="region"][aria-label="Save changes"]');
		expect(bar()).toBeNull();
		type(/** @type {HTMLInputElement} */ (container.querySelector('[data-field="bubbles"] input')), '3');
		click(/** @type {HTMLElement} */ (container.querySelector('[data-field="tableBubble"] [role="switch"]')));
		expect(bar()?.textContent).toContain('You have unsaved changes');
		// Discard puts the saved values back and removes the bar
		click(byText(/** @type {HTMLElement} */ (bar()), 'Discard', 'button'));
		expect(bar()).toBeNull();
		expect(/** @type {HTMLInputElement} */ (container.querySelector('[data-field="bubbles"] input')).value).toBe(
			String(aiReplies.properties.bubbles.default),
		);
		type(/** @type {HTMLInputElement} */ (container.querySelector('[data-field="bubbles"] input')), '3');
		await act(async () => byText(/** @type {HTMLElement} */ (bar()), 'Save changes', 'button').click());
		expect(requests).toEqual([{ method: 'PUT', path: '/s/ai_replies.bubbles', body: { value: 3 } }]);
		expect(bar()).toBeNull();
		expect(container.textContent).toContain('Saved');
		expect(reload).toHaveBeenCalled();
	});
});
