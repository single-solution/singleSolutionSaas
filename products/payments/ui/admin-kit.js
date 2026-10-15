/**
 * What Payments' admin widgets share besides the kit's admin blocks (`@ss/app-kit/widget`: badges, dots, value grids,
 * list and detail, the More menu, dialogs): a labeled form control and a small section of the detail. Text is always
 * set as text, never as HTML.
 * @module
 */
import { element } from '@ss/app-kit/widget';

/**
 * A labeled form control.
 * @param {Document} doc @param {string} label @param {HTMLElement} control
 */
export const field = (doc, label, control) => {
	const node = element(doc, 'label', {}, label);
	node.append(control);
	return node;
};

/**
 * A section of the detail: a small heading and its items (nothing when there are none).
 * @param {Document} doc @param {string} title @param {string[]} items
 */
export const listSection = (doc, title, items) => {
	if (items.length === 0) return null;
	const section = element(doc, 'section', { class: 'sub' });
	const list = element(doc, 'ul', { class: 'plain' });
	list.append(...items.map((text) => element(doc, 'li', {}, text)));
	section.append(element(doc, 'h4', {}, title), list);
	return section;
};
