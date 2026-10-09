// @vitest-environment jsdom
/**
 * Navigation feedback of the consoles (PLAN 0.6 motion): the loading skeletons of both consoles (a list-and-detail
 * screen keeps its list in place with the picked row marked), the kept list's scroll position and fade, the console
 * links, the client-side filter forms, and the console API client of a page render (each read made once, one memo
 * shared with the Portal) with the in-request memo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hooks from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js';
import { act, cleanup, render } from '@ss/ui/testing';
import { Input } from '@ss/ui';
import { createConsoleApi } from '../../src/console/api.js';
import { Link, NavLink } from '../../src/console/link.js';
import { FilterForm, useNavigation } from '../../src/console/navigation.js';
import { ListDetail, ListPane, ListRow } from '../../src/console/views/common.js';
import { ConsoleLoading, screenOf } from '../../src/console/views/loading.js';
import { forgetScreens, listScroll, listWasPlaceholder } from '../../src/console/views/screen-memory.js';
import { memoize, runInRequestScope } from '../../src/infra/request-scope.js';
import { testRouter } from './router.js';

vi.mock('next/navigation.js', async (importOriginal) => {
	const { testRouter } = await import('./router.js');
	return { .../** @type {object} */ (await importOriginal()), useRouter: () => testRouter };
});

const PathnameContext = /** @type {import('react').Context<string | null>} */ (
	/** @type {any} */ (hooks).PathnameContext ?? /** @type {any} */ (hooks).default.PathnameContext
);

afterEach(() => {
	cleanup();
	forgetScreens();
	testRouter.push.mockClear();
});

/**
 * The Merchants list pane as a screen renders it.
 * @param {string | null} selected
 */
const merchantList = (selected) => (
	<ListPane title="Merchants" count={2}>
		<ListRow href="/admin/merchants/mer_a?q=x" label="Alpha" current={selected === 'mer_a'} dot="success" meta="1 credit" />
		<ListRow href="/admin/merchants/mer_b" label="Beta" current={selected === null ? 'wide' : selected === 'mer_b'} />
	</ListPane>
);

/**
 * @param {string} pathname
 * @param {import('react').ReactNode} node
 */
const at = (pathname, node) => <PathnameContext.Provider value={pathname}>{node}</PathnameContext.Provider>;

