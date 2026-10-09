/**
 * The admin widget `inbox` (permissions `inbox.read`, `inbox.reply`, `inbox.manage`): conversations newest activity
 * first, with filters (status, assigned, waiting, guest or signed in), search and unread counts; a conversation with
 * its messages and internal notes, reply (with attachments and saved replies), notes, status, AI paused, assignment
 * (with presence and Full), custom field values, the context panel with the AI summary, transcripts and rating
 * requests; your own presence and the staff's max chats. Only parts of switched-on features show, and a part whose
 * route answers 403 hides itself. It checks for news with the same back-off as the visitor chat. Where the widget is
 * wide the open conversation sits beside the list; in a narrow one it replaces the list until it is closed (PLAN 0.6:
 * by the widget's own width, a container query).
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_MESSAGE_LENGTH } from '../core/widgets.js';
import {
	attachmentNode,
	buttonOf,
	customInput,
	fieldMaker,
	fileProblem,
	formPart,
	invalidText,
	problemCode,
	setHidden,
	settingsOf,
	textsOf,
	uploadFile,
	when,
} from './common.js';
import { element } from './dom.js';
import { contextPart, savedReplies, staffPart } from './inbox-parts.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';
import { createChecks } from './transport.js';

/**
 * @param {{ host: HTMLElement, win: Window, api: import('./tickets.js').AdminApi,
 *   config: import('./common.js').WidgetConfig, clock: Omit<import('./transport.js').Clock, 'win'>,
 *   onUnread: (count: number) => void }} input
 */
