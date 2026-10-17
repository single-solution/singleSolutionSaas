/**
 * The admin widget `inbox` (permissions `inbox.read`, `inbox.reply`, `inbox.manage`): conversations newest activity
 * first, with filters (status, assigned, waiting, guest or signed in), search and unread counts; a conversation with
 * its messages (AI and staff answers formatted as the visitor sees them, earlier ones a page at a time, C8) and internal
 * notes, reply (with attachments of the staff file types and size, C12, and saved replies), notes (a timeline, or the
 * one note of a chat, C11), status, the AI in the chat (paused with why, resumed, or a chat waiting for a person handed
 * back, CH-3; by reply or manage rights as the inbox setting says, C11), assignment (with presence and Full), custom
 * field values, a Call link for the visitor's phone, Delete (asked twice), the context panel with the AI summary,
 * transcripts and rating requests; your own presence and the staff's max chats; the leads visitors left (lead capture
 * on), with Open the chat and Delete. Only parts of switched-on features show, and a part whose route answers 403
 * hides itself (only that part). A field staff are typing in is not overwritten by the checks. It checks for news with
 * the same back-off as the visitor chat. Where the widget is wide the open conversation sits beside the list; in a
 * narrow one it replaces the list until it is closed (PLAN 0.6: by the widget's own width, a container query). The
 * conversation a staff alert links to (`?conversation=<id>` in the page address) opens on start.
 * @module
 */
import { adminCall, element, formatText, mountWidget } from '@ss/app-kit/widget';
import { STAFF_ATTACHMENT_MAX_BYTES, STAFF_ATTACHMENT_TYPES } from '../core/limits.js';
import { MAX_MESSAGE_LENGTH, PAGE_MAX } from '../core/widgets.js';
import {
	attachmentNode,
	buttonOf,
	customInput,
	fieldMaker,
	fileProblem,
	formPart,
	isInvalid,
	problemCode,
	setHidden,
	settingsOf,
	textsOf,
	uploadFile,
	whenOf,
} from './common.js';
import { contextPart, leadsPart, savedReplies, staffPart } from './inbox-parts.js';
import { messageBody } from './rich.js';
import { WIDGET_CSS } from './styles.js';
import { createChecks } from './transport.js';

/**
 * @param {{ host: HTMLElement, win: Window, api: import('@ss/app-kit/widget').AdminApi,
 *   config: import('./common.js').WidgetConfig, clock: Omit<import('./transport.js').Clock, 'win'>,
 *   onUnread: (count: number) => void }} input
 */
