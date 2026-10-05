/**
 * Mode A default renderer of the `widget` element: a pure function of (state, actions, strings, theme, slots) that
 * returns DOM built with the injected `dom` (the Loader passes `document`). Built only on headless/; design tokens
 * only; reserves its minimum height (no layout shift); respects reduced motion.
 *
 * Accessibility: single-choice groups are ARIA radio groups (one tab stop, arrow keys / Home / End move and choose,
 * Space / Enter choose), multi-choice groups are groups of checkbox buttons, dropdowns are native `<select>`s, range
 * and text groups are labelled inputs; every control has a visible focus ring, option states are announced in text
 * (never colour alone), and price and notices are polite live regions. `update` re-renders and restores focus to the
 * same option, so keyboard users never lose their place.
 */
import { createTranslator } from '../headless/strings.js';

/** @typedef {import('../headless/configurator.js').ConfiguratorState} ConfiguratorState */
/** @typedef {import('../headless/configurator.js').GroupView} GroupView */
/** @typedef {{ createElement: (tag: string) => any, createTextNode: (text: string) => any }} DomLike */
/**
 * @typedef {{ pick: (group: string, value: unknown) => Promise<unknown>, toggle: (group: string, option: string) => Promise<unknown>,
 *   requestNotify: () => Promise<unknown> }} Actions
 */

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-configurator { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-3); min-height: var(--ss-configurator-min-height, 6rem); display: grid; gap: var(--ss-space-3); }
.ss-configurator__label { font-weight: var(--ss-font-weight-bold, 700); margin: 0 0 var(--ss-space-1); }
.ss-configurator__hint, .ss-configurator__meta { color: var(--ss-color-text-muted); margin: 0; }
.ss-configurator__options { display: flex; flex-wrap: wrap; gap: var(--ss-space-2); }
.ss-configurator__option { min-height: 2.75rem; min-width: 2.75rem; padding: var(--ss-space-1) var(--ss-space-3); cursor: pointer;
  color: var(--ss-color-text); background: var(--ss-color-surface); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); }
.ss-configurator__option[aria-checked="true"] { border-color: var(--ss-color-primary); box-shadow: inset 0 0 0 1px var(--ss-color-primary); }
.ss-configurator__option[data-state="out_of_stock"] { text-decoration: line-through; color: var(--ss-color-text-muted); }
.ss-configurator__option[data-state="conflict"] { border-style: dashed; }
.ss-configurator__option[aria-disabled="true"] { cursor: not-allowed; opacity: 0.6; }
.ss-configurator__option:focus-visible, .ss-configurator__input:focus-visible, .ss-configurator__notify:focus-visible {
  outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-configurator__swatch { display: inline-block; width: 1.5rem; height: 1.5rem; border-radius: var(--ss-radius-full, 50%);
  background: var(--ss-swatch, var(--ss-color-border)); border: 1px solid var(--ss-color-border); vertical-align: middle; }
.ss-configurator__swatch-image { width: 1.5rem; height: 1.5rem; border-radius: var(--ss-radius-full, 50%); vertical-align: middle; }
.ss-configurator__input { min-height: 2.75rem; color: var(--ss-color-text); background: var(--ss-color-surface);
  border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-1) var(--ss-space-2); }
.ss-configurator__price { font-weight: var(--ss-font-weight-bold, 700); color: var(--ss-color-primary); margin: 0; }
.ss-configurator__summary { display: grid; grid-template-columns: auto 1fr; gap: var(--ss-space-1) var(--ss-space-3); margin: 0; }
.ss-configurator__summary dd { margin: 0; }
.ss-configurator__notice { color: var(--ss-color-text); margin: 0; }
.ss-configurator__stock { color: var(--ss-color-danger); margin: 0; }
.ss-configurator__error { color: var(--ss-color-danger); margin: 0; }
.ss-configurator__notify { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border: 0;
  border-radius: var(--ss-radius-sm); padding: var(--ss-space-1) var(--ss-space-3); min-height: 2.75rem; cursor: pointer; }
