/** Mode A renderers: structure, accessibility, interactions, design tokens only and the widget bundle. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPack } from '@ss/cli/pack';
import manifest from '../manifest.json' with { type: 'json' };
import en from '../strings/en.json' with { type: 'json' };
import { render as renderLauncher, styles as launcherStyles } from '../ui/launcher.js';
import { el, notice, richText, safeHref } from '../ui/notes.js';
import { render as renderProactive, styles as proactiveStyles } from '../ui/proactive.js';
import { render as renderWindow, styles as windowStyles } from '../ui/window.js';
import { createFakeDom, findAll } from './helpers.js';

/** @param {Record<string, any>} [extra] */
const windowState = (extra = {}) =>
	/** @type {any} */ ({
		status: 'ready',
		open: true,
		conversationId: 'cnv_1',
		conversation: { id: 'cnv_1', status: 'open' },
		messages: [
			{ id: 'm1', author: 'customer', kind: 'text', text: 'Where is my order?', at: '2026-10-01T10:00:00.000Z', label: 'You' },
			{
				id: 'm2',
				author: 'bot',
				kind: 'text',
				text: 'It shipped — see **tracking** [here](/orders/1) or [evil](javascript:alert(1)).',
				at: '2026-10-01T10:00:01.000Z',
				label: 'Assistant',
			},
			{
				id: 'm3',
				author: 'bot',
				kind: 'text',
				text: 'Line one\n\nLine three https://x',
				at: '2026-10-01T10:00:02.000Z',
				label: 'Assistant',
				grouped: true,
			},
			{ id: 'm4', author: 'system', kind: 'event', text: 'A person will join.', at: '2026-10-01T10:00:03.000Z' },
		],
		hasMoreOlder: true,
		loadingOlder: false,
		draft: 'draft text',
		sending: false,
		typing: true,
		unread: 0,
		quickReplies: [{ label: 'Orders', value: 'orders' }],
		form: null,
		survey: null,
		rated: false,
		humanRequested: false,
		guestLimitReached: false,
		error: null,
		errorCode: null,
		...extra,
	});
const recorder = () => {
	/** @type {any[]} */
	const calls = [];
	const handler = {
		get:
			(/** @type {any} */ _t, /** @type {string} */ name) =>
			async (/** @type {any[]} */ ...args) =>
				calls.push([name, ...args]),
	};
	return { calls, actions: /** @type {any} */ (new Proxy({}, handler)) };
};

