// @vitest-environment jsdom
/**
 * The value field of a connection (KP-1b, 247): "Save and test" empties the field only once the server has accepted the
 * key; a refused key stays in the field and the reason shows on the card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardProvider, DevelopersTab } from '../src/dashboard.js';
import { dashboardTexts } from '../src/index.js';
import { act, byLabel, cleanup, click, render, type } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	window.history.replaceState(null, '', '/');
});

const MANIFEST = { features: [{ key: 'notes', name: 'Notes', description: 'Keep notes.', dependsOn: [] }] };
const TEXTS = dashboardTexts({ title: 'Notes' });

const settle = async () => {
	for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

let sites = 0;
/** A website id no earlier test loaded (answers are kept per page). */
const freshSite = () => `cn${(sites += 1)}`;

/**
 * A product answering the connections of a website; the PUT of the mail key waits for `release` and then answers `put`.
 * @param {string} id
 * @param {{ status: number, body: unknown }} put
 */
const serve = (id, put) => {
	const base = `/v1/dashboard/websites/${id}`;
	/** @type {() => void} */
	let release = () => undefined;
	const gate = new Promise((resolve) => {
		release = () => resolve(undefined);
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) => {
			const method = init.method ?? 'GET';
			let status = 200;
			/** @type {unknown} */
			let body = null;
			if (method === 'GET' && path === `${base}/features`) body = { features: [] };
			else if (method === 'GET' && path === `${base}/connections`)
				body = { connections: [{ name: 'mail', label: 'Mail', kind: 'secret', neededBy: [], status: 'not_connected' }] };
			else if (method === 'PUT' && path === `${base}/connections/mail`) {
				await gate;
				({ status, body } = put);
			} else status = 404;
			return { ok: status < 400, status, json: async () => body };
		}),
	);
	return release;
};

/** @param {string} id */
const open = async (id) => {
	const view = render(
		<DashboardProvider manifest={MANIFEST} texts={TEXTS}>
			<DevelopersTab
				websiteId={id}
				merchantId="mer_1"
				domain="shop.example.com"
				who={{ kind: 'admin', id: 'a1', name: 'Alex Morgan', role: 'owner' }}
				support={{ channels: [] }}
				portal="https://portal.example.com"
				open={() => undefined}
			/>
		</DashboardProvider>,
	);
	await settle();
	click(/** @type {HTMLElement} */ (view.container.querySelector('[role="option"][data-ss-id="connection-mail"]')));
	return view;
};

/** @param {ParentNode} root */
const saveButton = (root) =>
	/** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save and test'));

describe('"Save and test" on a key (247)', () => {
	it('keeps the key in the field while the server has not answered, and empties it once the key is accepted', async () => {
		const id = freshSite();
		const release = serve(id, { status: 200, body: {} });
		const { container } = await open(id);
		const field = byLabel(container, 'New value');
		type(field, '  sk-live-123  ');
		await act(async () => {
			saveButton(container).click();
		});
		expect(field.value).toBe('  sk-live-123  ');
		await act(async () => {
			release();
		});
		await settle();
		expect(field.value).toBe('');
	});

	it('keeps the refused key in the field and says why on the card', async () => {
		const id = freshSite();
		const release = serve(id, {
			status: 422,
			body: { status: 422, code: 'product_rule', title: 'Refused', detail: 'The provider says this key is not valid.' },
		});
		const { container } = await open(id);
		const field = byLabel(container, 'New value');
		type(field, 'sk-wrong');
		await act(async () => {
			saveButton(container).click();
		});
		await act(async () => {
			release();
		});
		await settle();
		expect(field.value).toBe('sk-wrong');
		const card = /** @type {HTMLElement} */ (container.querySelector('#section-connection-mail'));
		expect(card.textContent).toContain('The provider says this key is not valid.');
	});

	it('takes the reason away when the key is edited again', async () => {
		const id = freshSite();
		const release = serve(id, {
			status: 422,
			body: { status: 422, code: 'product_rule', title: 'Refused', detail: 'Not valid.' },
		});
		const { container } = await open(id);
		type(byLabel(container, 'New value'), 'sk-wrong');
		await act(async () => {
			saveButton(container).click();
		});
		await act(async () => {
			release();
		});
		await settle();
		const card = /** @type {HTMLElement} */ (container.querySelector('#section-connection-mail'));
		expect(card.textContent).toContain('Not valid.');
		type(byLabel(container, 'New value'), 'sk-other');
		expect(card.textContent).not.toContain('Not valid.');
	});
});