export const mountInbox = ({ host, win, api, config, clock, onUnread }) => {
	const t = textsOf(config);
	const s = settingsOf(config);
	const when = whenOf(config, win);
	/** @param {string} feature */
	const on = (feature) => config.features.includes(feature);
	const doc = win.document;
	const make = fieldMaker(doc, 'ss-inbox');
	/** @type {Record<string, string>} */
	const statuses = {
		open: t('inbox.statusOpen'),
		awaiting_visitor: t('inbox.statusAwaiting'),
		resolved: t('inbox.statusResolved'),
	};
	/**
	 * What to tell staff when a call failed: the widget's own texts for each problem, never the server's detail.
	 * @param {import('@ss/app-kit/widget').Answer} answer
	 * @param {string} [invalid] the text of a refused value (`validation_failed`) for this action
	 */
	const failure = (answer, invalid = 'common.error') => {
		if (answer.status === 0 && !api.tickets.current()) return t('inbox.signedOut');
		if (answer.status === 403) return t('inbox.noAccess');
		const code = problemCode(answer.data);
		if (code === 'staff_full') return t('inbox.staffFull');
		if (code === 'not_found') return t('inbox.notFound');
		if (code === 'storage_not_connected') return t('inbox.storageMissing');
		if (code === 'ai_unavailable') return t('inbox.summaryUnavailable');
		if (code === 'notifications_not_connected') return t('inbox.transcriptUnavailable');
		return isInvalid(answer) ? t(invalid) : t('common.error');
	};
	const kit = { doc, t, make, api, failure };
	/** @param {any} visitor */
	const visitorName = (visitor) =>
		visitor?.name || visitor?.email || visitor?.phone || (visitor?.kind === 'user' ? t('inbox.signedIn') : t('inbox.guest'));

	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			/** @type {string | null} */
			let cursor = null;
			let pages = 0;
			/** @type {any} the open conversation */
			let current = null;
			let lastSeq = 0;
			/** @type {import('./inbox-parts.js').Staff[]} */
			let staff = [];
			/** @type {Map<string, HTMLElement>} message nodes by id */
			const shown = new Map();

			// the list
			const box = element(doc, 'section', { class: 'box inbox admin' });
			const total = element(doc, 'p', { class: 'meta total' });
			const filters = element(doc, 'form', { class: 'row' });
			const status = make.field('select', t('inbox.status'));
			status.input.append(
				element(doc, 'option', { value: '' }, t('inbox.any')),
				...Object.entries(statuses).map(([value, label]) => element(doc, 'option', { value }, label)),
			);
			const assigned = make.choose(t('inbox.assigned'), [
				{ value: 'any', label: t('inbox.any') },
				{ value: 'me', label: t('inbox.assignedMe') },
				{ value: 'unassigned', label: t('inbox.unassigned') },
			]);
			const kind = make.choose(t('inbox.visitor'), [
				{ value: '', label: t('inbox.any') },
				{ value: 'guest', label: t('inbox.guest') },
				{ value: 'user', label: t('inbox.signedIn') },
			]);
			// the merchant's tags, topics and priorities (C7)
			const labels = s.labels;
			/** @param {readonly { key: string, name: string }[]} list @param {string} key */
			const labelName = (list, key) => list.find((each) => each.key === key)?.name ?? key;
			const labelFilter = make.field('select', t('inbox.labelFilter'));
			labelFilter.input.append(
				element(doc, 'option', { value: '' }, t('inbox.any')),
				.../** @type {const} */ ([
					['tag', 'tags', 'inbox.tags'],
					['topic', 'topics', 'inbox.topic'],
					['priority', 'priorities', 'inbox.priority'],
				])
					.filter(([, list]) => labels[list].length > 0)
					.map(([member, list, text]) => {
						const group = element(doc, 'optgroup', { label: t(text) });
						group.append(
							...labels[list].map((each) => element(doc, 'option', { value: `${member}:${each.key}` }, each.name)),
						);
						return group;
					}),
			);
			const hasLabels = labels.tags.length + labels.topics.length + labels.priorities.length > 0;
			const waiting = make.flip(t('inbox.waitingOnly'));
			const q = make.field('input', t('inbox.search'), { type: 'search', maxlength: '200' });
			filters.append(
				status.wrap,
				...(on('assignment') ? [assigned.wrap] : []),
				kind.wrap,
				...(hasLabels ? [labelFilter.wrap] : []),
				q.wrap,
				waiting.wrap,
				element(doc, 'button', { type: 'submit' }, t('inbox.searchButton')),
			);
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul', { class: 'conversations' });
			const more = buttonOf(doc, t('inbox.more'), { class: 'secondary', hidden: '' });
			const detail = element(doc, 'div', { class: 'detail-part' });
			const saved = savedReplies(kit);
			const people = staffPart({
				...kit,
				queue: on('presence_queue'),
				onStaff: (items) => {
					staff = items;
					fillAssign();
				},
			});
			const leads = leadsPart({ ...kit, when, open: (id) => void show(id) });
			const listPart = element(doc, 'div', { class: 'list-part' });
			listPart.append(filters, note, list, more);
			// the list and the open conversation: side by side, or one at a time in a narrow widget
			const split = element(doc, 'div', { class: 'split' });
			split.append(listPart, detail);
			box.append(element(doc, 'h2', {}, t('inbox.title')), total, people.part, split);
			if (on('saved_replies')) box.append(saved.part);
			if (on('leads_flows')) box.append(leads.part);
			root.append(box);

			/** @param {number} count */
			const setTotal = (count) => {
				total.textContent = formatText(t('inbox.unreadTotal'), { count });
				onUnread(count);
			};
			/** @param {any} item */
			const itemNode = (item) => {
				const node = element(doc, 'li', { class: item.unread > 0 ? 'unread' : '' });
				const open = buttonOf(doc, visitorName(item.visitor), { class: 'link' });
				open.addEventListener('click', () => void show(item.id));
				node.append(open);
				if (item.unread > 0) node.append(element(doc, 'span', { class: 'badge' }, String(item.unread)));
				node.append(
					element(doc, 'span', { class: 'meta' }, item.preview ?? ''),
					element(
						doc,
						'span',
						{ class: 'meta' },
						[
							statuses[item.status] ?? item.status,
							item.waiting ? t('inbox.waiting') : '',
							item.aiPaused ? t('inbox.aiPaused') : '',
							item.assignedTo ? formatText(t('inbox.assignedTo'), { name: item.assignedTo.name }) : '',
							item.priority ? labelName(labels.priorities, item.priority) : '',
							item.topic ? labelName(labels.topics, item.topic) : '',
							...(item.tags ?? []).map((/** @type {string} */ tag) => labelName(labels.tags, tag)),
							when(item.lastMessageAt),
						]
							.filter(Boolean)
							.join(' · '),
					),
				);
				return node;
			};
			/** @param {boolean} reset */
			const load = async (reset) => {
				const query = new URLSearchParams({ limit: '25' });
				if (status.input.value) query.set('status', status.input.value);
				if (on('assignment') && assigned.input.value !== 'any') query.set('assigned', assigned.input.value);
				if (waiting.input.checked) query.set('waiting', '1');
				if (kind.input.value) query.set('visitor', kind.input.value);
				const [member = '', key = ''] = labelFilter.input.value.split(':');
				if (member && key) query.set(member, key);
				if (q.input.value.trim()) query.set('q', q.input.value.trim());
				if (!reset && cursor) query.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/conversations?${query.toString()}`);
				if (!answer.ok) {
					note.textContent = failure(answer);
					return;
				}
				/** @type {any[]} */
				const items = answer.data.items ?? [];
				if (reset) list.replaceChildren();
				pages = reset ? 1 : pages + 1;
				cursor = answer.data.hasMore ? (answer.data.nextCursor ?? null) : null;
				note.textContent = reset && items.length === 0 ? t('inbox.empty') : '';
				list.append(...items.map(itemNode));
				setHidden(more, !cursor);
				if (typeof answer.data.unread === 'number') setTotal(answer.data.unread);
			};

			// one conversation
			/** Parts a 403 hid: they stay hidden whatever the conversation shows. @type {Set<Element>} */
			const denied = new Set();
			/** @param {Element} node */
			const deny = (node) => {
				denied.add(node);
				setHidden(node, true);
			};
			/** @param {Element} node @param {boolean} visible */
			const showIf = (node, visible) => setHidden(node, !visible || denied.has(node));
			const messages = element(doc, 'ul', { class: 'log' });
			// older messages, a page at a time (C8)
			const older = buttonOf(doc, t('inbox.earlier'), { class: 'link small', hidden: '' });
			const header = element(doc, 'div', { class: 'visitor' });
			const detailNote = element(doc, 'p', { class: 'status', role: 'status' });
			const manage = element(doc, 'div', { class: 'row manage' });
			const statusPick = make.field('select', t('inbox.status'));
			statusPick.input.append(...Object.entries(statuses).map(([value, label]) => element(doc, 'option', { value }, label)));
			const assign = make.field('select', t('inbox.assign'));
			manage.append(statusPick.wrap, ...(on('assignment') ? [assign.wrap] : []));
			// the AI in this chat (C11): paused with why, resumed, or a chat waiting for a person handed back (CH-3); reply
			// or manage rights as the inbox setting says, so a 403 hides only these controls
			const aiPart = element(doc, 'div', { class: 'row ai-controls' });
			const pausedLine = element(doc, 'p', { class: 'meta' });
			const reason = make.field('input', t('inbox.pauseReason'), { maxlength: '200' });
			const pause = buttonOf(doc, t('inbox.pauseAi'), { class: 'secondary' });
			const resume = buttonOf(doc, t('inbox.resumeAi'), { class: 'secondary' });
			const handBack = buttonOf(doc, t('inbox.handBack'), { class: 'secondary' });
			aiPart.append(pausedLine, reason.wrap, pause, resume, handBack);
			const fields = (on('custom_fields') ? s.customFields : []).map((definition) => ({
				definition,
				...customInput(doc, make, t, definition),
			}));
			const fieldsForm = formPart(doc, {
				title: t('inbox.fields'),
				nodes: fields.map((field) => field.wrap),
				label: t('common.save'),
				submit: async () => {
					/** @type {Record<string, unknown>} */
					const values = {};
					for (const field of fields) values[field.definition.key] = field.read();
					const answer = await patch({ fields: values }, 'inbox.fieldsInvalid');
					if (answer.status === 403) deny(fieldsForm);
					if (answer.ok) fillFields(true);
					return answer.ok ? t('inbox.saved') : failure(answer, 'inbox.fieldsInvalid');
				},
			});
			// its tags, topic and priority (C7), from the merchant's lists
			const topicPick = make.field('select', t('inbox.topic'));
			topicPick.input.append(
				element(doc, 'option', { value: '' }, t('inbox.noLabel')),
				...labels.topics.map((each) => element(doc, 'option', { value: each.key }, each.name)),
			);
			const priorityPick = make.field('select', t('inbox.priority'));
			priorityPick.input.append(
				element(doc, 'option', { value: '' }, t('inbox.noLabel')),
				...labels.priorities.map((each) => element(doc, 'option', { value: each.key }, each.name)),
			);
			const tagChecks = labels.tags.map((each) => ({ key: each.key, ...make.check(each.name) }));
			const labelsForm = formPart(doc, {
				title: t('inbox.labels'),
				nodes: [
					...(labels.topics.length > 0 ? [topicPick.wrap] : []),
					...(labels.priorities.length > 0 ? [priorityPick.wrap] : []),
					...tagChecks.map((each) => each.wrap),
				],
				label: t('common.save'),
				submit: async () => {
					const answer = await patch(
						{
							...(labels.topics.length > 0 ? { topic: topicPick.input.value || null } : {}),
							...(labels.priorities.length > 0 ? { priority: priorityPick.input.value || null } : {}),
							...(labels.tags.length > 0
								? { tags: tagChecks.filter((each) => each.input.checked).map((each) => each.key) }
								: {}),
						},
						'inbox.labelsInvalid',
					);
					if (answer.status === 403) deny(labelsForm);
					if (answer.ok) fillLabels(true);
					return answer.ok ? t('inbox.saved') : failure(answer, 'inbox.labelsInvalid');
				},
			});
			// one note per chat, when notes are set so (C11)
			const noteText = make.field('textarea', t('inbox.note'), { rows: '3', maxlength: '4000' });
			const noteForm = formPart(doc, {
				nodes: [noteText.wrap],
				label: t('common.save'),
				submit: async () => {
					const answer = await adminCall(api, 'PUT', `${path()}/note`, { text: noteText.input.value.trim() });
					if (answer.status === 403) deny(noteForm);
					if (!answer.ok) return failure(answer, 'inbox.noteInvalid');
					current = answer.data.conversation;
					fillNote(true);
					return t('inbox.saved');
				},
			});
			const context = contextPart({ ...kit, summary: on('ai_summary') });
			const reply = /** @type {HTMLTextAreaElement} */ (
				element(doc, 'textarea', { rows: '3', maxlength: String(MAX_MESSAGE_LENGTH), 'aria-label': t('inbox.reply') })
			);
			const replyForm = element(doc, 'form', { class: 'part' });
			const send = element(doc, 'button', { type: 'submit' }, t('inbox.reply'));
			const addNote = buttonOf(doc, t('inbox.addNote'), { class: 'secondary' });
			const file = /** @type {HTMLInputElement} */ (element(doc, 'input', { type: 'file', hidden: '' }));
			const attach = buttonOf(doc, t('inbox.attach'), { class: 'secondary' });
			// what staff may send: the fixed types and size (C12)
			const types = STAFF_ATTACHMENT_TYPES;
			file.setAttribute('accept', types.join(','));
			const maxBytes = STAFF_ATTACHMENT_MAX_BYTES;
			replyForm.append(
				...(on('saved_replies') ? [saved.picker(reply)] : []),
				reply,
				send,
				...(on('internal_notes') ? [addNote] : []),
				...(on('attachments') && types.length > 0 ? [file, attach] : []),
			);
			const transcript = make.field('input', t('inbox.transcriptEmail'), { type: 'email', maxlength: '254', required: '' });
			const transcriptForm = formPart(doc, {
				nodes: [transcript.wrap],
				label: t('inbox.transcriptSend'),
				submit: async () => {
					const answer = await adminCall(api, 'POST', `${path()}/transcript`, { email: transcript.input.value.trim() });
					if (answer.status === 403) deny(transcriptForm);
					return answer.ok ? t('inbox.transcriptSent') : failure(answer, 'inbox.emailInvalid');
				},
			});
			const askRating = buttonOf(doc, t('inbox.askRating'), { class: 'secondary' });
			// for good, asked twice (C11; inbox.manage)
			const remove = buttonOf(doc, t('inbox.delete'), { class: 'secondary' });
			const closeDetail = buttonOf(doc, t('inbox.close'), { class: 'secondary' });
			const conversationPart = element(doc, 'section', { class: 'part' });
			conversationPart.append(
				header,
				manage,
				...(on('ai_replies') ? [aiPart] : []),
				older,
				messages,
				replyForm,
				...(on('internal_notes') ? [noteForm] : []),
				...(fields.length > 0 ? [fieldsForm] : []),
				...(hasLabels ? [labelsForm] : []),
				...(on('context_panel') ? [context.part] : []),
				...(on('transcripts') ? [transcriptForm] : []),
				...(on('ratings') && s.ratings.askWhen === 'manual' ? [askRating] : []),
				remove,
				closeDetail,
				detailNote,
			);

			const path = () => `/v1/admin/conversations/${encodeURIComponent(current.id)}`;
			const fillAssign = () => {
				const presence = people.presence;
				assign.input.replaceChildren(
					element(doc, 'option', { value: '' }, t('inbox.unassigned')),
					...staff.map((person) => {
						const label = [
							person.name || person.email,
							on('presence_queue') ? (presence[person.presence] ?? '') : '',
							on('presence_queue') && person.full ? t('inbox.full') : '',
						]
							.filter(Boolean)
							.join(' · ');
						return element(doc, 'option', { value: person.id }, label);
					}),
				);
				assign.input.value = current?.assignedTo?.id ?? '';
			};
			/**
			 * Put a saved value in a field, unless staff changed the field since it was filled: the checks every few seconds
			 * must not undo their typing. A newly opened conversation, or the field's own save, always fills it.
			 * @param {HTMLInputElement | HTMLTextAreaElement} input @param {() => void} fill @param {boolean} always
			 */
			const refill = (input, fill, always) => {
				const node = input;
				if (!always && node.value !== node.dataset.filled) return;
				fill();
				node.dataset.filled = node.value;
			};
			/** @param {boolean} always */
			const fillFields = (always) => {
				for (const field of fields) refill(field.input, () => field.write(current.fields?.[field.definition.key]), always);
			};
			/** @param {boolean} always */
			const fillLabels = (always) => {
				refill(topicPick.input, () => void (topicPick.input.value = current.topic ?? ''), always);
				refill(priorityPick.input, () => void (priorityPick.input.value = current.priority ?? ''), always);
				if (always) for (const each of tagChecks) each.input.checked = (current.tags ?? []).includes(each.key);
			};
			/** @param {boolean} always */
			const fillNote = (always) => {
				const input = noteText.input;
				refill(
					input,
					() => {
						input.value = typeof current.note === 'string' ? current.note : '';
					},
					always,
				);
			};
			/** The number to call: + and digits of the visitor's phone (C11), else ''. */
			const dialOf = () => {
				const digits = String(current.visitor?.phone ?? '').replace(/[^\d+]/g, '');
				return /^\+?\d{4,}$/.test(digits) ? digits : '';
			};
			/** Bring the controls up to date with `current`. */
			const sync = () => {
				const dial = dialOf();
				header.replaceChildren(
					element(doc, 'h3', {}, visitorName(current.visitor)),
					element(
						doc,
						'p',
						{ class: 'meta' },
						[
							current.visitor?.email ?? '',
							current.visitor?.phone ?? '',
							current.visitor?.kind === 'user' ? t('inbox.signedIn') : t('inbox.guest'),
							current.waiting ? t('inbox.waiting') : '',
						]
							.filter(Boolean)
							.join(' · '),
					),
					...(dial ? [element(doc, 'a', { href: `tel:${dial}`, class: 'call' }, t('inbox.call'))] : []),
				);
				statusPick.input.value = current.status;
				assign.input.value = current.assignedTo?.id ?? '';
				const paused = current.aiPaused === true;
				pausedLine.textContent = paused
					? [
							formatText(t('inbox.pausedBy'), {
								name: current.aiPausedBy?.name ?? t('inbox.staffMember'),
								time: when(current.aiPausedAt),
							}),
							current.aiPausedReason ?? '',
						]
							.filter(Boolean)
							.join(' · ')
					: '';
				setHidden(pausedLine, !paused);
				setHidden(reason.wrap, paused);
				setHidden(pause, paused);
				setHidden(resume, !paused || current.waiting);
				setHidden(handBack, !current.waiting);
				const single = typeof current.note === 'string';
				showIf(noteForm, single);
				showIf(addNote, !single);
				fillFields(false);
				fillLabels(false);
				fillNote(false);
				context.show(current);
				for (const each of messages.querySelectorAll('.seen')) each.remove();
				const seenSeq = current.visitorSeenSeq;
				if (on('typing_receipts') && typeof seenSeq === 'number') {
					const last = [...messages.querySelectorAll('li.staff:not(.note)')]
						.filter((node) => Number(/** @type {HTMLElement} */ (node).dataset.seq) <= seenSeq)
						.at(-1);
					last?.append(element(doc, 'span', { class: 'seen meta' }, t('inbox.seen')));
				}
			};
			/** @param {any} message */
			const messageNode = (message) => {
				const node = element(doc, 'li', {
					class: `msg ${message.author}${message.internal ? ' note' : ''}`,
					'data-seq': String(message.seq),
				});
				const who =
					message.author === 'visitor'
						? visitorName(current.visitor)
						: message.author === 'ai'
							? t('inbox.ai')
							: message.author === 'staff'
								? message.name || t('inbox.staffMember')
								: '';
				const line = element(doc, 'span', { class: 'who' }, who);
				if (message.internal) line.append(' ', element(doc, 'span', { class: 'tag' }, t('inbox.note')));
				node.append(line);
				if (message.text) node.append(messageBody(doc, message));
				if (message.attachment) node.append(attachmentNode(doc, message.attachment));
				node.append(element(doc, 'span', { class: 'meta' }, when(message.createdAt)));
				return node;
			};
			/** @param {any[]} items @returns {boolean} a visitor message was new */
			const addMessages = (items) => {
				let fromVisitor = false;
				for (const message of items) {
					if (shown.has(message.id)) continue;
					const node = messageNode(message);
					shown.set(message.id, node);
					messages.append(node);
					lastSeq = Math.max(lastSeq, message.seq);
					if (message.author === 'visitor') fromVisitor = true;
				}
				return fromVisitor;
			};
			const markRead = async () => {
				const answer = await adminCall(api, 'POST', `${path()}/read`);
				if (answer.ok) await load(true);
			};
			/** @param {string} id */
			const show = async (id) => {
				const answer = await adminCall(api, 'GET', `/v1/admin/conversations/${encodeURIComponent(id)}`);
				if (!answer.ok) {
					note.textContent = failure(answer);
					return;
				}
				current = answer.data.conversation;
				lastSeq = 0;
				shown.clear();
				messages.replaceChildren();
				detailNote.textContent = '';
				transcript.input.value = current.visitor?.email ?? '';
				reason.input.value = '';
				remove.textContent = t('inbox.delete');
				delete remove.dataset.sure;
				addMessages(answer.data.messages ?? []);
				setHidden(older, answer.data.earlier !== true);
				fillFields(true);
				fillLabels(true);
				fillNote(true);
				sync();
				detail.replaceChildren(conversationPart);
				split.classList.add('open');
				await markRead();
			};
			const refresh = async () => {
				if (!current) return;
				const answer = await adminCall(api, 'GET', `${path()}?after=${lastSeq}`);
				if (!answer.ok) return;
				current = answer.data.conversation;
				const fresh = addMessages(answer.data.messages ?? []);
				sync();
				if (fresh && !doc.hidden) await markRead();
			};
			const closeConversation = () => {
				current = null;
				detail.replaceChildren();
				split.classList.remove('open');
			};
			/** @param {Record<string, unknown>} body @param {string} [invalid] the text of a refused value */
			const patch = async (body, invalid) => {
				const answer = await adminCall(api, 'PATCH', path(), body);
				if (answer.ok) current = answer.data.conversation;
				if (answer.status === 403) deny(manage);
				sync();
				detailNote.textContent = answer.ok ? t('inbox.saved') : failure(answer, invalid);
				if (answer.ok) await load(true);
				return answer;
			};
			/** Pause the AI with the reason typed, or resume it (C11). @param {boolean} paused */
			const setAi = async (paused) => {
				const why = reason.input.value.trim();
				const answer = await adminCall(api, 'PUT', `${path()}/ai`, paused && why ? { paused, reason: why } : { paused });
				if (answer.ok) {
					current = answer.data.conversation;
					reason.input.value = '';
				}
				if (answer.status === 403) deny(aiPart);
				sync();
				detailNote.textContent = answer.ok ? t('inbox.saved') : failure(answer);
				if (answer.ok) await load(true);
			};
			/** @param {'messages' | 'notes'} kindOf @param {Record<string, unknown>} body */
			const post = async (kindOf, body) => {
				const answer = await adminCall(api, 'POST', `${path()}/${kindOf}`, body);
				if (answer.ok) {
					addMessages([answer.data.message]);
					reply.value = '';
					sync();
					detailNote.textContent = '';
				} else {
					if (answer.status === 403) deny(kindOf === 'notes' ? addNote : replyForm);
					detailNote.textContent = failure(answer, kindOf === 'notes' ? 'inbox.noteInvalid' : 'inbox.replyInvalid');
				}
				return answer;
			};

			statusPick.input.addEventListener('change', () => void patch({ status: statusPick.input.value }));
			pause.addEventListener('click', () => void setAi(true));
			resume.addEventListener('click', () => void setAi(false));
			handBack.addEventListener('click', () => void setAi(false));
			assign.input.addEventListener(
				'change',
				() => void patch({ assignedTo: assign.input.value || null }, 'inbox.assignInvalid'),
			);
			older.addEventListener('click', async () => {
				const first = /** @type {HTMLElement | null} */ (messages.querySelector('li.msg'));
				if (!first) return;
				const answer = await adminCall(api, 'GET', `${path()}?before=${first.dataset.seq}&limit=${PAGE_MAX}`);
				if (!answer.ok) {
					detailNote.textContent = failure(answer);
					return;
				}
				for (const message of answer.data.messages ?? []) {
					if (shown.has(message.id)) continue;
					const node = messageNode(message);
					shown.set(message.id, node);
					messages.insertBefore(node, first);
				}
				setHidden(older, answer.data.earlier !== true);
				sync();
			});
			replyForm.addEventListener('submit', async (event) => {
				event.preventDefault();
				if (reply.value.trim()) await post('messages', { text: reply.value.trim() });
			});
			addNote.addEventListener('click', async () => {
				if (reply.value.trim()) await post('notes', { text: reply.value.trim() });
			});
			attach.addEventListener('click', () => file.click());
			file.addEventListener('change', async () => {
				const chosen = file.files?.[0];
				file.value = '';
				if (!chosen) return;
				const problem = fileProblem(chosen, types, maxBytes);
				if (problem) {
					detailNote.textContent =
						problem === 'type'
							? t('inbox.fileType')
							: formatText(t('inbox.fileTooBig'), { size: Math.floor(maxBytes / 1_048_576) || 1 });
					return;
				}
				detailNote.textContent = t('inbox.uploading');
				const uploaded = await uploadFile(
					(target, init) => win.fetch(target, init),
					(body) => adminCall(api, 'POST', '/v1/admin/uploads', body),
					chosen,
				);
				if ('failed' in uploaded) {
					detailNote.textContent = uploaded.failed ? failure(uploaded.failed, 'inbox.fileInvalid') : t('inbox.uploadFailed');
					return;
				}
				await post('messages', { text: reply.value.trim(), attachment: uploaded.attachment });
			});
			askRating.addEventListener('click', async () => {
				const answer = await adminCall(api, 'POST', `${path()}/rating-request`);
				if (answer.status === 403) deny(askRating);
				detailNote.textContent = answer.ok ? t('inbox.ratingAsked') : failure(answer);
			});
			remove.addEventListener('click', async () => {
				if (remove.dataset.sure !== '1') {
					remove.dataset.sure = '1';
					remove.textContent = t('inbox.confirmDelete');
					return;
				}
				const answer = await adminCall(api, 'DELETE', path());
				if (!answer.ok) {
					if (answer.status === 403) deny(remove);
					detailNote.textContent = failure(answer);
					return;
				}
				closeConversation();
				await load(true);
				note.textContent = t('inbox.deleted');
			});
			closeDetail.addEventListener('click', closeConversation);
			filters.addEventListener('submit', (event) => {
				event.preventDefault();
				void load(true);
			});
			more.addEventListener('click', () => void load(false));

			const checks = createChecks({
				win,
				...clock,
				check: async () => {
					if (pages <= 1) await load(true);
					await refresh();
				},
			});
			const off = api.tickets.onChange((signedIn) => {
				if (signedIn) return;
				list.replaceChildren();
				detail.replaceChildren();
				split.classList.remove('open');
				current = null;
				setHidden(more, true);
				note.textContent = t('inbox.signedOut');
			});
			void (async () => {
				if (on('assignment') || on('presence_queue')) await people.load();
				if (on('saved_replies')) await saved.load();
				if (on('leads_flows')) await leads.load(true);
				await load(true);
				// a staff alert links to the inbox page with ?conversation=<id> (the setting adminUrl): open it
				const linked = new URLSearchParams(win.location.search).get('conversation');
				if (linked) await show(linked);
				checks.start();
			})();
			return () => {
				checks.stop();
				off();
			};
		},
	});
};
