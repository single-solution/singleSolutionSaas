/**
 * Parts of the inbox widget that stand on their own: saved replies (picker and editor), the staff list with presence
 * and max chats, and the conversation's context panel. A part whose route answers 403 hides itself.
 * @module
 */
import { formatText } from '@ss/app-kit/widget';
import { buttonOf, formPart, setHidden, webAddress } from './common.js';
import { element } from './dom.js';
import { adminCall } from './tickets.js';

/**
 * @typedef {object} PartKit
 * @property {Document} doc
 * @property {import('./common.js').Texts} t
 * @property {import('./common.js').FieldMaker} make
 * @property {import('./tickets.js').AdminApi} api
 * @property {(answer: import('./common.js').Answer) => string} failure
 */

/** @typedef {{ id: string, title: string, text: string }} SavedReply */

/**
 * Saved replies: an editor (add, change, delete) and pickers that insert a reply into a text box.
 * @param {PartKit} kit
 */
export const savedReplies = ({ doc, t, make, api, failure }) => {
	/** @type {SavedReply[]} */
	let items = [];
	/** @type {SavedReply | null} */
	let editing = null;
	/** @type {Set<() => void>} */
	const pickers = new Set();
	const part = element(doc, 'section', { class: 'part', hidden: '' });
	const list = element(doc, 'ul');
	const title = make.field('input', t('inbox.savedTitle'), { maxlength: '120', required: '' });
	const text = make.field('textarea', t('inbox.savedText'), { rows: '3', maxlength: '4000', required: '' });
	const form = formPart(doc, {
		nodes: [title.wrap, text.wrap],
		label: t('inbox.savedSave'),
		submit: async () => {
			const body = { title: title.input.value.trim(), text: text.input.value.trim() };
			const answer = editing
				? await adminCall(api, 'PUT', `/v1/admin/saved-replies/${encodeURIComponent(editing.id)}`, body)
				: await adminCall(api, 'POST', '/v1/admin/saved-replies', body);
			if (!answer.ok) return failure(answer);
			editing = null;
			/** @type {HTMLFormElement} */ (form).reset();
			await load();
			return t('inbox.saved');
		},
	});
	part.append(element(doc, 'h3', {}, t('inbox.savedReplies')), list, form);

	const render = () => {
		list.replaceChildren(
			...items.map((item) => {
				const row = element(doc, 'li', {}, item.title);
				const edit = buttonOf(doc, t('common.edit'), { class: 'secondary small' });
				const remove = buttonOf(doc, t('common.delete'), { class: 'secondary small' });
				edit.addEventListener('click', () => {
					editing = item;
					title.input.value = item.title;
					text.input.value = item.text;
				});
				remove.addEventListener('click', async () => {
					const answer = await adminCall(api, 'DELETE', `/v1/admin/saved-replies/${encodeURIComponent(item.id)}`);
					if (answer.ok) await load();
					else list.append(element(doc, 'li', { class: 'status' }, failure(answer)));
				});
				row.append(element(doc, 'span', { class: 'meta' }, item.text), edit, remove);
				return row;
			}),
		);
		for (const picker of pickers) picker();
	};
	const load = async () => {
		const answer = await adminCall(api, 'GET', '/v1/admin/saved-replies');
		if (!answer.ok) return;
		items = Array.isArray(answer.data?.items) ? answer.data.items : [];
		setHidden(part, false);
		render();
	};

	return {
		part,
		load,
		/**
		 * A select that puts the chosen reply into the text box.
		 * @param {HTMLTextAreaElement} target
		 */
		picker: (target) => {
			const area = target;
			const select = /** @type {HTMLSelectElement} */ (element(doc, 'select', { 'aria-label': t('inbox.savedPick') }));
			const fill = () => {
				select.replaceChildren(
					element(doc, 'option', { value: '' }, t('inbox.savedPick')),
					...items.map((item) => element(doc, 'option', { value: item.id }, item.title)),
				);
				setHidden(select, items.length === 0);
			};
			select.addEventListener('change', () => {
				const chosen = items.find((item) => item.id === select.value);
				if (chosen) area.value = area.value ? `${area.value} ${chosen.text}` : chosen.text;
				select.value = '';
			});
			pickers.add(fill);
			fill();
			return select;
		},
	};
};

/**
 * @typedef {object} Staff
 * @property {string} id
 * @property {string} name
 * @property {string} email
 * @property {'online' | 'away' | 'offline'} presence
 * @property {number | null} maxChats
 * @property {number} open
 * @property {boolean} full
 * @property {boolean} [me]
 */

/**
 * The staff list: your own presence (presence_queue), and each person's presence and max chats.
 * @param {PartKit & { queue: boolean, onStaff: (staff: Staff[]) => void }} input `queue`: presence_queue is on
 */
