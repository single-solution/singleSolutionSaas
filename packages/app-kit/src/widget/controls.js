/**
 * The controls of the widgets (PLAN 0.6), built on the browser's own inputs so the keyboard, the form value and the
 * screen reader keep working; `CONTROLS_CSS` (controls-css.js) draws them from the website's theme, in light and dark.
 *
 * - `toggle`: a switch (`<input type="checkbox" role="switch">`) for a yes or no setting, as a setting row (label and
 *   help on the left, the switch on the right) or, with `inline`, a switch with its text.
 * - `checkbox` and `radio`: a box or a round button with its text; `checkbox` can be indeterminate.
 * - `radioGroup`, `segmented` and `checkGroup`: one choice (or several) from a few, as a list, as cards or, for a few
 *   short choices, a segmented control.
 * - `field`: a label, a control, an optional hint and error; `affix` puts a prefix or suffix (`$`, `%`, `kg`) in the
 *   same frame as a text input; `fieldError` shows or clears a problem on a field.
 * - `block` and `settingRow`: a titled card (title, one line, actions) and a row of label and help beside a control,
 *   stacked on a narrow widget.
 *
 * Text is always set as text, never as HTML. A label may also be an element (a link inside a consent text).
 * @module
 */
import { element } from './dom.js';

/** @typedef {Node | string | null | undefined | false} Child left out when null, undefined or false */
/**
 * @typedef {object} ChoiceOptions
 * @property {boolean} [checked]
 * @property {boolean} [indeterminate] a checkbox that is partly selected (a select-all with some rows picked)
 * @property {string} [name]
 * @property {string} [value]
 * @property {string} [help] one line under the label, linked to the input for screen readers
 * @property {boolean} [disabled]
 * @property {(checked: boolean) => unknown} [onChange]
 */

/** Ids of the controls, unique on the page, so a label always finds its input. */
let ids = 0;
/** @param {string} prefix */
const nextId = (prefix) => `ss-${prefix}-${(ids += 1)}`;

/**
 * The native input of a choice with its options set.
 * @param {Document} doc @param {'checkbox' | 'radio'} type @param {ChoiceOptions} options @param {boolean} [isSwitch]
 */
const choiceInput = (doc, type, options, isSwitch = false) => {
	const input = /** @type {HTMLInputElement} */ (
		element(doc, 'input', { type, ...(isSwitch ? { role: 'switch' } : {}), ...(options.name ? { name: options.name } : {}) })
	);
	if (options.value !== undefined) input.value = options.value;
	input.checked = options.checked === true;
	input.indeterminate = options.indeterminate === true;
	input.disabled = options.disabled === true;
	const { onChange } = options;
	if (onChange) input.addEventListener('change', () => void onChange(input.checked));
	return input;
};

/**
 * A line of help under a control, linked to it with `aria-describedby`.
 * @param {Document} doc @param {HTMLInputElement} input @param {string} help
 */
const helpFor = (doc, input, help) => {
	const note = element(doc, 'small', { class: 'help', id: nextId('help') }, help);
	input.setAttribute('aria-describedby', note.id);
	return note;
};

/**
 * A checkbox or radio with its text: `<label class="check">`, inside a wrapper when it has a line of help.
 * @param {Document} doc @param {'checkbox' | 'radio'} type @param {Child} label @param {ChoiceOptions} options
 */
const choice = (doc, type, label, options) => {
	const box = choiceInput(doc, type, options);
	const node = element(doc, 'label', { class: 'check' });
	node.append(box, element(doc, 'span'));
	/** @type {HTMLElement} */ (node.lastChild).append(label || '');
	if (!options.help) return { box, node };
	const wrap = element(doc, 'div', { class: 'opt' });
	wrap.append(node, helpFor(doc, box, options.help));
	return { box, node: wrap };
};

/**
 * A checkbox with its text (`node`) and its input (`box`).
 * @param {Document} doc @param {Child} label @param {ChoiceOptions} [options]
 */
export const checkbox = (doc, label, options = {}) => choice(doc, 'checkbox', label, options);

/**
 * A radio button with its text (`node`) and its input (`box`); radios with the same `name` are one group.
 * @param {Document} doc @param {Child} label @param {ChoiceOptions} [options]
 */
export const radio = (doc, label, options = {}) => choice(doc, 'radio', label, options);

/**
 * A switch for a yes or no setting. By default it is a setting row: label and help on the left, the switch on the
 * right (stacked on a narrow widget). With `inline` it is the switch with its text, for a filter or a toolbar. The
 * input has `role="switch"`, so Space toggles it and a screen reader says on or off.
 * @param {Document} doc @param {Child} label @param {ChoiceOptions & { inline?: boolean }} [options]
 */
