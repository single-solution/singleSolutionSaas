/**
 * The time picker of a booking product (feature `bookings`, PLAN 0.8.8: simple slots, no double booking): the free
 * slots of the next days from `GET /v1/shop/slots`, grouped by day in the business's time zone, and a button for the
 * following days. The chosen slot's start goes into the cart line.
 * @module
 */
import { button, h } from './shop-common.js';

/** @typedef {import('./shop-common.js').Texts} Texts */
/** @typedef {import('./widget.js').Shop} Shop */

/** Days read at once. */
const SLOT_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * @param {string} iso
 * @param {Intl.DateTimeFormatOptions} options
 * @param {string} timeZone
 */
const format = (iso, options, timeZone) => {
	try {
		return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(iso));
	} catch {
		return new Intl.DateTimeFormat(undefined, options).format(new Date(iso));
	}
};

/**
 * Fill `box` with the slot picker.
 * @param {{ box: HTMLElement, t: Texts, shop: Shop, productId: string, now: () => number,
 *   onChoose: (slot: string | null) => void }} input `onChoose` gets the chosen slot's start (ISO 8601) or null
 */
export const renderSlots = ({ box, t, shop, productId, now, onChoose }) => {
	const doc = /** @type {Document} */ (box.ownerDocument);
	const picker = /** @type {HTMLSelectElement} */ (h(doc, 'select', { id: 'ss-page-slot' }));
	const status = h(doc, 'p', { class: 'status', role: 'status' });
	const later = button(doc, t('page.laterSlots'), () => void load(), { class: 'secondary' });
	box.append(h(doc, 'label', { for: 'ss-page-slot' }, t('page.slot')), picker, later, status);
	let from = now();
	/** @type {string[]} */
	let shown = [];

	picker.addEventListener('change', () => onChoose(picker.value || null));

	const load = async () => {
		const to = from + SLOT_DAYS * DAY_MS;
		const query = new URLSearchParams({
			productId,
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
		});
		later.setAttribute('disabled', '');
		const answer = await shop.call(`/v1/shop/slots?${query}`);
		later.removeAttribute('disabled');
		if (!answer.ok) {
			status.textContent = t('page.slotsError');
			return;
		}
		from = to;
		const timeZone = String(answer.data.timeZone || 'UTC');
		/** @type {Map<string, HTMLElement>} */
		const days = new Map();
		for (const slot of /** @type {Array<{ start: string, end: string }>} */ (answer.data.slots)) {
			if (shown.includes(slot.start)) continue;
			shown = [...shown, slot.start];
			const day = format(slot.start, { dateStyle: 'full' }, timeZone);
			const group = days.get(day) ?? h(doc, 'optgroup', { label: day });
			days.set(day, group);
			group.append(
				h(
					doc,
					'option',
					{ value: slot.start },
					t('page.slotTime', {
						start: format(slot.start, { timeStyle: 'short' }, timeZone),
						end: format(slot.end, { timeStyle: 'short' }, timeZone),
					}),
				),
			);
		}
		if (picker.options.length === 0) picker.append(h(doc, 'option', { value: '' }, t('page.chooseSlot')));
		picker.append(...days.values());
		status.textContent = shown.length === 0 ? t('page.noSlots') : days.size === 0 ? t('page.noMoreSlots') : '';
	};

	void load();
};
