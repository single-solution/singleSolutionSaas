/**
 * The visitor chat (PLAN 0.8.3): the launcher with its unread badge, the chat window (floating or side panel, full
 * screen on phones when set) with the welcome text, messages (AI label, staff names, human-like typing pace, typing
 * and Seen with typing receipts, product cards with Add to cart), the composer with attachments, flows, contact and
 * lead forms, the guest limit,
 * handoff, queue position, office hours, ratings, transcripts and End chat, plus the proactive messages. Live updates
 * come from the back-off checks of `transport.js`.
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_LENGTH, PACE } from '../core/widgets.js';
import { cardsPart, contactPart, flowPart, leadPart, ratingPart, signInPart, transcriptPart } from './chat-parts.js';
import {
	attachmentNode,
	buttonOf,
	fieldMaker,
	fileProblem,
	invalidText,
	problemCode,
	setHidden,
	settingsOf,
	textsOf,
	uploadFile,
	webAddress,
	when,
} from './common.js';
import { element } from './dom.js';
import { createMemory, pageFlow, startProactive } from './proactive.js';
import { WIDGET_CSS } from './styles.js';
import { createChecks, createUnreadChecks } from './transport.js';

/** @typedef {{ kind: string, productId?: string, productName?: string }} PageInfo what `SSChat.setPage()` gave */
/**
 * @typedef {object} Message
 * @property {string} id
 * @property {number} seq
 * @property {'visitor' | 'ai' | 'staff' | 'system'} author
 * @property {string | null} name
 * @property {string} text
 * @property {{ name: string, type: string, size: number, url: string }} [attachment]
 * @property {import('../core/shop.js').ProductCard[]} [cards] product cards under an AI answer
 */

/** What the guest limit leads to. */
const LIMIT_STEPS = Object.freeze(['sign_in', 'lead', 'none']);
const NO_CHAT = Object.freeze({
	conversation: null,
	visitor: { kind: 'none', name: null, email: null },
	guestLimit: null,
	lastSeq: 0,
});

/**
 * Mount the visitor chat into `host` (a host element the widget appended to the page).
 * @param {{ win: Window, host: HTMLElement, config: import('./common.js').WidgetConfig,
 *   visitor: import('./visitor.js').Visitor, clock: Omit<import('./transport.js').Clock, 'win'>,
 *   page: () => PageInfo | null, onUnread: (count: number) => void }} input
 */