export const toggle = (doc, label, options = {}) => {
	const box = choiceInput(doc, 'checkbox', options, true);
	if (options.inline) {
		const node = element(doc, 'label', { class: 'switch' });
		node.append(box, element(doc, 'span'));
		/** @type {HTMLElement} */ (node.lastChild).append(label || '');
		if (!options.help) return { box, node };
		const wrap = element(doc, 'div', { class: 'opt' });
		wrap.append(node, helpFor(doc, box, options.help));
		return { box, node: wrap };
	}
	return { box, node: settingRow(doc, { label, help: options.help, control: box }) };
};

/**
 * A row of label and help beside a control (a switch, a select, a segmented control); `wide` gives a field its room.
 * The label is linked to the control, which gets an id when it has none.
 * @param {Document} doc
 * @param {{ label: Child, help?: string, control: HTMLElement, wide?: boolean }} input
 */
export const settingRow = (doc, { label, help, control, wide = false }) => {
	if (!control.id) control.setAttribute('id', nextId('ctl'));
	const row = element(doc, 'div', { class: wide ? 'setting wide' : 'setting' });
	const text = element(doc, 'div', { class: 'text' });
	const name = element(doc, 'label', { for: control.id });
	name.append(label || '');
	text.append(name);
	if (help) {
		const note = element(doc, 'small', { class: 'help', id: nextId('help') }, help);
		control.setAttribute('aria-describedby', note.id);
		text.append(note);
	}
	const ctl = element(doc, 'div', { class: 'ctl' });
	ctl.append(control);
	row.append(text, ctl);
	return row;
};

/**
 * @typedef {object} GroupInput
 * @property {string} label the group's accessible name
 * @property {string} name the inputs' shared name
 * @property {Array<{ value: string, label: string, help?: string, disabled?: boolean }>} items
 * @property {'plain' | 'card' | 'segmented'} [look] a list, cards with a title and a line, or a segmented control for a
 *   few short choices (radios only)
 */

/**
 * A group of radios (or checkboxes) in one of three looks, as a native group: Tab enters a radio group once and the
 * arrow keys move inside it.
 * @param {Document} doc @param {GroupInput & { value?: string | string[], onChange?: (value: any) => unknown }} input
 * @param {boolean} multiple
 */
const group = (doc, { label, name, items, value = '', look = 'plain', onChange }, multiple) => {
	const type = multiple ? 'checkbox' : 'radio';
	const chosen = Array.isArray(value) ? value : [value];
	const node = element(doc, 'div', {
		class: { plain: 'opts', card: 'choices', segmented: 'segmented' }[look],
		role: multiple ? 'group' : 'radiogroup',
		'aria-label': label,
	});
	/** @type {HTMLInputElement[]} */
	const inputs = [];
	for (const item of items) {
		const options = { name, value: item.value, checked: chosen.includes(item.value), disabled: item.disabled };
		let made;
		if (look === 'plain') made = choice(doc, type, item.label, { ...options, help: item.help });
		else {
			const box = choiceInput(doc, type, options);
			const each = element(doc, 'label', look === 'card' ? { class: 'choice' } : {});
			if (look === 'card') {
				const text = element(doc, 'span');
				text.append(element(doc, 'b', {}, item.label));
				if (item.help) text.append(element(doc, 'small', { class: 'help' }, item.help));
				each.append(box, text);
			} else each.append(box, item.label);
			made = { box, node: each };
		}
		inputs.push(made.box);
		node.append(made.node);
	}
	const read = () => {
		const picked = inputs.filter((each) => each.checked).map((each) => each.value);
		return multiple ? picked : (picked[0] ?? '');
	};
	if (onChange) for (const each of inputs) each.addEventListener('change', () => void onChange(read()));
	return {
		node,
		inputs,
		get value() {
			return read();
		},
		set value(next) {
			const set = Array.isArray(next) ? next : [next];
			for (const each of inputs) each.checked = set.includes(each.value);
		},
	};
};

/**
 * One choice from a few: native radios as a list, as cards (a title and a line each) or as a segmented control (short
 * choices side by side). `value` reads and sets the chosen value.
 * @param {Document} doc
 * @param {GroupInput & { value?: string, onChange?: (value: string) => unknown }} input
 * @returns {{ node: HTMLElement, inputs: HTMLInputElement[], value: string }}
 */
export const radioGroup = (doc, input) => /** @type {any} */ (group(doc, input, false));

/**
 * One choice from a few, side by side in a segmented control: `radioGroup` with that look.
 * @param {Document} doc
 * @param {Omit<GroupInput, 'look'> & { value?: string, onChange?: (value: string) => unknown }} input
 */