export const staffPart = ({ doc, t, make, api, failure, queue, onStaff }) => {
	/** @type {Record<string, string>} */
	const presence = { online: t('inbox.online'), away: t('inbox.away'), offline: t('inbox.offline') };
	const part = element(doc, 'section', { class: 'part', hidden: '' });
	const mine = make.field('select', t('inbox.myPresence'));
	mine.input.append(
		element(doc, 'option', { value: '' }, t('inbox.presenceUnknown')),
		...Object.entries(presence).map(([value, label]) => element(doc, 'option', { value }, label)),
	);
	const note = element(doc, 'p', { class: 'status', role: 'status' });
	const list = element(doc, 'ul');
	part.append(mine.wrap, element(doc, 'h3', {}, t('inbox.staff')), list, note);
	mine.input.addEventListener('change', async () => {
		if (!mine.input.value) return;
		const answer = await adminCall(api, 'PUT', '/v1/admin/staff/me/presence', { presence: mine.input.value });
		note.textContent = answer.ok ? t('inbox.presenceSaved') : failure(answer);
	});

	/** @param {Staff} person */
	const row = (person) => {
		const item = element(doc, 'li', {}, person.name || person.email);
		item.append(
			element(
				doc,
				'span',
				{ class: 'meta' },
				[
					presence[person.presence] ?? '',
					formatText(t('inbox.openChats'), { count: person.open }),
					person.full ? t('inbox.full') : '',
				]
					.filter(Boolean)
					.join(' · '),
			),
		);
		const max = make.field('input', t('inbox.maxChats'), { type: 'number', min: '1', max: '200' });
		max.input.value = person.maxChats === null ? '' : String(person.maxChats);
		const save = formPart(doc, {
			nodes: [max.wrap],
			label: t('common.save'),
			submit: async () => {
				const value = max.input.value.trim();
				const answer = await adminCall(api, 'PATCH', `/v1/admin/staff/${encodeURIComponent(person.id)}`, {
					maxChats: value === '' ? null : Number(value),
				});
				if (answer.status === 403) setHidden(save, true);
				return answer.ok ? t('inbox.saved') : failure(answer);
			},
		});
		item.append(save);
		return item;
	};

	const load = async () => {
		const answer = await adminCall(api, 'GET', '/v1/admin/staff');
		/** @type {Staff[]} */
		const staff = answer.ok && Array.isArray(answer.data?.items) ? answer.data.items : [];
		onStaff(staff);
		if (!answer.ok || !queue) return;
		const me = staff.find((person) => person.me);
		if (me && !mine.input.value) mine.input.value = me.presence;
		list.replaceChildren(...staff.map(row));
		setHidden(part, false);
	};
	return { part, load, presence };
};

/**
 * The context panel: the visitor, the page the chat started on, the device, their conversations, then the shop info of
 * a signed-in visitor (last orders with status and total, and loyalty points; with the Ecommerce token), the AI
 * summary (with Summarise when ai_summary is on) and the rating.
 * @param {PartKit & { summary: boolean }} input
 */
export const contextPart = ({ doc, t, api, failure, summary }) => {
	const part = element(doc, 'section', { class: 'part' });
	const facts = element(doc, 'ul', { class: 'facts' });
	const shopTitle = element(doc, 'h3', {}, t('inbox.orders'));
	const shop = element(doc, 'ul', { class: 'facts shop' });
	const text = element(doc, 'p', { class: 'summary' });
	const summarise = buttonOf(doc, t('inbox.summarise'), { class: 'secondary small' });
	const note = element(doc, 'p', { class: 'status', role: 'status' });
	part.append(element(doc, 'h3', {}, t('inbox.context')), facts, shopTitle, shop, text, ...(summary ? [summarise] : []), note);
	/** @type {string} */
	let id = '';
	summarise.addEventListener('click', async () => {
		summarise.setAttribute('disabled', '');
		const answer = await adminCall(api, 'POST', `/v1/admin/conversations/${encodeURIComponent(id)}/summary`);
		summarise.removeAttribute('disabled');
		if (answer.ok) text.textContent = String(answer.data?.summary ?? '');
		else if (answer.status === 403) setHidden(summarise, true);
		else note.textContent = failure(answer);
	});

	/** @param {any} conversation */
	const show = (conversation) => {
		id = conversation.id;
		const context = conversation.context ?? {};
		/** @type {Array<string | Node>} */
		const lines = [context.name, context.email, context.phone, context.device].filter(
			(value) => typeof value === 'string' && value !== '',
		);
		const page = context.page;
		const address = webAddress(page?.url);
		if (address) {
			const link = element(doc, 'a', { href: address, target: '_blank', rel: 'noopener noreferrer' }, page.title || address);
			lines.push(link);
		}
		if (page?.productName) lines.push(formatText(t('inbox.product'), { product: page.productName }));
		if (typeof context.conversations === 'number')
			lines.push(formatText(t('inbox.conversations'), { count: context.conversations }));
		if (conversation.rating)
			lines.push(
				[formatText(t('inbox.rating'), { score: conversation.rating.score }), conversation.rating.comment ?? '']
					.filter(Boolean)
					.join(' · '),
			);
		facts.replaceChildren(
			...lines.map((line) => {
				const item = element(doc, 'li');
				item.append(line);
				return item;
			}),
		);
		const info = context.shop;
		setHidden(shopTitle, !info);
		setHidden(shop, !info);
		/** @type {string[]} */
		const orders = info
			? [
					...(info.orders.length > 0
						? info.orders.map((/** @type {any} */ order) =>
								formatText(t('inbox.order'), { number: order.number, status: order.status, total: order.total }),
							)
						: [t('inbox.noOrders')]),
					...(typeof info.loyaltyPoints === 'number'
						? [formatText(t('inbox.loyaltyPoints'), { points: info.loyaltyPoints })]
						: []),
				]
			: [];
		shop.replaceChildren(...orders.map((line) => element(doc, 'li', {}, line)));
		text.textContent = conversation.summary ?? '';
	};
	return { part, show };
};