export const mountChat = ({ win, host, config, visitor, clock, page, onUnread }) => {
	const t = textsOf(config);
	const s = settingsOf(config);
	/** @param {string} feature */
	const on = (feature) => config.features.includes(feature);
	const doc = win.document;
	const memory = createMemory({ win, now: clock.now });
	const make = fieldMaker(doc, 'ss-chat');
	const botName = s.look.botName || t('chat.title');
	const fileTypes = s.attachments.types.filter((type) => ATTACHMENT_TYPES.includes(type));
	const maxBytes = Math.min(s.attachments.maxBytes || MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
	visitor.rememberFor(s.guests.rememberDays);

	/** @type {any} the Chat view of the API */
	let chat = NO_CHAT;
	let isOpen = false;
	let loaded = false;
	let stopped = false;
	/** @type {string | null} */
	let limit = null;
	let leadSent = false;
	let rated = false;
	let wantsTranscript = false;
	/** @type {Record<string, string> | null} contact given before the first message */
	let pendingContact = null;
	let lastSeq = 0;
	let needRead = false;
	let typingPace = false;
	let readDelay = 0;
	/** @type {number | null} */
	let pacer = null;
	let panelKey = '';
	/** @type {Message[]} */
	const queue = [];
	/** @type {Map<string, { message: Message, node: HTMLElement }>} */
	const shown = new Map();

	// the elements
	const box = element(doc, 'div', {
		class: 'chat',
		'data-position': s.look.launcherPosition,
		'data-style': s.look.windowStyle,
		...(s.look.fullScreenOnMobile ? { 'data-full': '' } : {}),
	});
	const launcher = buttonOf(doc, s.look.launcherStyle === 'label' ? t('chat.launcher') : '', {
		class: `launcher ${s.look.launcherStyle === 'label' ? 'label' : 'round'}`,
		'aria-label': t('chat.launcher'),
		'aria-expanded': 'false',
	});
	if (s.look.launcherStyle !== 'label') launcher.append(bubbleIcon(doc));
	const badge = element(doc, 'span', { class: 'badge', hidden: '' });
	launcher.append(badge);
	const nudge = element(doc, 'div', { class: 'nudge', hidden: '' });
	const nudgeText = buttonOf(doc, '', { class: 'link' });
	const nudgeClose = buttonOf(doc, '×', { class: 'link dismiss', 'aria-label': t('chat.dismiss') });
	nudge.append(nudgeText, nudgeClose);

	const panel = element(doc, 'section', { class: 'window', role: 'dialog', 'aria-label': botName, hidden: '' });
	const head = element(doc, 'header', { class: 'head' });
	const avatarUrl = webAddress(s.look.avatarUrl);
	head.append(
		avatarUrl
			? element(doc, 'img', { class: 'avatar', src: avatarUrl, alt: '' })
			: element(doc, 'span', { class: 'avatar' }, [...botName][0] ?? ''),
		element(doc, 'strong', { class: 'name' }, botName),
	);
	const closer = buttonOf(doc, t('chat.close'), { class: 'link close' });
	head.append(closer);
	const log = element(doc, 'ul', { class: 'log', role: 'log', 'aria-live': 'polite' });
	const welcome = element(doc, 'li', { class: 'msg ai welcome' });
	log.append(welcome);
	const typing = element(doc, 'p', { class: 'typing', hidden: '' }, t('chat.typing'));
	const notices = element(doc, 'div', { class: 'notices' });
	const slot = element(doc, 'div', { class: 'slot' });
	const tools = element(doc, 'div', { class: 'tools' });
	const talk = buttonOf(doc, t('chat.talkToPerson'), { class: 'secondary small' });
	const copy = buttonOf(doc, t('chat.transcript'), { class: 'secondary small' });
	const end = buttonOf(doc, t('chat.end'), { class: 'secondary small' });
	tools.append(talk, copy, end);
	const composer = /** @type {HTMLFormElement} */ (element(doc, 'form', { class: 'composer' }));
	const file = /** @type {HTMLInputElement} */ (
		element(doc, 'input', { type: 'file', accept: fileTypes.join(','), hidden: '', 'aria-label': t('chat.attach') })
	);
	const attach = buttonOf(doc, t('chat.attach'), { class: 'secondary small attach' });
	const input = /** @type {HTMLTextAreaElement} */ (
		element(doc, 'textarea', {
			rows: '2',
			maxlength: String(MAX_MESSAGE_LENGTH),
			placeholder: t('chat.placeholder'),
			'aria-label': t('chat.placeholder'),
		})
	);
	const sendButton = element(doc, 'button', { type: 'submit' }, t('chat.send'));
	composer.append(file, attach, input, sendButton);
	const note = element(doc, 'p', { class: 'status', role: 'status' });
	panel.append(head, log, typing, notices, slot, tools, composer, note);
	box.append(nudge, panel, launcher);

	// talking to the API
	/** @param {string} method @param {string} path @param {unknown} [body] */
	const call = async (method, path, body) => {
		const answer = await visitor.call(method, path, body);
		if (answer.status === 403 && problemCode(answer.data) === 'product_unavailable') halt();
		return answer;
	};
	/** @param {import('./common.js').Answer} answer */
	const failure = (answer) => {
		const code = problemCode(answer.data);
		if (code === 'message_rejected') return t('chat.rejected');
		if (code === 'rate_limited') return t('chat.rateLimited');
		if (code === 'notifications_not_connected') return t('chat.transcriptUnavailable');
		return invalidText(answer) || t('chat.error');
	};
	const here = () => win.location.href;
	const pageContext = () => {
		const info = page();
		return {
			url: `${win.location.origin}${win.location.pathname}`,
			title: doc.title,
			kind: info?.kind ?? 'other',
			...(info?.productId ? { productId: info.productId } : {}),
			...(info?.productName ? { productName: info.productName } : {}),
		};
	};
	const isGuest = () => chat.visitor.kind !== 'user' && !visitor.signedIn();
	const nextStep = () =>
		on('signed_in_chat') && webAddress(s.signInUrl, here()) ? 'sign_in' : on('leads_flows') ? 'lead' : 'none';

	/** @param {number} count */
	const setUnread = (count) => {
		badge.textContent = count > 0 ? String(count) : '';
		setHidden(badge, count <= 0);
		onUnread(count);
	};

	/** @param {Message} message */
	const messageNode = (message) => {
		const item = element(doc, 'li', { class: `msg ${message.author}` });
		if (message.author === 'ai' || message.author === 'staff') {
			const who = element(doc, 'span', { class: 'who' }, message.author === 'ai' ? botName : message.name || t('chat.staff'));
			if (message.author === 'ai' && on('ai_replies') && s.ai.showLabel)
				who.append(' ', element(doc, 'span', { class: 'tag' }, t('chat.aiLabel')));
			item.append(who);
		}
		if (message.text) item.append(element(doc, 'p', {}, message.text));
		if (message.attachment) item.append(attachmentNode(doc, message.attachment));
		if (message.cards && message.cards.length > 0 && on('product_cards'))
			item.append(cardsPart({ doc, win, t, cards: message.cards }));
		return item;
	};
	/** @param {Message} message */
	const show = (message) => {
		const node = messageNode(message);
		shown.set(message.id, { message, node });
		log.append(node);
		node.scrollIntoView?.({ block: 'end' });
		if (message.author !== 'visitor') needRead = true;
		if (message.author === 'ai' || message.author === 'staff') checks.settle();
	};
	const pump = () => {
		if (pacer !== null) return;
		const next = queue[0];
		if (!next) {
			typingPace = false;
			paint();
			return;
		}
		if (next.author !== 'ai') {
			queue.shift();
			show(next);
			pump();
			return;
		}
		const delay = readDelay + Math.min(PACE.maxTypingMs, next.text.length * PACE.msPerChar);
		readDelay = 0;
		typingPace = true;
		paint();
		pacer = clock.schedule(() => {
			pacer = null;
			queue.shift();
			show(next);
			pump();
		}, delay);
	};
	/** @param {Message[]} messages @param {boolean} paced new AI messages get the typing pace */
	const enqueue = (messages, paced) => {
		for (const message of messages) {
			if (shown.has(message.id) || queue.some((each) => each.id === message.id)) continue;
			lastSeq = Math.max(lastSeq, message.seq);
			if (paced || queue.length > 0) queue.push(message);
			else show(message);
		}
		if (queue.length > 0) pump();
	};
	/** @param {any} view */
	const apply = (view) => {
		chat = { ...NO_CHAT, ...view };
		const guestLimit = chat.guestLimit;
		if (!limit && isGuest() && guestLimit && guestLimit.limit > 0 && guestLimit.used >= guestLimit.limit) limit = nextStep();
		paint();
	};
	/** @param {any} data a Chat view with `messages` @param {boolean} paced */
	const receive = (data, paced) => {
		enqueue(Array.isArray(data.messages) ? data.messages : [], paced);
		apply(data);
	};
	/** @returns {Promise<Message[]>} the new messages */
	const poll = async () => {
		const answer = await call('GET', `/v1/chat?after=${lastSeq}`);
		if (!answer.ok) return [];
		receive(answer.data, isOpen);
		return answer.data.messages ?? [];
	};
	const load = async () => {
		if (!visitor.known()) return paint();
		const answer = await call('GET', '/v1/chat');
		if (answer.ok) receive(answer.data, false);
	};
	const loadUnread = async () => {
		if (!visitor.known() || stopped) return;
		const answer = await call('GET', '/v1/chat/unread');
		if (answer.ok && typeof answer.data?.unread === 'number') setUnread(answer.data.unread);
	};
	const markRead = async () => {
		if (!needRead || !isOpen || doc.hidden || !chat.conversation) return;
		needRead = false;
		chat = { ...chat, conversation: { ...chat.conversation, unread: 0 } };
		setUnread(0);
		await call('POST', '/v1/chat/read');
	};
	const checks = createChecks({ win, ...clock, check: async () => void (await poll()) });
	const closedChecks = createUnreadChecks({ win, ...clock, check: loadUnread });

	/** @param {string} text */
	const say = (text) => {
		note.textContent = text;
	};

	// sending
	/** @param {string} text @param {object} [attachment] */
	const sendMessage = async (text, attachment) => {
		say('');
		const answer = await call('POST', '/v1/chat/messages', {
			text,
			...(attachment ? { attachment } : {}),
			page: pageContext(),
		});
		if (!answer.ok) {
			const code = problemCode(answer.data);
			if (code === 'sign_in_required') limit = 'sign_in';
			else if (code === 'guest_limit_reached') limit = LIMIT_STEPS.includes(answer.data.next) ? answer.data.next : nextStep();
			else if (code !== 'product_unavailable') say(failure(answer));
			paint();
			return false;
		}
		visitor.keepGuest(answer.data.guestKey);
		readDelay = Math.min(PACE.maxReadingMs, text.length * PACE.readingMsPerChar);
		receive({ ...answer.data.chat, messages: [answer.data.message] }, false);
		if (pendingContact) {
			const contact = pendingContact;
			pendingContact = null;
			const saved = await call('POST', '/v1/chat/contact', contact);
			if (saved.ok) apply(saved.data.chat);
		}
		checks.start();
		if (on('ai_replies')) checks.expectReply();
		return true;
	};
	/** A POST that answers `{ chat }`, then the new messages. @param {string} path @param {unknown} [body] */
	const act = async (path, body) => {
		const answer = await call('POST', path, body);
		if (!answer.ok) return answer;
		apply(answer.data.chat);
		await poll();
		checks.start();
		return answer;
	};
	/** @param {string} answer */
	const sendFlow = async (answer) => {
		const sent = await act('/v1/chat/flow', { answer });
		return sent.ok ? '' : invalidText(sent) || t('chat.flowInvalid');
	};
	/** @param {import('./common.js').ChatSettings['flows'][number]} flow */
	const startFlow = async (flow) => {
		memory.startFlow(flow.id);
		const answer = await call('POST', `/v1/chat/flows/${encodeURIComponent(flow.id)}/start`, { page: pageContext() });
		if (!answer.ok) return [];
		visitor.keepGuest(answer.data.guestKey);
		apply(answer.data.chat);
		return poll();
	};

	// the parts above the composer
	const kit = { doc, t, make };
	const limitNode = () => {
		if (limit === 'sign_in') return signInPart({ ...kit, signInUrl: s.signInUrl, here: here() });
		if (limit === 'lead' && on('leads_flows'))
			return leadSent
				? element(doc, 'p', { class: 'notice' }, t('chat.leadThanks'))
				: leadPart({
						...kit,
						leads: s.leads,
						customFields: on('custom_fields') ? s.customFields : [],
						send: async (fields, consent) => {
							const answer = await call('POST', '/v1/chat/leads', { fields, ...(consent ? { consent } : {}) });
							if (!answer.ok) return failure(answer);
							leadSent = true;
							paint();
							return '';
						},
					});
		return element(doc, 'p', { class: 'notice' }, t('chat.limitReached'));
	};
	const contactNode = () =>
		contactPart({
			...kit,
			send: async (contact) => {
				if (!chat.conversation) {
					pendingContact = contact;
					paint();
					return '';
				}
				const answer = await call('POST', '/v1/chat/contact', contact);
				if (!answer.ok) return failure(answer);
				apply(answer.data.chat);
				return '';
			},
		});
	/** @param {any} flow */
	const flowNode = (flow) => {
		const field = String(flow.step.field ?? '');
		/** @type {Record<string, string>} */
		const labels = { name: t('chat.name'), email: t('chat.email'), phone: t('chat.phone') };
		const label = labels[field] ?? s.customFields.find((each) => each.key === field)?.label ?? t('chat.answer');
		return flowPart({ ...kit, step: flow.step, label, send: sendFlow });
	};
	const ratingNode = () =>
		ratingPart({
			...kit,
			scale: Number(s.ratings.scale),
			comment: Boolean(s.ratings.comment),
			send: async (score, comment) => {
				const answer = await call('POST', '/v1/chat/rating', { score, ...(comment ? { comment } : {}) });
				if (!answer.ok) return failure(answer);
				rated = true;
				say(t('chat.ratingThanks'));
				apply(answer.data.chat);
				return '';
			},
		});
	const transcriptNode = () =>
		transcriptPart({
			...kit,
			email: chat.visitor.kind === 'user' ? (chat.visitor.email ?? '') : '',
			close: () => {
				wantsTranscript = false;
				paint();
			},
			send: async (email) => {
				const answer = await call('POST', '/v1/chat/transcript', { email });
				if (!answer.ok) return failure(answer);
				wantsTranscript = false;
				say(t('chat.transcriptSent'));
				paint();
				return '';
			},
		});
	const needsContact = () =>
		chat.conversation?.contactNeeded === true ||
		(on('guest_chat') && s.guests.contactCapture === 'before_first' && isGuest() && !chat.conversation && !pendingContact);
	const wantsRating = () => {
		const c = chat.conversation;
		if (!on('ratings') || !c || c.rating || rated) return false;
		const staffTookPart = [...shown.values()].some((each) => each.message.author === 'staff');
		return (
			c.ratingRequested === true ||
			(c.status === 'resolved' &&
				(s.ratings.askWhen === 'on_resolve' || (s.ratings.askWhen === 'after_staff' && staffTookPart)))
		);
	};
	/** @returns {[string, (() => HTMLElement) | null]} */
	const partOf = () => {
		if (stopped) return ['stopped', () => element(doc, 'p', { class: 'notice' }, t('chat.unavailable'))];
		if (limit) return [`limit:${limit}:${leadSent}`, limitNode];
		if (needsContact()) return ['contact', contactNode];
		if (wantsTranscript) return ['transcript', transcriptNode];
		const flow = chat.conversation?.flow;
		if (flow?.step) return [`flow:${JSON.stringify(flow)}`, () => flowNode(flow)];
		if (wantsRating()) return ['rating', ratingNode];
		return ['', null];
	};

	/** Bring everything but the messages up to date. */
	const paint = () => {
		const c = chat.conversation;
		setHidden(box, stopped && !isOpen);
		setHidden(panel, !isOpen);
		launcher.setAttribute('aria-expanded', String(isOpen));
		welcome.textContent =
			!isGuest() || !on('guest_chat') || s.guests.messageLimit <= 0
				? t('chat.welcomeSignedIn')
				: formatText(t('chat.welcomeGuest'), { limit: s.guests.messageLimit });
		setHidden(typing, !(on('typing_receipts') && (typingPace || c?.aiPending === true)));

		/** @type {string[]} */
		const lines = [];
		if (c?.officeHours?.open === false)
			lines.push(
				c.officeHours.backAt
					? formatText(t('chat.officeClosed'), { time: when(c.officeHours.backAt) })
					: t('chat.officeAway'),
			);
		if (on('presence_queue') && s.queuePosition && typeof c?.queuePosition === 'number')
			lines.push(formatText(t('chat.queuePosition'), { position: c.queuePosition }));
		notices.replaceChildren(...lines.map((line) => element(doc, 'p', { class: 'notice' }, line)));

		const [key, build] = partOf();
		if (key !== panelKey) {
			panelKey = key;
			slot.replaceChildren(...(build ? [build()] : []));
		}
		const live = Boolean(c) && c.status !== 'resolved' && !stopped;
		setHidden(talk, !(on('handoff') && live && !c.waiting));
		setHidden(copy, !(on('transcripts') && c && !stopped));
		setHidden(end, !live);
		setHidden(composer, stopped || Boolean(limit) || (needsContact() && !c));
		const visitors = s.attachments.visitors;
		setHidden(
			attach,
			!(on('attachments') && s.attachments.storage && (visitors === 'everyone' || (visitors === 'signed_in' && !isGuest()))),
		);

		for (const each of log.querySelectorAll('.seen')) each.remove();
		const seenSeq = c?.staffSeenSeq;
		if (on('typing_receipts') && typeof seenSeq === 'number') {
			const last = [...shown.values()]
				.filter((each) => each.message.author === 'visitor' && each.message.seq <= seenSeq)
				.at(-1);
			last?.node.append(element(doc, 'span', { class: 'seen meta' }, t('chat.seen')));
		}
		void markRead();
	};

	// opening and closing
	const hideNudge = () => setHidden(nudge, true);
	const open = async () => {
		if (stopped || isOpen) return;
		isOpen = true;
		hideNudge();
		closedChecks.stop();
		paint();
		input.focus();
		if (loaded) await poll();
		else {
			loaded = true;
			await load();
		}
		needRead = needRead || (chat.conversation?.unread ?? 0) > 0;
		const flow = on('leads_flows') ? pageFlow(s.flows, win.location.pathname) : null;
		if (flow && !memory.flowStarted(flow.id) && !chat.conversation?.flow) await startFlow(flow);
		if (chat.conversation) checks.start();
		paint();
	};
	const close = () => {
		if (!isOpen) return;
		isOpen = false;
		wantsTranscript = false;
		checks.stop();
		paint();
		if (!stopped) closedChecks.start(false);
	};
	/** @param {import('./proactive.js').Kind} kind @param {string} text */
	const offer = (kind, text) => {
		if (isOpen) return false;
		if (stopped || !memory.allowed(kind)) return true;
		memory.shown(kind);
		nudgeText.textContent = text;
		setHidden(nudge, false);
		return true;
	};
	/** A page flow after its delay: started and shown like a proactive message. @param {any} flow */
	const flowNudge = async (flow) => {
		if (isOpen || stopped || !memory.allowed('flow') || memory.flowStarted(flow.id)) return;
		const messages = await startFlow(flow);
		const last = messages.filter((message) => message.author !== 'visitor').at(-1);
		if (last?.text) offer('flow', last.text);
		await loadUnread();
	};
	const stopProactive = startProactive({
		win,
		...clock,
		features: config.features,
		settings: s,
		t,
		path: win.location.pathname,
		productName: () => page()?.productName ?? null,
		offer,
		startFlow: (flow) => void flowNudge(flow),
	});
	const halt = () => {
		stopped = true;
		checks.stop();
		closedChecks.stop();
		stopProactive();
		hideNudge();
		paint();
	};

	// events
	launcher.addEventListener('click', () => (isOpen ? close() : void open()));
	closer.addEventListener('click', close);
	nudgeText.addEventListener('click', () => void open());
	nudgeClose.addEventListener('click', () => {
		memory.dismiss(s.proactive.dismissDays);
		hideNudge();
	});
	talk.addEventListener('click', async () => {
		const answer = await act('/v1/chat/handoff');
		if (!answer.ok) say(failure(answer));
	});
	end.addEventListener('click', async () => {
		const answer = await act('/v1/chat/end');
		if (!answer.ok) say(failure(answer));
	});
	copy.addEventListener('click', () => {
		wantsTranscript = true;
		paint();
	});
	composer.addEventListener('submit', async (event) => {
		event.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		sendButton.setAttribute('disabled', '');
		if (await sendMessage(text)) input.value = '';
		sendButton.removeAttribute('disabled');
	});
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			composer.requestSubmit();
		}
	});
	attach.addEventListener('click', () => file.click());
	file.addEventListener('change', async () => {
		const chosen = file.files?.[0];
		file.value = '';
		if (!chosen) return;
		const problem = fileProblem(chosen, fileTypes, maxBytes);
		if (problem) {
			say(
				problem === 'type'
					? t('chat.fileType')
					: formatText(t('chat.fileTooBig'), { size: Math.floor(maxBytes / 1_048_576) || 1 }),
			);
			return;
		}
		say(t('chat.uploading'));
		const uploaded = await uploadFile(
			(target, init) => win.fetch(target, init),
			(body) => call('POST', '/v1/chat/uploads', body),
			chosen,
		);
		if ('failed' in uploaded) return say(uploaded.failed ? failure(uploaded.failed) : t('chat.uploadFailed'));
		if (await sendMessage(input.value.trim(), uploaded.attachment)) input.value = '';
	});

	mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => void root.append(box),
	});
	paint();
	closedChecks.start();

	return Object.freeze({
		open,
		close,
		/** The visitor signed in or out: start again with the new visitor. */
		reload: async () => {
			limit = null;
			leadSent = false;
			pendingContact = null;
			if (pacer !== null) clock.cancel(pacer);
			pacer = null;
			for (const each of shown.values()) each.node.remove();
			shown.clear();
			queue.length = 0;
			lastSeq = 0;
			chat = NO_CHAT;
			if (isOpen) await load();
			else {
				loaded = false;
				paint();
				await loadUnread();
			}
		},
	});
};

/** @typedef {ReturnType<typeof mountChat>} ChatWidget */

/**
 * The launcher's chat-bubble icon.
 * @param {Document} doc
 */
const bubbleIcon = (doc) => {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = doc.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');
	const path = doc.createElementNS(ns, 'path');
	path.setAttribute('d', 'M4 4h16v12H8l-4 4z');
	svg.append(path);
	return svg;
};