export const segmented = (doc, input) => radioGroup(doc, { ...input, look: 'segmented' });

/**
 * Several choices from a few: native checkboxes as a list or as cards. `value` reads and sets the chosen values.
 * @param {Document} doc
 * @param {Omit<GroupInput, 'look'> & { look?: 'plain' | 'card', value?: string[], onChange?: (value: string[]) => unknown }} input
 * @returns {{ node: HTMLElement, inputs: HTMLInputElement[], value: string[] }}
 */
export const checkGroup = (doc, input) => /** @type {any} */ (group(doc, input, true));

/**
 * A text input (or select) with a prefix and a suffix in one frame (`$ [ 12.50 ] USD`).
 * @param {Document} doc @param {HTMLElement} control @param {{ prefix?: string, suffix?: string }} [around]
 */
export const affix = (doc, control, { prefix = '', suffix = '' } = {}) => {
	const frame = element(doc, 'div', { class: 'affix' });
	if (prefix) frame.append(element(doc, 'span', { class: 'pre' }, prefix));
	frame.append(control);
	if (suffix) frame.append(element(doc, 'span', { class: 'suf' }, suffix));
	return frame;
};

/**
 * A labeled field: the label linked to the control, an optional hint and error line (both linked with
 * `aria-describedby`; the error is also `aria-invalid` and read out at once) and a prefix or suffix.
 * @param {Document} doc @param {Child} label @param {HTMLElement} control
 * @param {{ hint?: string, error?: string, prefix?: string, suffix?: string }} [options]
 */
export const field = (doc, label, control, { hint = '', error = '', prefix = '', suffix = '' } = {}) => {
	const node = element(doc, 'div', { class: 'field' });
	// a radio or checkbox group has its name already (`aria-label`): its visible caption is not a label
	const grouped = ['radiogroup', 'group'].includes(control.getAttribute('role') ?? '');
	if (!control.id) control.setAttribute('id', nextId('field'));
	const name = grouped
		? element(doc, 'span', { class: 'cap', 'aria-hidden': 'true' })
		: element(doc, 'label', { for: control.id });
	name.append(label || '');
	node.append(name, prefix || suffix ? affix(doc, control, { prefix, suffix }) : control);
	if (hint) {
		const note = element(doc, 'small', { class: 'hint', id: nextId('hint') }, hint);
		control.setAttribute('aria-describedby', note.id);
		node.append(note);
	}
	if (error) fieldError(node, error);
	return node;
};

/**
 * Show a problem on a field made by `field`, or clear it with ''. The control becomes `aria-invalid` and the line is
 * announced (`role="alert"`).
 * @param {HTMLElement} node @param {string} text
 */
export const fieldError = (node, text) => {
	const doc = /** @type {Document} */ (node.ownerDocument);
	const control = /** @type {HTMLElement | null} */ (
		node.querySelector('input, select, textarea, [role="radiogroup"], [role="group"]')
	);
	let line = /** @type {HTMLElement | null} */ (node.querySelector('.hint.error'));
	if (!text) {
		line?.remove();
		control?.removeAttribute('aria-invalid');
		return;
	}
	if (!line) {
		line = element(doc, 'small', { class: 'hint error', role: 'alert', id: nextId('error') });
		node.append(line);
		const described = control?.getAttribute('aria-describedby');
		control?.setAttribute('aria-describedby', described ? `${described} ${line.id}` : line.id);
	}
	line.textContent = text;
	control?.setAttribute('aria-invalid', 'true');
};

/**
 * A titled card: a title, one line under it and actions on the right, then the body. The card is a labeled region.
 * @param {Document} doc
 * @param {{ title?: string, sub?: string, actions?: Child[], body?: Child[] }} input
 * @returns {HTMLElement} the card; more can be appended to it
 */
export const block = (doc, { title = '', sub = '', actions = [], body = [] }) => {
	const node = element(doc, 'section', { class: 'block' });
	if (title) {
		const id = nextId('block');
		node.setAttribute('aria-labelledby', id);
		const head = element(doc, 'div', { class: 'block-head' });
		const text = element(doc, 'div');
		text.append(element(doc, 'h3', { id }, title));
		if (sub) text.append(element(doc, 'p', {}, sub));
		head.append(text);
		const shown = actions.filter((each) => each !== null && each !== undefined && each !== false);
		if (shown.length > 0) {
			const bar = element(doc, 'div', { class: 'actions' });
			bar.append(.../** @type {Array<Node | string>} */ (shown));
			head.append(bar);
		}
		node.append(head);
	}
	node.append(
		.../** @type {Array<Node | string>} */ (body.filter((each) => each !== null && each !== undefined && each !== false)),
	);
	return node;
};