describe('loading skeletons', () => {
	it('knows the list-and-detail screens of each console', () => {
		expect(screenOf('admin', '/admin/merchants/mer_a')?.section).toBe('admin/merchants');
		expect(screenOf('admin', '/admin/products')?.section).toBe('admin/products');
		expect(screenOf('admin', '/admin/settings')).toBeNull();
		expect(screenOf('merchant', '/websites/web_a')?.section).toBe('websites');
		expect(screenOf('merchant', '/websitesx')).toBeNull();
	});

	it('shows a page skeleton, a sign-in card skeleton or a list-and-detail skeleton, with the progress bar', () => {
		const page = render(at('/admin/finance', <ConsoleLoading area="admin" />));
		expect(page.container.textContent).toBe('Loading the page');
		expect(page.container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(page.container.querySelectorAll('.ss-shimmer').length).toBeGreaterThan(3);
		page.unmount();
		const signIn = render(at('/login', <ConsoleLoading area="merchant" />));
		expect(signIn.container.querySelector('.min-h-screen')).not.toBeNull();
		signIn.unmount();
		// no list kept yet: a placeholder list, then the real list fades in
		const screen = render(at('/admin/merchants/mer_b', <ConsoleLoading area="admin" />));
		expect(screen.container.querySelector('aside[aria-label="Merchants"] .ss-shimmer')).not.toBeNull();
		expect(screen.container.querySelector('a[href="/admin/merchants"]')?.textContent).toContain('Merchants'); // Back
		expect(listWasPlaceholder('admin/merchants')).toBe(true);
		screen.unmount();
		const fresh = render(
			<ListDetail
				section="admin/merchants"
				label="Merchants"
				back={{ href: '/admin/merchants', label: 'Merchants' }}
				list={merchantList('mer_a')}
				detail={<p>Alpha</p>}
				empty={null}
			/>,
		);
		expect(fresh.container.querySelector('aside > div')?.className).toContain('animate-ss-fade');
	});

	it('keeps the list of a screen in place, marks the picked row and restores its scroll position', () => {
		const shown = render(
			<ListDetail
				section="admin/merchants"
				label="Merchants"
				back={{ href: '/admin/merchants', label: 'Merchants' }}
				list={merchantList('mer_a')}
				detail={<p>Alpha detail</p>}
				empty={null}
			/>,
		);
		const rows = /** @type {HTMLUListElement} */ (shown.container.querySelector('ul'));
		rows.scrollTop = 40;
		act(() => {
			rows.dispatchEvent(new Event('scroll'));
		});
		expect(listScroll('admin/merchants')).toBe(40);
		expect(shown.container.querySelector('a[aria-current="page"]')?.textContent).toContain('Alpha');
		shown.unmount();

		const loading = render(at('/admin/merchants/mer_b', <ConsoleLoading area="admin" />));
		const marked = loading.container.querySelector('a[aria-current="page"]');
		expect(marked?.getAttribute('href')).toBe('/admin/merchants/mer_b');
		expect(loading.container.textContent).toContain('Alpha');
		expect(loading.container.querySelector('aside > div')?.className).not.toContain('animate-ss-fade');
		expect(/** @type {HTMLUListElement} */ (loading.container.querySelector('ul')).scrollTop).toBe(40);
		expect(listWasPlaceholder('admin/merchants')).toBe(false);
		loading.unmount();

		// the screen with nothing picked: the list kept, nothing marked, the detail skeleton beside it
		const auto = render(at('/admin/merchants', <ConsoleLoading area="admin" />));
		expect(auto.container.querySelector('a[aria-current="page"]')).toBeNull();
		expect(auto.container.textContent).not.toContain('Back');
	});
});

describe('console links and filter forms', () => {
	it('links carry their pending state; menu links have the spinner slot', () => {
		const { container } = render(
			<>
				<Link href="/admin/products" className="plain">
					Products
				</Link>
				<NavLink href="/admin/admins">Admins</NavLink>
			</>,
		);
		const [plain, nav] = [...container.querySelectorAll('a')];
		expect(plain?.className).toBe('plain');
		expect(plain?.querySelector('.ss-pending-hint')).toBeNull();
		expect(nav?.querySelector('.ss-pending-hint')).not.toBeNull();
	});

	it('a filter form opens the page with its filled fields as the query, without a page load', () => {
		window.history.replaceState(null, '', '/admin/finance?by=day');
		const { container } = render(
			<FilterForm label="Apply" className="row">
				<input type="hidden" name="by" value="merchant" />
				<Input label="Merchant" name="merchantId" defaultValue="mer_a" />
				<Input label="Method" name="method" defaultValue="" />
				<button type="submit">Apply</button>
			</FilterForm>,
		);
		const form = /** @type {HTMLFormElement} */ (container.querySelector('form'));
		expect(form.className).toBe('row');
		act(() => {
			form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		expect(testRouter.push).toHaveBeenCalledWith('/admin/finance?by=merchant&merchantId=mer_a');
		cleanup();
		const empty = render(
			<FilterForm>
				<Input label="Merchant" name="merchantId" defaultValue="" />
			</FilterForm>,
		);
		act(() => {
			empty.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		});
		expect(testRouter.push).toHaveBeenLastCalledWith('/admin/finance');
	});

	it('useNavigation pushes the address in a transition', () => {
		/** @type {ReturnType<typeof useNavigation> | null} */
		let nav = null;
		function Probe() {
			nav = useNavigation();
			return null;
		}
		render(<Probe />);
		act(() => /** @type {any} */ (nav).go('/admin/merchants?q=a'));
		expect(testRouter.push).toHaveBeenCalledWith('/admin/merchants?q=a');
		expect(/** @type {any} */ (nav).pending).toBe(false);
	});
});

describe('the console API of one page render', () => {
	it('makes each read once, shares one memo with the Portal and starts afresh after a write', async () => {
		/** @type {Array<{ method: string, path: string, memo: unknown }>} */
		const calls = [];
		/** @type {(request: Request, options?: { memo?: Map<string, unknown> }) => Promise<Response>} */
		const handle = async (request, options) => {
			const url = new URL(request.url);
			calls.push({ method: request.method, path: url.pathname, memo: options?.memo ?? null });
			if (url.pathname === '/v1/boom') throw new Error('down');
			if (url.pathname === '/v1/text') return new Response('not json', { status: 200 });
			if (url.pathname === '/v1/missing') return new Response('', { status: 404, statusText: 'Not Found' });
			if (url.pathname === '/v1/empty-error') return new Response('', { status: 500 });
			return Response.json({ items: [url.pathname] });
		};
		const api = createConsoleApi({ handle, baseUrl: 'https://portal.test', cookie: 'ss_admin=x', perRender: true });
		const [a, b] = await Promise.all([api.get('/v1/things'), api.get('/v1/things')]);
		expect(a).toEqual({ ok: true, status: 200, data: { items: ['/v1/things'] } });
		expect(b).toEqual(a);
		expect(/** @type {any} */ (a).data).not.toBe(/** @type {any} */ (b).data); // each caller its own copy
		expect(calls).toHaveLength(1);
		const memo = calls[0]?.memo;
		expect(memo).toBeInstanceOf(Map);
		await api.get('/v1/other');
		expect(calls[1]?.memo).toBe(memo);
		await api.post('/v1/things', { a: 1 });
		expect(calls[2]).toMatchObject({ method: 'POST', memo: null });
		await api.get('/v1/things');
		expect(calls).toHaveLength(4);
		expect(calls[3]?.memo).not.toBe(memo);
		expect(await api.get('/v1/boom')).toMatchObject({ ok: false, status: 500, problem: { detail: 'down' } });
		expect(await api.get('/v1/text')).toEqual({ ok: true, status: 200, data: null });
		expect(await api.get('/v1/missing')).toMatchObject({ ok: false, status: 404, problem: { title: 'Not Found' } });
		expect(await api.get('/v1/empty-error')).toMatchObject({ ok: false, status: 500, problem: { title: 'Error' } });
		await expect(api.get('/not-v1')).rejects.toThrow(TypeError);
		// a client of scripts and tests reads every time, without a memo
		const plain = createConsoleApi({ handle, baseUrl: 'https://portal.test' });
		await plain.get('/v1/things');
		await plain.get('/v1/things');
		expect(calls.slice(-2).map((c) => c.memo)).toEqual([null, null]);
	});

	it('memoize shares a value inside a page render only', async () => {
		let n = 0;
		const compute = () => (n += 1);
		expect(memoize('k', compute)).toBe(1);
		expect(memoize('k', compute)).toBe(2);
		const memo = new Map();
		const scope = { defer: () => undefined, memo };
		expect(runInRequestScope(scope, () => memoize('k', compute))).toBe(3);
		expect(runInRequestScope(scope, () => memoize('k', compute))).toBe(3);
		expect(runInRequestScope({ defer: () => undefined }, () => memoize('k', compute))).toBe(4);
	});
});
