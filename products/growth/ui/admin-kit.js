/**
 * What Growth's admin widgets share besides the kit's blocks (`@ss/app-kit/widget`: the More menu, dialogs and fact
 * grids): filter chips with counts, ranked lists with share bars, and the texts of refused calls. Text is always set
 * as text, never as HTML.
 * @module
 */
import { element } from '@ss/app-kit/widget';

/** The widget texts of the problem codes any admin widget may get. */
export const PROBLEM_TEXTS = Object.freeze({
	forbidden: 'problem.forbidden',
	feature_off: 'problem.feature_off',
	database_not_connected: 'problem.database_not_connected',
	product_unavailable: 'problem.product_unavailable',
	rate_limited: 'problem.rate_limited',
});

/**
 * The widget text of a refused call (PLAN 0.4.10: never the server's English detail, OT-4): the text of the field a
 * `validation_failed` problem names (`validation_failed:<field>`), else of its code, else `fallback`.
 * @param {{ data?: any }} answer
 * @param {Readonly<Record<string, string>>} keys text keys by problem code and by `validation_failed:<field>`
 * @param {string} fallback
 * @returns {string} a text key
 */
export const problemKey = (answer, keys, fallback) => {
	const type = typeof answer.data?.type === 'string' ? answer.data.type : '';
	const code = type.slice(type.lastIndexOf('/') + 1);
	const field = `${code}:${String(answer.data?.errors?.[0]?.path ?? '').slice(1)}`;
	const found = [field, code].find((name) => name !== '' && Object.hasOwn(keys, name));
	return found === undefined ? fallback : /** @type {string} */ (keys[found]);
};

/**
 * Filter chips: one pressed at a time, each with its count; `onPick` gets the chip's value.
 * @param {Document} doc @param {string} label the group's accessible name
 * @param {Array<{ value: string, label: string, count?: number | null }>} chips
 * @param {string} picked @param {(value: string) => void} onPick
 */
export const chipGroup = (doc, label, chips, picked, onPick) => {
	const group = element(doc, 'div', { class: 'chips', role: 'group', 'aria-label': label });
	for (const chip of chips) {
		const node = element(doc, 'button', {
			type: 'button',
			class: 'chip',
			'aria-pressed': String(chip.value === picked),
			'data-value': chip.value,
		});
		node.append(chip.label);
		if (chip.count !== undefined && chip.count !== null)
			node.append(element(doc, 'span', { class: 'count' }, String(chip.count)));
		node.addEventListener('click', () => {
			for (const other of group.querySelectorAll('.chip')) other.setAttribute('aria-pressed', String(other === node));
			onPick(chip.value);
		});
		group.append(node);
	}
	return group;
};

/**
 * A ranked list: each row's name and figure (its count unless given) with a bar of its share of the largest count.
 * @param {Document} doc
 * @param {Array<{ name: string, count: number, figure?: string, meta?: string }>} rows
 * @param {string} empty the text when there are no rows
 */
export const rankList = (doc, rows, empty) => {
	const list = element(doc, 'ul', { class: 'rank' });
	if (rows.length === 0) list.append(element(doc, 'li', { class: 'empty' }, empty));
	const most = Math.max(1, ...rows.map((row) => row.count));
	for (const row of rows) {
		const item = element(doc, 'li');
		const line = element(doc, 'div', { class: 'line' });
		line.append(
			element(doc, 'span', { class: 'name' }, row.name),
			element(doc, 'span', { class: 'figure' }, row.figure ?? String(row.count)),
		);
		const bar = element(doc, 'span', { class: 'share', 'aria-hidden': 'true' });
		bar.style.setProperty('--share', `${Math.max(2, Math.round((row.count / most) * 100))}%`);
		item.append(line, bar);
		if (row.meta) item.append(element(doc, 'span', { class: 'meta' }, row.meta));
		list.append(item);
	}
	return list;
};