.ss-configurator__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) { .ss-configurator__option { transition: border-color var(--ss-motion-fast, 120ms); } }
`;

/** Focus targets of rendered roots (for `update`). @type {WeakMap<object, Map<string, any>>} */
const TARGETS = new WeakMap();

/**
 * @param {DomLike} dom
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {Array<any>} [children]
 */
const el = (dom, tag, attributes = {}, children = []) => {
	const node = dom.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
	for (const child of children)
		if (child !== null && child !== undefined) node.append(typeof child === 'string' ? dom.createTextNode(child) : child);
	return node;
};

/** @param {string} value */
const safeId = (value) => value.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Render the element.
 * @param {{ state: ConfiguratorState, actions: Actions, strings: Record<string, string>, theme?: { variant?: string, idPrefix?: string },
 *   slots?: Record<string, any>, dom: DomLike }} params
 * @returns {any} root element
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const prefix = safeId(theme.idPrefix ?? `ss-cfg-${state.configuratorId ?? 'widget'}`);
	/** @type {Map<string, any>} */
	const targets = new Map();
	const sr = (/** @type {string} */ text) => el(dom, 'span', { class: 'ss-configurator__sr' }, [text]);
	/** The Loader's `dropdowns` variant turns pill groups into selects; everything else is the group's display. @param {GroupView} group */
	const variantDisplay = (group) => (theme.variant === 'dropdowns' && group.display === 'pills' ? 'dropdown' : group.display);

	/** @param {GroupView} group @param {string} labelId */
	const choiceButtons = (group, labelId) => {
		const multi = group.type === 'multi';
		const enabled = group.options.filter((option) => !option.disabled);
		const focusKey = (group.options.find((option) => option.selected && !option.disabled) ?? enabled[0])?.key;
		/** @param {number} from @param {number} step */
		const neighbour = (from, step) => {
			const index = enabled.findIndex((option) => option.key === group.options[from]?.key);
			const start = index < 0 ? 0 : index;
			return enabled[(start + step + enabled.length) % enabled.length];
		};
		const buttons = group.options.map((option, index) => {
			const swatch = group.display === 'swatches';
			const visual = swatch
				? option.image
					? el(dom, 'img', { class: 'ss-configurator__swatch-image', src: option.image, alt: '' })
					: el(dom, 'span', { class: 'ss-configurator__swatch', 'aria-hidden': 'true' })
				: null;
			if (visual && option.swatch && !option.image && visual.style?.setProperty)
				visual.style.setProperty('--ss-swatch', option.swatch);
			const button = el(
				dom,
				'button',
				{
					type: 'button',
					class: `ss-configurator__option ss-configurator__option--${swatch ? 'swatch' : 'pill'}`,
					role: multi ? 'checkbox' : 'radio',
					'aria-checked': String(option.selected),
					'data-state': option.state,
					'data-ss-focus': `${group.key}::${option.key}`,
					tabindex: multi || option.key === focusKey ? '0' : '-1',
					...(option.disabled ? { 'aria-disabled': 'true' } : {}),
					...(swatch ? { title: option.label } : {}),
				},
				[visual, swatch ? sr(option.label) : option.label, option.stateText ? sr(` (${option.stateText})`) : null],
			);
			targets.set(`${group.key}::${option.key}`, button);
			const choose = () => {
				if (option.disabled) return;
				if (multi) actions.toggle(group.key, option.key);
				else if (!option.selected) actions.pick(group.key, option.key);
			};
			button.addEventListener('click', choose);
			if (!multi)
				button.addEventListener('keydown', (/** @type {{ key: string, preventDefault?: () => void }} */ event) => {
					const moves = /** @type {Record<string, () => any>} */ ({
						ArrowRight: () => neighbour(index, 1),
						ArrowDown: () => neighbour(index, 1),
						ArrowLeft: () => neighbour(index, -1),
						ArrowUp: () => neighbour(index, -1),
						Home: () => enabled[0],
						End: () => enabled[enabled.length - 1],
					});
					if (event.key === ' ' || event.key === 'Enter') {
						event.preventDefault?.();
						choose();
						return;
					}
					const target = moves[event.key]?.();
					if (!target) return;
					event.preventDefault?.();
					targets.get(`${group.key}::${target.key}`)?.focus?.();
					if (!target.selected) actions.pick(group.key, target.key);
				});
			return button;
		});
		return el(
			dom,
			'div',
			{ class: 'ss-configurator__options', role: multi ? 'group' : 'radiogroup', 'aria-labelledby': labelId },
			buttons,
		);
	};

	/** @param {GroupView} group @param {string} controlId @param {string | null} describedBy */
	const select = (group, controlId, describedBy) => {
		const node = el(dom, 'select', {
			id: controlId,
			class: 'ss-configurator__input',
			'data-ss-focus': `${group.key}::`,
			...(describedBy ? { 'aria-describedby': describedBy } : {}),
			...(group.required ? { required: '' } : {}),
		});
		const empty = el(dom, 'option', { value: '' }, [group.required ? t('widget.choose') : t('widget.none')]);
		if (group.value === null) empty.setAttribute('selected', '');
		node.append(empty);
		for (const option of group.options) {
			const item = el(dom, 'option', { value: option.key }, [
				option.stateText ? `${option.label} (${option.stateText})` : option.label,
			]);
			if (option.selected) item.setAttribute('selected', '');
			if (option.disabled) item.setAttribute('disabled', '');
			node.append(item);
		}
		node.addEventListener('change', (/** @type {{ target?: { value?: string } }} */ event) => {
			const value = event.target?.value ?? '';
			actions.pick(group.key, value === '' ? null : value);
		});
		targets.set(`${group.key}::`, node);
		return node;
	};

	/** @param {GroupView} group @param {string} controlId @param {string | null} describedBy */
	const input = (group, controlId, describedBy) => {
		const range = group.type === 'range';
		const node = el(dom, 'input', {
			id: controlId,
			class: 'ss-configurator__input',
			type: range ? 'number' : 'text',
			'data-ss-focus': `${group.key}::`,
			value: group.value === null || group.value === undefined ? '' : String(group.value),
			...(range
				? { min: String(group.min), max: String(group.max), step: String(group.step ?? 1), inputmode: 'numeric' }
				: { maxlength: String(group.maxLength ?? 200) }),
			...(describedBy ? { 'aria-describedby': describedBy } : {}),
			...(group.required ? { required: '' } : {}),
		});
		node.addEventListener('change', (/** @type {{ target?: { value?: string } }} */ event) => {
			const raw = event.target?.value ?? '';
			actions.pick(group.key, raw === '' ? null : range ? Number(raw) : raw);
		});
		targets.set(`${group.key}::`, node);
		return node;
	};

	/** @param {GroupView} group */
	const groupNode = (group) => {
		const base = `${prefix}-${safeId(group.key)}`;
		const labelId = `${base}-label`;
		const controlId = `${base}-control`;
		const hintId = group.description ? `${base}-hint` : null;
		const display = variantDisplay(group);
		const choice = group.type === 'single' || group.type === 'multi';
		const native = !choice || (display === 'dropdown' && group.type === 'single');
		const label = native
			? el(dom, 'label', { id: labelId, class: 'ss-configurator__label', for: controlId }, [group.label])
			: el(dom, 'p', { id: labelId, class: 'ss-configurator__label' }, [group.label]);
		const hint = hintId
			? el(dom, 'p', { id: hintId, class: 'ss-configurator__hint' }, [/** @type {string} */ (group.description)])
			: null;
		const control = !choice
			? input(group, controlId, hintId)
			: native
				? select(group, controlId, hintId)
				: choiceButtons(group, labelId);
		if (!native && hintId) control.setAttribute('aria-describedby', hintId);
		return el(dom, 'div', { class: `ss-configurator__group ss-configurator__group--${display}`, 'data-group': group.key }, [
			label,
			hint,
			control,
		]);
	};

	const loading = state.status === 'loading' || state.status === 'idle';
	/** @type {any[]} */
	const children = [slots.before ?? null, el(dom, 'h2', { class: 'ss-configurator__label' }, [state.title])];
	if (loading) children.push(el(dom, 'p', { class: 'ss-configurator__meta' }, [t('widget.loading')]));
	children.push(...state.groups.map(groupNode));
	if (state.showSummary && state.groups.length > 0)
		children.push(
			el(dom, 'dl', { class: 'ss-configurator__summary', 'aria-label': t('widget.summary.title') }, [
				...state.summary.flatMap((row) => [el(dom, 'dt', {}, [row.label]), el(dom, 'dd', {}, [row.value])]),
			]),
			slots.summary ?? null,
		);
	children.push(
		el(
			dom,
			'p',
			{ class: 'ss-configurator__price', 'aria-live': 'polite', 'aria-label': t('widget.price') },
			state.showPrice && state.priceText ? [state.priceText] : [],
		),
		el(dom, 'p', { class: 'ss-configurator__notice', role: 'status', 'aria-live': 'polite' }, [
			state.notice ?? state.missingText ?? '',
		]),
	);
	if (state.outOfStockText) {
		children.push(el(dom, 'p', { class: 'ss-configurator__stock', role: 'note' }, [state.outOfStockText]));
		if (state.notify) {
			const notify = el(dom, 'button', { type: 'button', class: 'ss-configurator__notify', 'data-ss-focus': 'notify' }, [
				t('widget.notify'),
			]);
			notify.addEventListener('click', () => actions.requestNotify());
			targets.set('notify', notify);
			children.push(notify);
		}
	}
	if (state.error) children.push(el(dom, 'p', { class: 'ss-configurator__error', role: 'alert' }, [state.error]));
	children.push(slots.after ?? null);
	const root = el(
		dom,
		'section',
		{
			class: `ss-configurator ss-configurator--${theme.variant ?? 'pills'}`,
			role: 'region',
			'aria-label': state.title,
			'aria-busy': String(loading || state.busy),
		},
		children,
	);
	TARGETS.set(root, targets);
	return root;
};

/**
 * Re-render in place and keep keyboard focus on the same control (the Loader calls this on every state change).
 * @param {any} node the current root
 * @param {Parameters<typeof render>[0]} props
 * @returns {any} the new root
 */
export const update = (node, props) => {
	const active = node?.ownerDocument?.activeElement;
	const key = active && typeof active.getAttribute === 'function' ? active.getAttribute('data-ss-focus') : null;
	const next = render(props);
	node?.replaceWith?.(next);
	if (key) TARGETS.get(next)?.get(key)?.focus?.();
	return next;
};
