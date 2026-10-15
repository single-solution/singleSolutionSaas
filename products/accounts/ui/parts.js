/**
 * Building blocks of Accounts' admin widgets beside the kit's (`@ss/app-kit/widget` dialogs, More menu and status
 * badges; PLAN 0.6, 0.8.10): filter chips that carry counts, detail cards laid out as a masonry and a copy button.
 * Every text is set as text, never as HTML.
 * @module
 */
import { element } from '@ss/app-kit/widget';

/**
 * Filter chips, each with its count; the picked one is pressed.
 * @param {Document} doc
 * @param {Array<{ value: string, label: string }>} options
 * @param {(value: string) => void} onPick
 */
export const chips = (doc, options, onPick) => {
	const group = element(doc, 'div', { class: 'chips', role: 'group' });
	/** @type {Map<string, { button: HTMLElement, count: HTMLElement }>} */
	const byValue = new Map();
	for (const option of options) {
		const button = element(doc, 'button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, option.label);
		const count = element(doc, 'span', { class: 'count' }, '');
		button.append(count);
		button.addEventListener('click', () => onPick(option.value));
		byValue.set(option.value, { button, count });
		group.append(button);
	}
	return {
		group,
		/** @param {string} value */
		pick: (value) => {
			for (const [key, { button }] of byValue) button.setAttribute('aria-pressed', String(key === value));
		},
		/** @param {Record<string, number | null>} counts */
		counts: (counts) => {
			for (const [key, { count }] of byValue)
				count.textContent = counts[key] === undefined || counts[key] === null ? '' : String(counts[key]);
		},
	};
};

/**
 * A detail card: a title and label–value rows (empty values are left out); cards sit in a masonry.
 * @param {Document} doc
 * @param {string} title
 * @param {Array<[string, string | Node]>} rows
 */
export const card = (doc, title, rows) => {
	const shown = rows.filter(([, value]) => value !== '');
	const section = element(doc, 'section', { class: 'card' });
	section.append(element(doc, 'h4', {}, title));
	const list = element(doc, 'dl');
	for (const [label, value] of shown) {
		const dd = element(doc, 'dd');
		dd.append(value);
		list.append(element(doc, 'dt', {}, label), dd);
	}
	section.append(list);
	return section;
};

/**
 * A value to hand over (a code or a link) with a Copy button.
 * @param {Document} doc
 * @param {string} value
 * @param {{ copy: string, copied: string }} texts
 * @param {{ clipboard?: { writeText(text: string): Promise<void> } } | undefined} navigator
 */
export const copyable = (doc, value, texts, navigator) => {
	const wrap = element(doc, 'div', { class: 'copy' });
	const shown = element(doc, 'p', { class: 'code big' }, value);
	const button = element(doc, 'button', { type: 'button', class: 'secondary small' }, texts.copy);
	button.addEventListener('click', async () => {
		try {
			await navigator?.clipboard?.writeText(value);
			button.textContent = texts.copied;
		} catch {
			button.textContent = texts.copy;
		}
	});
	wrap.append(shown, button);
	return wrap;
};
