/**
 * Order and customer field values in the staff widgets (PLAN 0.8.10 dynamic model §2): a card of the values a record
 * holds, by field, as people read them (a choice's label, yes or no, a number with its unit, several joined), and the
 * dialog that edits them — one control per field (`ui/admin-product-editor.js` `specControl`: text, number in its range,
 * choice, yes or no, date; required ones marked), checked as the server checks them before saving; a field emptied is
 * cleared.
 * @module
 */
import { FORMAT_REFUSALS, checkValue } from '../core/fields.js';
import { card } from './admin-screen.js';
import { specControl } from './admin-product-editor.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */

/**
 * A value as staff read it.
 * @param {Kit} kit @param {any} field @param {unknown} value
 */
const fieldValueText = (kit, field, value) =>
	(Array.isArray(value) ? value : [value])
		.map((entry) =>
			field.type === 'yes_no'
				? kit.t(entry === true ? 'admin.yes' : 'admin.no')
				: field.type === 'choice'
					? ((field.choices ?? []).find((/** @type {any} */ choice) => choice.value === entry)?.label ?? String(entry))
					: field.type === 'number' && field.unit
						? `${String(entry)} ${field.unit}`
						: String(entry),
		)
		.join(', ');

/**
 * The card of a record's field values (null without fields); fields without a value show as not set.
 * @param {Kit} kit @param {any[]} fields @param {Record<string, unknown>} values
 */
export const fieldsCard = (kit, fields, values) =>
	fields.length === 0
		? null
		: card(kit, kit.t('admin.fieldsTitle'), [
				kit.fieldGrid(
					fields.map((field) => [
						field.shopper ? `${field.name} · ${kit.t('admin.fieldShopper')}` : field.name,
						values[field.id] === undefined ? kit.t('catalogAdmin.notSet') : fieldValueText(kit, field, values[field.id]),
					]),
				),
			]);

/**
 * Edit a record's field values: `save(body)` sends `{ fields }` (null clears a value) and answers an error to show, or
 * null when done.
 * @param {Kit} kit @param {{ fields: any[], values: Record<string, unknown>, save: (body: Record<string, unknown>) => Promise<string | null> }} options
 */
export const fieldsDialog = (kit, { fields, values, save }) => {
	const { t } = kit;
	const controls = fields
		.filter((field) => field.active !== false)
		.map((field) => ({ field, ...specControl(kit, field, values[field.id], []) }));
	kit.dialog({
		title: t('admin.editFields'),
		body: controls.map((control) => control.node),
		submitLabel: t('admin.save'),
		onSubmit: async () => {
			/** @type {Record<string, unknown>} */
			const sent = {};
			for (const { field, read } of controls) {
				const value = read();
				if (value === null || (typeof value === 'number' && Number.isNaN(value))) {
					if (values[field.id] !== undefined) sent[field.id] = null;
					continue;
				}
				const checked = checkValue(field, value);
				if (!checked.ok)
					return checked.value !== undefined && FORMAT_REFUSALS.includes(/** @type {any} */ (checked.code))
						? `${t('fields.notFormat', { value: checked.value, field: field.name })} ${t(`fields.problem.${checked.code}`)}`
						: t('admin.fieldWrong', { field: field.name });
				sent[field.id] = checked.value;
			}
			return save({ fields: sent });
		},
	});
};
