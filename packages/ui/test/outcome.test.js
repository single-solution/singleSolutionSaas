// @vitest-environment jsdom
/**
 * `SaveOutcome`, the outcome of saving a list or form for every product's editors: Saved and a refused save are toasts;
 * the errors that name a row or a field stay inline under the editor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardProvider, SaveOutcome } from '../src/dashboard.js';
import { problemLines } from '../src/index.js';
import { act, cleanup, render } from '../src/testing.js';

afterEach(() => cleanup());

const MANIFEST = { features: [{ key: 'notes', name: 'Notes', dependsOn: [] }] };

/** @param {import('react').ReactNode} node */
const inDashboard = (node) => (
	<DashboardProvider manifest={MANIFEST} texts={{ title: 'Notes' }}>
		{node}
	</DashboardProvider>
);

/** The toasts on the page, as their titles and descriptions. @param {HTMLElement} container */
const toasts = (container) =>
	[...container.querySelectorAll('[aria-live] p.font-medium')].map((title) => [
		title.textContent,
		title.nextElementSibling?.textContent ?? '',
	]);

/** @param {import('react').ReactNode} node */
const show = async (node) => {
	const view = render(inDashboard(node));
	await act(async () => undefined);
	return view;
};

describe('SaveOutcome', () => {
	it('says Saved in a toast and draws nothing in the page', async () => {
		const { container } = await show(<SaveOutcome result={{ ok: true, data: null }} />);
		expect(toasts(container)).toEqual([['Saved', '']]);
		expect(container.querySelector('[role="alert"] ul')).toBeNull();
	});

	it('shows a refused save as a toast with the reason, and leaves nothing on the page when no row is named', async () => {
		const { container } = await show(<SaveOutcome result={{ ok: false, problem: { status: 403 } }} />);
		expect(toasts(container)).toEqual([['Not saved', 'You do not have permission to do this.']]);
		expect(container.querySelector('ul')).toBeNull();
	});

	it('keeps the errors of rows and fields inline, with a toast that points to them', async () => {
		const problem = {
			status: 422,
			errors: [
				{ path: '/value/0/name', message: 'Name the zone.' },
				{ path: '/value', message: 'Add at least one rate.' },
			],
		};
		const { container } = await show(<SaveOutcome result={{ ok: false, problem }} title="Not saved: fix these first." />);
		expect([...container.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual([
			'/value/0/name: Name the zone.',
			'Add at least one rate.',
		]);
		expect(container.textContent).toContain('Not saved: fix these first.');
		expect(toasts(container)).toEqual([['Not saved', 'Fix what is listed under the editor, then save again.']]);
	});

	it('lists the errors the editor found itself first, and words the server’s rows its own way', async () => {
		const local = ['Give every rate a name.'];
		const own = await show(<SaveOutcome result={null} local={local} />);
		expect([...own.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(local);
		cleanup();
		const worded = await show(
			<SaveOutcome
				result={{ ok: false, problem: { errors: [{ path: '/value/1/url', message: 'Not a web address.' }] } }}
				format={(problem) => problem.errors.map((/** @type {{ message: string }} */ e) => `URL 2: ${e.message}`)}
			/>,
		);
		expect([...worded.container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['URL 2: Not a web address.']);
	});

	it('shows each new result once, and nothing before there is one', async () => {
		const { container, rerender } = await show(<SaveOutcome result={null} />);
		expect(toasts(container)).toEqual([]);
		const saved = { ok: /** @type {const} */ (true), data: null };
		rerender(inDashboard(<SaveOutcome result={saved} />));
		await act(async () => undefined);
		rerender(inDashboard(<SaveOutcome result={saved} />));
		await act(async () => undefined);
		expect(toasts(container)).toEqual([['Saved', '']]);
	});
});

describe('problemLines', () => {
	it('words a 422 answer whatever its shape, leaving out the list’s own path', () => {
		expect(
			problemLines({ errors: ['One.', { path: '/value/2/key', message: 'Two.' }, { path: '/value', message: 'Three.' }] }),
		).toEqual(['One.', '/value/2/key: Two.', 'Three.']);
		expect(problemLines({ errors: { key: 'Taken.' } })).toEqual(['key: Taken.']);
		expect(problemLines({})).toEqual([]);
		expect(problemLines(null)).toEqual([]);
	});
});