describe('ui/window renderer', () => {
	it('renders an accessible dialog with the log, quick replies, composer and slots', () => {
		const dom = createFakeDom();
		const { calls, actions } = recorder();
		const root = renderWindow({
			state: windowState(),
			actions,
			strings: en,
			theme: { variant: 'side_panel', avatarUrl: '/a.png', online: false },
			slots: { header: dom.createTextNode('H'), footer: dom.createTextNode('F') },
			dom,
		});
		expect(root.attributes).toMatchObject({
			role: 'dialog',
			'aria-modal': 'false',
			'aria-labelledby': 'ss-chat-title',
			dir: 'ltr',
			lang: 'en',
		});
		expect(root.attributes.class).toBe('ss-chat ss-chat--side_panel');
		expect(root.attributes.hidden).toBeUndefined();
		const [log] = findAll(root, (n) => n.attributes?.role === 'log');
		expect(log.attributes).toMatchObject({ 'aria-live': 'polite', 'aria-label': 'Conversation', 'aria-busy': 'false' });
		const links = findAll(root, (n) => n.tag === 'a');
		expect(links.map((a) => a.attributes.href)).toEqual(['/orders/1']);
		expect(findAll(root, (n) => n.tag === 'strong')[0].textContent).toBe('tracking');
		expect(findAll(root, (n) => n.attributes?.class?.includes('ss-chat__message--grouped'))).toHaveLength(1);
		expect(findAll(root, (n) => n.attributes?.role === 'note')[0].textContent).toBe('A person will join.');
		expect(root.textContent).toContain("We're away — leave a message");
		expect(root.textContent).toContain('Typing…');
		const buttons = findAll(root, (n) => n.tag === 'button');
		const byText = (/** @type {string} */ text) => buttons.find((b) => b.textContent === text);
		byText('Load earlier messages').dispatch('click');
		byText('Orders').dispatch('click');
		byText('×').dispatch('click');
		const [textarea] = findAll(root, (n) => n.tag === 'textarea');
		expect(textarea.value).toBe('draft text');
		textarea.dispatch('input', { target: { value: 'new' } });
		textarea.dispatch('keydown', { key: 'Enter', shiftKey: true });
		textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
		byText('Send').dispatch('click');
		root.dispatch('keydown', { key: 'Escape' });
		root.dispatch('keydown', { key: 'a' });
		expect(calls.map((c) => c[0])).toEqual(['loadOlder', 'choose', 'close', 'setDraft', 'send', 'send', 'close']);
		expect(root.children.at(-1).text).toBe('F');
	});
	it('renders the lead form, the CSAT survey, errors, closed and hidden states, and the empty slot', () => {
		const dom = createFakeDom();
		const { calls, actions } = recorder();
		const fields = [
			{ name: 'name', type: 'text', required: true },
			{ name: 'email', type: 'email', required: true },
			{ name: 'phone', type: 'phone' },
			{ name: 'msg', type: 'textarea', label: 'Your message' },
			{ name: 'topic', type: 'select', options: ['a', 'b'] },
			{ name: 'n', type: 'number' },
			{ name: 'ok', type: 'checkbox' },
		];
		const root = renderWindow({
			state: windowState({
				messages: [],
				hasMoreOlder: false,
				typing: false,
				quickReplies: [],
				form: { messageId: 'f', kind: 'lead', text: 'Leave details', fields },
				survey: { messageId: 's', scale: 3, comment: true },
				error: 'Oops',
				sending: true,
			}),
			actions,
			strings: en,
			dom,
		});
		expect(root.attributes.class).toBe('ss-chat ss-chat--bubble');
		expect(root.textContent).toContain('Ask us anything');
		const inputs = findAll(root, (n) => n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select');
		expect(inputs.map((i) => i.attributes.type ?? i.tag)).toEqual([
			'text',
			'email',
			'tel',
			'textarea',
			'select',
			'number',
			'checkbox',
			'checkbox',
			'textarea',
			'textarea',
		]);
		expect(inputs[0].attributes).toMatchObject({ required: '', 'aria-required': 'true' });
		inputs[0].value = 'Ana';
		inputs[1].value = 'ana@x.co';
		inputs[5].value = '3';
		inputs[6].checked = true;
		inputs[7].checked = true;
		const [form] = findAll(root, (n) => n.tag === 'form');
		form.dispatch('submit', { preventDefault: () => {} });
		expect(calls[0]).toEqual(['submitForm', { name: 'Ana', email: 'ana@x.co', n: 3, ok: true }, { consent: true }]);
		const scores = findAll(root, (n) => n.attributes?.['aria-label']?.endsWith('of 3'));
		expect(scores).toHaveLength(3);
		const [comment] = findAll(root, (n) => n.tag === 'textarea' && n.attributes.placeholder === 'Anything to add? (optional)');
		comment.value = 'nice';
		scores[2].dispatch('click');
		expect(calls[1]).toEqual(['rate', 3, 'nice']);
		expect(findAll(root, (n) => n.attributes?.role === 'alert')[0].textContent).toBe('Oops');
		expect(findAll(root, (n) => n.textContent === 'Send' && n.tag === 'button').at(-1).attributes.disabled).toBe('');
		const closed = renderWindow({
			state: windowState({
				open: false,
				conversation: { status: 'closed' },
				rated: true,
				hasMoreOlder: true,
				loadingOlder: true,
			}),
			actions,
			strings: { ...en, 'window.dir': 'rtl' },
			slots: {
				empty: dom.createTextNode('E'),
				before_messages: dom.createTextNode('B'),
				after_messages: dom.createTextNode('A'),
			},
			dom,
		});
		expect(closed.attributes).toMatchObject({ hidden: '', dir: 'rtl' });
		expect(closed.textContent).toContain('Thanks for your feedback!');
		findAll(closed, (n) => n.tag === 'button' && n.textContent === 'New conversation')[0].dispatch('click');
		expect(calls.at(-1)?.[0]).toBe('newConversation');
		expect(findAll(closed, (n) => n.tag === 'textarea')).toHaveLength(0);
		const guest = renderWindow({
			state: windowState({ guestLimitReached: true, messages: [], status: 'loading' }),
			actions,
			strings: en,
			slots: { empty: dom.createTextNode('E') },
			dom,
		});
		expect(findAll(guest, (n) => n.tag === 'textarea')).toHaveLength(0);
		const flowForm = renderWindow({
			state: windowState({
				form: { messageId: 'f', kind: 'flow', text: '', fields: [{ name: 'x', type: 'date' }] },
				survey: { messageId: 's', scale: 2, comment: false },
			}),
			actions,
			strings: en,
			dom,
		});
		findAll(flowForm, (n) => n.tag === 'form')[0].dispatch('submit', {});
		findAll(flowForm, (n) => n.attributes?.['aria-label'] === '1 of 2')[0].dispatch('click');
		expect(calls.slice(-2)).toEqual([
			['submitForm', {}, { consent: false }],
			['rate', 1, undefined],
		]);
	});
});

describe('ui/launcher and ui/proactive renderers', () => {
	const launcherState = (/** @type {Record<string, any>} */ extra = {}) =>
		/** @type {any} */ ({
			visible: true,
			open: false,
			unread: 3,
			label: 'Open chat',
			badge: '3',
			position: 'bottom_end',
			size: 'medium',
			icon: 'chat',
			avatarUrl: '',
			showLabel: false,
			pulse: true,
			mobileTab: false,
			offset: { x: 20, y: 20 },
			autoOpened: false,
			...extra,
		});
	it('renders the launcher button', () => {
		const dom = createFakeDom();
		const { calls, actions } = recorder();
		const button = renderLauncher({ state: launcherState(), actions, strings: en, dom });
		expect(button.tag).toBe('button');
		expect(button.attributes).toMatchObject({
			type: 'button',
			'aria-expanded': 'false',
			'aria-haspopup': 'dialog',
			'aria-label': 'Open chat — 3 unread messages',
		});
		expect(button.attributes.class).toBe('ss-launcher ss-launcher--medium ss-launcher--pulse');
		button.dispatch('click');
		expect(calls).toEqual([['toggle']]);
		const pill = renderLauncher({
			state: launcherState({
				open: true,
				badge: null,
				showLabel: true,
				position: 'bottom_start',
				mobileTab: true,
				icon: 'avatar',
				avatarUrl: '/a.png',
				visible: false,
				label: 'Close chat',
			}),
			actions,
			strings: en,
			theme: { variant: 'pill' },
			dom,
		});
		expect(pill.attributes.class).toBe('ss-launcher ss-launcher--medium ss-launcher--pill ss-launcher--start ss-launcher--tab');
		expect(pill.attributes.hidden).toBe('');
		expect(findAll(pill, (n) => n.tag === 'img')).toHaveLength(1);
		expect(pill.textContent).toBe('Chat');
		const slotted = renderLauncher({
			state: launcherState({ open: true, badge: null }),
			actions,
			strings: en,
			slots: { icon: dom.createTextNode('★') },
			dom,
		});
		expect(slotted.textContent).toBe('★');
		expect(
			renderLauncher({ state: launcherState({ icon: 'unknown', badge: null }), actions, strings: en, dom }).textContent,
		).toBe('💬');
	});
	it('renders the proactive teaser', () => {
		const dom = createFakeDom();
		const { calls, actions } = recorder();
		const teaser = renderProactive({
			state: /** @type {any} */ ({
				status: 'shown',
				message: { ruleId: 'cart', message: 'Need **help**?', openWindow: false, delaySeconds: 0 },
				error: null,
			}),
			actions,
			strings: en,
			slots: { before: dom.createTextNode('<'), after: dom.createTextNode('>') },
			dom,
		});
		expect(teaser.attributes).toMatchObject({
			role: 'status',
			'aria-live': 'polite',
			'aria-label': 'Message from the website',
		});
		expect(teaser.attributes.hidden).toBeUndefined();
		for (const button of findAll(teaser, (n) => n.tag === 'button')) button.dispatch('click');
		expect(calls.map((c) => c[0])).toEqual(['dismiss', 'reply']);
		expect(
			renderProactive({
				state: /** @type {any} */ ({ status: 'waiting', message: null, error: null }),
				actions,
				strings: en,
				dom,
			}).attributes.hidden,
		).toBe('');
	});
	it('shared helpers render text safely', () => {
		const dom = createFakeDom();
		expect(safeHref('/x')).toBe(true);
		expect(safeHref('//evil')).toBe(false);
		expect(safeHref('javascript:alert(1)')).toBe(false);
		expect(safeHref('https://x.test/a b')).toBe(false);
		expect(safeHref('mailto:a@b.co')).toBe(true);
		const lines = richText(dom, 'a [x](https://x.test/y) b\n');
		expect(lines).toHaveLength(2);
		expect(findAll(lines[0], (n) => n.tag === 'a')[0].attributes).toMatchObject({
			target: '_blank',
			rel: 'noopener noreferrer',
		});
		expect(notice(dom, 'n').attributes.role).toBe('note');
		expect(el(dom, 'p', {}, [null, 'x']).children).toHaveLength(1);
	});
});

describe('widget bundle and tokens', () => {
	it('builds the widget bundle (ss pack build) with every Mode A module', async () => {
		const pack = await buildPack(fileURLToPath(new URL('..', import.meta.url)));
		const paths = pack.assets.map((asset) => asset.path);
		for (const file of ['window', 'launcher', 'proactive'])
			expect(
				paths.some((path) => path.includes(file)),
				file,
			).toBe(true);
		expect(pack.manifest.product.slug).toBe(manifest.product.slug);
	}, 60_000);
	it('uses design tokens only', () => {
		for (const css of [windowStyles, launcherStyles, proactiveStyles]) {
			expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
			expect(css).toContain('var(--ss-color-');
			expect(css).toContain('prefers-reduced-motion');
		}
	});
});
