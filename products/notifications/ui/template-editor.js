/**
 * The admin widget `template_editor` (permission `templates.edit`): the merchant's staff write the templates per
 * template key, channel and language in their own admin. Picking a template from the list loads it into the form. A
 * WhatsApp template at Meta lists the buttons that take a value (PLAN 0.8.10 N1).
 * @module
 */
import { formatText, mountWidget } from '@ss/app-kit/widget';
import { CHANNELS } from '../core/channels.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** @typedef {{ index: number, type: string, value: string }} ButtonView */
/**
 * @typedef {{ key: string, channel: string, language: string, subject: string, text: string, required: boolean,
 *   urgent: boolean, providerTemplate: string, buttons?: ButtonView[] }} TemplateView
 */

/** Most buttons a template at Meta has. */
const MAX_BUTTONS = 10;

/**
 * @param {{ host: HTMLElement, api: import('./tickets.js').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountTemplateEditor = ({ host, api, config }) => {
	/** @param {string} key */
	const t = (key) => config.texts[key] ?? key;
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			let n = 0;
			/**
			 * A labelled field.
			 * @param {string} tag @param {string} label @param {Record<string, string>} [attributes]
			 */
			const field = (tag, label, attributes = {}) => {
				n += 1;
				const id = `tpl-${n}`;
				const input = element(doc, tag, { id, ...attributes });
				return { label: element(doc, 'label', { for: id }, label), input: /** @type {HTMLInputElement} */ (input) };
			};
			/** @param {string} label */
			const check = (label) => {
				const input = /** @type {HTMLInputElement} */ (element(doc, 'input', { type: 'checkbox' }));
				const wrap = element(doc, 'label', { class: 'check' });
				wrap.append(input, doc.createTextNode(label));
				return { wrap, input };
			};
			const key = field('input', t('templates.key'), { maxlength: '64' });
			const channel = field('select', t('templates.channel'));
			channel.input.append(...CHANNELS.map((value) => element(doc, 'option', { value }, t(`channel.${value}`))));
			const language = field('input', t('templates.language'), { maxlength: '20' });
			const subject = field('input', t('templates.subject'), { maxlength: '200' });
			const text = field('textarea', t('templates.text'), { rows: '5' });
			const required = check(t('templates.required'));
			const urgent = check(t('templates.urgent'));
			const providerTemplate = field('input', t('templates.providerTemplate'), { maxlength: '512' });
			const rows = element(doc, 'div');
			const addButton = element(doc, 'button', { type: 'button', class: 'secondary' }, t('templates.addButton'));
			const buttonsBox = element(doc, 'div', { class: 'buttons' });
			buttonsBox.append(
				element(doc, 'label', {}, t('templates.buttons')),
				element(doc, 'p', { class: 'meta' }, t('templates.buttonsHelp')),
				rows,
				addButton,
			);
			/** @type {Array<{ index: HTMLInputElement, type: HTMLInputElement, value: HTMLInputElement }>} */
			let buttonFields = [];
			/** @param {ButtonView} button */
			const addRow = (button) => {
				const row = element(doc, 'div', { class: 'row' });
				const index = field('input', t('templates.buttonIndex'), { type: 'number', min: '0', max: String(MAX_BUTTONS - 1) });
				const type = field('select', t('templates.buttonType'));
				type.input.append(
					...['copy_code', 'url'].map((value) => element(doc, 'option', { value }, t(`templates.buttonType.${value}`))),
				);
				const value = field('input', t('templates.buttonValue'), { maxlength: '2000' });
				index.input.value = String(button.index);
				type.input.value = button.type;
				value.input.value = button.value;
				const remove = element(doc, 'button', { type: 'button', class: 'secondary' }, t('templates.removeButton'));
				const fields = { index: index.input, type: type.input, value: value.input };
				remove.addEventListener('click', () => {
					buttonFields = buttonFields.filter((entry) => entry !== fields);
					row.remove();
					addButton.toggleAttribute('disabled', false);
				});
				for (const part of [index, type, value]) {
					const cell = element(doc, 'div');
					cell.append(part.label, part.input);
					row.append(cell);
				}
				row.append(remove);
				rows.append(row);
				buttonFields.push(fields);
				addButton.toggleAttribute('disabled', buttonFields.length >= MAX_BUTTONS);
			};
			/** Buttons only for a WhatsApp template at Meta. */
			const atMeta = () => channel.input.value === 'whatsapp' && providerTemplate.input.value.trim() !== '';
			const showButtons = () => buttonsBox.toggleAttribute('hidden', !atMeta());
			addButton.addEventListener('click', () => {
				const used = buttonFields.map((entry) => Number(entry.index.value));
				const free = Array.from({ length: MAX_BUTTONS }, (_, index) => index).find((index) => !used.includes(index)) ?? 0;
				addRow({ index: free, type: 'copy_code', value: '' });
			});
			channel.input.addEventListener('change', showButtons);
			providerTemplate.input.addEventListener('input', showButtons);
			const save = element(doc, 'button', { type: 'submit' }, t('templates.save'));
			const remove = element(doc, 'button', { type: 'button', class: 'secondary' }, t('templates.delete'));
			const fresh = element(doc, 'button', { type: 'button', class: 'secondary' }, t('templates.new'));
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const form = element(doc, 'form', { class: 'box' });
			form.append(
				element(doc, 'h2', {}, t('templates.title')),
				list,
				key.label,
				key.input,
				channel.label,
				channel.input,
				language.label,
				language.input,
				subject.label,
				subject.input,
				text.label,
				text.input,
				element(doc, 'p', { class: 'meta' }, formatText(t('templates.help'), { section: '{?name}…{/name}' })),
				required.wrap,
				urgent.wrap,
				providerTemplate.label,
				providerTemplate.input,
				buttonsBox,
				save,
				remove,
				fresh,
				note,
			);
			root.append(form);

			/** @param {Partial<TemplateView>} view */
			const fill = (view) => {
				key.input.value = view.key ?? '';
				channel.input.value = view.channel ?? 'email';
				language.input.value = view.language && view.language !== 'default' ? view.language : '';
				subject.input.value = view.subject ?? '';
				text.input.value = view.text ?? '';
				required.input.checked = view.required === true;
				urgent.input.checked = view.urgent === true;
				providerTemplate.input.value = view.providerTemplate ?? '';
				rows.replaceChildren();
				buttonFields = [];
				addButton.toggleAttribute('disabled', false);
				for (const button of view.buttons ?? []) addRow(button);
				showButtons();
			};

			const load = async () => {
				const answer = await adminCall(api, 'GET', '/v1/admin/templates');
				if (!answer.ok) {
					list.replaceChildren();
					note.textContent = api.tickets.current()
						? formatText(t('templates.failed'), { reason: '' })
						: t('templates.signedOut');
					return;
				}
				/** @type {TemplateView[]} */
				const items = answer.data.items;
				list.replaceChildren(
					...(items.length === 0
						? [element(doc, 'li', {}, t('templates.empty'))]
						: items.map((view) => {
								const item = element(doc, 'li');
								const pick = element(
									doc,
									'button',
									{ type: 'button', class: 'secondary' },
									`${view.key} · ${t(`channel.${view.channel}`)} · ${view.language === 'default' ? t('templates.default') : view.language}`,
								);
								pick.addEventListener('click', () => fill(view));
								item.append(pick);
								return item;
							})),
				);
			};

			form.addEventListener('submit', async (event) => {
				event.preventDefault();
				const answer = await adminCall(api, 'PUT', '/v1/admin/templates', {
					key: key.input.value.trim(),
					channel: channel.input.value,
					language: language.input.value.trim() || 'default',
					subject: subject.input.value,
					text: text.input.value,
					required: required.input.checked,
					urgent: urgent.input.checked,
					providerTemplate: providerTemplate.input.value.trim(),
					buttons: atMeta()
						? buttonFields.map((entry) => ({
								index: Number(entry.index.value),
								type: entry.type.value,
								value: entry.value.value,
							}))
						: [],
				});
				note.textContent = answer.ok
					? t('templates.saved')
					: formatText(t('templates.failed'), { reason: answer.data?.detail ?? '' });
				if (answer.ok) await load();
			});
			remove.addEventListener('click', async () => {
				const path = [key.input.value.trim(), channel.input.value, language.input.value.trim() || 'default']
					.map(encodeURIComponent)
					.join('/');
				const answer = await adminCall(api, 'DELETE', `/v1/admin/templates/${path}`);
				note.textContent = answer.ok
					? t('templates.deleted')
					: formatText(t('templates.failed'), { reason: answer.data?.detail ?? '' });
				if (answer.ok) {
					fill({});
					await load();
				}
			});
			fresh.addEventListener('click', () => fill({}));
			fill({});
			void load();
			return undefined;
		},
	});
};
