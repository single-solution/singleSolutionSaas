// @vitest-environment jsdom
/**
 * Navigation feedback of the consoles (PLAN 0.6 motion): the loading skeletons of both consoles (the layout of the page
 * that is coming: header, inner navigation, toolbar, table or cards), the console links, the client-side filter forms,
 * and the console API client of a page render (each read made once, one memo shared with the Portal) with the
 * in-request memo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hooks from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js';
import { act, cleanup, render } from '@ss/ui/testing';
import { Input } from '@ss/ui';
import { createConsoleApi } from '../../src/console/api.js';
import { Link, NavLink } from '../../src/console/link.js';
import { FilterForm, useNavigation } from '../../src/console/navigation.js';
import { ConsoleLoading, shapeOf } from '../../src/console/views/loading.js';
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
	testRouter.push.mockClear();
});

/**
 * @param {string} pathname
 * @param {import('react').ReactNode} node
 */
const at = (pathname, node) => <PathnameContext.Provider value={pathname}>{node}</PathnameContext.Provider>;

describe('loading skeletons', () => {
	it('knows the layout of the page each address opens', () => {
		// lists are a toolbar over a table with a footer, the menu entries already show their title
		expect(shapeOf('admin', '/admin/merchants')).toMatchObject({ body: 'table', list: true, columns: 7, title: 'Merchants' });
		expect(shapeOf('admin', '/admin/products')).toMatchObject({ body: 'table', list: true, title: 'Products' });
		expect(shapeOf('admin', '/admin/activity')).toMatchObject({ body: 'table', list: true, title: 'Activity' });
		expect(shapeOf('merchant', '/websites')).toMatchObject({ body: 'table', list: true, title: 'Websites' });
		// a page with parts has its inner navigation; the bare address of a merchant is its Websites table
		expect(shapeOf('admin', '/admin/merchants/mer_a')).toMatchObject({ body: 'table', nav: true, list: true });
		expect(shapeOf('admin', '/admin/merchants/mer_a/websites/web_a')).toMatchObject({ body: 'cards', nav: true });
		expect(shapeOf('admin', '/admin/finance/receipts')).toMatchObject({ body: 'table', nav: true });
		expect(shapeOf('merchant', '/credits/receipts')).toMatchObject({ body: 'table', nav: true });
		expect(shapeOf('admin', '/admin/settings')).toMatchObject({ body: 'cards', nav: true, title: 'Settings' });
		// the Overview is tiles and cards
		expect(shapeOf('admin', '/admin')).toMatchObject({ body: 'overview', title: 'Overview' });
		expect(shapeOf('merchant', '/overview')).toMatchObject({ body: 'overview' });
		// anything else: cards under an inner navigation
		expect(shapeOf('merchant', '/websites/web_a/settings')).toMatchObject({ body: 'cards', nav: true });
	});

	it('shows the skeleton of the page that is coming, or a sign-in card, with the progress bar', () => {
		const page = render(at('/admin/merchants/mer_a/websites/web_a', <ConsoleLoading area="admin" />));
		expect(page.container.textContent).toBe('Loading the page');
		expect(page.container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(page.container.querySelectorAll('.ss-shimmer').length).toBeGreaterThan(3);
		page.unmount();
		const list = render(at('/admin/merchants', <ConsoleLoading area="admin" />));
		expect(list.container.textContent).toContain('Merchants'); // the menu entry's own title, at once
		expect(list.container.querySelectorAll('.ss-shimmer').length).toBeGreaterThan(list.container.querySelectorAll('li').length);
		list.unmount();
		const settings = render(at('/admin/settings', <ConsoleLoading area="admin" />));
		expect(settings.container.textContent).toBe('Loading the pageSettings');
		settings.unmount();
		const signIn = render(at('/login', <ConsoleLoading area="merchant" />));
		expect(signIn.container.querySelector('.min-h-screen')).not.toBeNull();
		signIn.unmount();
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
	it('makes each read of a page render once and shares one memo with the Portal', async () => {
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
		const api = createConsoleApi({ handle, baseUrl: 'https://portal.test', cookie: 'ss_admin=x' });
		const [a, b] = await Promise.all([api.get('/v1/things'), api.get('/v1/things')]);
		expect(a).toEqual({ ok: true, status: 200, data: { items: ['/v1/things'] } });
		expect(b).toEqual(a);
		expect(/** @type {any} */ (a).data).not.toBe(/** @type {any} */ (b).data); // each caller its own copy
		expect(calls).toHaveLength(1);
		const memo = calls[0]?.memo;
		expect(memo).toBeInstanceOf(Map);
		await api.get('/v1/other');
		expect(calls[1]?.memo).toBe(memo);
		await api.get('/v1/things');
		expect(calls).toHaveLength(2);
		expect(await api.get('/v1/boom')).toMatchObject({ ok: false, status: 500, problem: { detail: 'down' } });
		expect(await api.get('/v1/text')).toEqual({ ok: true, status: 200, data: null });
		expect(await api.get('/v1/missing')).toMatchObject({ ok: false, status: 404, problem: { title: 'Not Found' } });
		expect(await api.get('/v1/empty-error')).toMatchObject({ ok: false, status: 500, problem: { title: 'Error' } });
		await expect(api.get('/not-v1')).rejects.toThrow(TypeError);
		// a new render reads afresh
		await createConsoleApi({ handle, baseUrl: 'https://portal.test' }).get('/v1/things');
		expect(calls.at(-1)?.memo).not.toBe(memo);
	});

	it('passes the address headers of the request on, so the Portal counts the same visitor', async () => {
		/** @type {Headers[]} */
		const seen = [];
		const handle = async (/** @type {Request} */ request) => {
			seen.push(request.headers);
			return Response.json({});
		};
		await createConsoleApi({
			handle,
			baseUrl: 'https://portal.test',
			forwardedFor: '10.0.0.1, 192.0.2.4',
			realIp: '192.0.2.4',
		}).get('/v1/things');
		expect([seen[0]?.get('x-forwarded-for'), seen[0]?.get('x-real-ip')]).toEqual(['10.0.0.1, 192.0.2.4', '192.0.2.4']);
		await createConsoleApi({ handle, baseUrl: 'https://portal.test' }).get('/v1/things');
		expect([seen[1]?.get('x-forwarded-for'), seen[1]?.get('x-real-ip')]).toEqual([null, null]);
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