export const mountInbox = ({ host, win, api, config, clock, onUnread }) => {
	const t = textsOf(config);
	const s = settingsOf(config);
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
	/** @param {import('./common.js').Answer} answer */
	const failure = (answer) => {
		if (answer.status === 0 && !api.tickets.current()) return t('inbox.signedOut');
		if (answer.status === 403) return t('inbox.noAccess');
		if (problemCode(answer.data) === 'staff_full') return t('inbox.staffFull');
		return invalidText(answer) || t('common.error');
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
			const box = element(doc, 'section', { class: 'box inbox' });
			const total = element(doc, 'p', { class: 'meta total' });
			const filters = element(doc, 'form', { class: 'row' });
			const status = make.field('select', t('inbox.status'));
			status.input.append(
				element(doc, 'option', { value: '' }, t('inbox.any')),
				...Object.entries(statuses).map(([value, label]) => element(doc, 'option', { value }, label)),
			);
			const assigned = make.field('select', t('inbox.assigned'));
			assigned.input.append(
				element(doc, 'option', { value: 'any' }, t('inbox.any')),
				element(doc, 'option', { value: 'me' }, t('inbox.assignedMe')),
				element(doc, 'option', { value: 'unassigned' }, t('inbox.unassigned')),
			);
			const kind = make.field('select', t('inbox.visitor'));
			kind.input.append(
				element(doc, 'option', { value: '' }, t('inbox.any')),
				element(doc, 'option', { value: 'guest' }, t('inbox.guest')),
				element(doc, 'option', { value: 'user' }, t('inbox.signedIn')),
			);
			const waiting = make.check(t('inbox.waitingOnly'));
			const q = make.field('input', t('inbox.search'), { type: 'search', maxlength: '200' });
			filters.append(
				status.wrap,
				...(on('assignment') ? [assigned.wrap] : []),
				kind.wrap,
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
			const listPart = element(doc, 'div', { class: 'list-part' });
			listPart.append(filters, note, list, more);
			// the list and the open conversation: side by side, or one at a time in a narrow widget
			const split = element(doc, 'div', { class: 'split' });
			split.append(listPart, detail);
			box.append(element(doc, 'h2', {}, t('inbox.title')), total, people.part, split);
			if (on('saved_replies')) box.append(saved.part);
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
			const messages = element(doc, 'ul', { class: 'log' });
			const header = element(doc, 'div', { class: 'visitor' });
			const detailNote = element(doc, 'p', { class: 'status', role: 'status' });
			const manage = element(doc, 'div', { class: 'row manage' });
			const statusPick = make.field('select', t('inbox.status'));
			statusPick.input.append(...Object.entries(statuses).map(([value, label]) => element(doc, 'option', { value }, label)));
			const paused = make.check(t('inbox.pauseAi'));
			const assign = make.field('select', t('inbox.assign'));
			manage.append(statusPick.wrap, paused.wrap, ...(on('assignment') ? [assign.wrap] : []));
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
					const answer = await patch({ fields: values });
					if (answer.status === 403) setHidden(fieldsForm, true);
					return answer.ok ? t('inbox.saved') : failure(answer);
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
			const fileTypes = s.attachments.types.filter((type) => ATTACHMENT_TYPES.includes(type));
			const types = fileTypes.length > 0 ? fileTypes : [...ATTACHMENT_TYPES];
			file.setAttribute('accept', types.join(','));
			const maxBytes = Math.min(s.attachments.maxBytes || MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES);
			replyForm.append(
				...(on('saved_replies') ? [saved.picker(reply)] : []),
				reply,
				send,
				...(on('internal_notes') ? [addNote] : []),
				...(on('attachments') ? [file, attach] : []),
			);
			const transcript = make.field('input', t('inbox.transcriptEmail'), { type: 'email', maxlength: '254', required: '' });
			const transcriptForm = formPart(doc, {
				nodes: [transcript.wrap],
				label: t('inbox.transcriptSend'),
				submit: async () => {
					const answer = await adminCall(api, 'POST', `${path()}/transcript`, { email: transcript.input.value.trim() });
					if (answer.status === 403) setHidden(transcriptForm, true);
					if (answer.ok) return t('inbox.transcriptSent');
					return problemCode(answer.data) === 'notifications_not_connected'
						? t('inbox.transcriptUnavailable')
						: failure(answer);
				},
			});
			const askRating = buttonOf(doc, t('inbox.askRating'), { class: 'secondary' });
			const closeDetail = buttonOf(doc, t('inbox.close'), { class: 'secondary' });
			const conversationPart = element(doc, 'section', { class: 'part' });
			conversationPart.append(
				header,
				manage,
				messages,
				replyForm,
				...(fields.length > 0 ? [fieldsForm] : []),
				...(on('context_panel') ? [context.part] : []),
				...(on('transcripts') ? [transcriptForm] : []),
				...(on('ratings') && s.ratings.askWhen === 'manual' ? [askRating] : []),
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
			/** Bring the controls up to date with `current`. */
			const sync = () => {
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
				);
				statusPick.input.value = current.status;
				paused.input.checked = Boolean(current.aiPaused);
				assign.input.value = current.assignedTo?.id ?? '';
				for (const field of fields) field.write(current.fields?.[field.definition.key]);
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
				if (message.text) node.append(element(doc, 'p', {}, message.text));
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
				addMessages(answer.data.messages ?? []);
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
			/** @param {Record<string, unknown>} body */
			const patch = async (body) => {
				const answer = await adminCall(api, 'PATCH', path(), body);
				if (answer.ok) current = answer.data.conversation;
				if (answer.status === 403) setHidden(manage, true);
				sync();
				detailNote.textContent = answer.ok ? t('inbox.saved') : failure(answer);
				if (answer.ok) await load(true);
				return answer;
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
					if (answer.status === 403) setHidden(kindOf === 'notes' ? addNote : replyForm, true);
					detailNote.textContent = failure(answer);
				}
				return answer;
			};

			statusPick.input.addEventListener('change', () => void patch({ status: statusPick.input.value }));
			paused.input.addEventListener('change', () => void patch({ aiPaused: paused.input.checked }));
			assign.input.addEventListener('change', () => void patch({ assignedTo: assign.input.value || null }));
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
					detailNote.textContent = uploaded.failed ? failure(uploaded.failed) : t('inbox.uploadFailed');
					return;
				}
				await post('messages', { text: reply.value.trim(), attachment: uploaded.attachment });
			});
			askRating.addEventListener('click', async () => {
				const answer = await adminCall(api, 'POST', `${path()}/rating-request`);
				if (answer.status === 403) setHidden(askRating, true);
				detailNote.textContent = answer.ok ? t('inbox.ratingAsked') : failure(answer);
			});
			closeDetail.addEventListener('click', () => {
				current = null;
				detail.replaceChildren();
				split.classList.remove('open');
			});
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
				await load(true);
				checks.start();
			})();
			return () => {
				checks.stop();
				off();
			};
		},
	});
};
