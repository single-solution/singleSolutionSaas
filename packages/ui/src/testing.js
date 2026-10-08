/**
 * `@ss/ui/testing` — minimal DOM test helpers on react-dom/client + jsdom (no Testing Library): render into a detached
 * container attached to `document.body`, fire events inside `act`, query by role/label/text. Needs a DOM: run the test
 * file in the `jsdom` environment (`// @vitest-environment jsdom`).
 * @module
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/** @type {any} */ (globalThis).IS_REACT_ACT_ENVIRONMENT = true;

/** @type {Array<() => void>} */
const mounted = [];

/**
 * @param {import('react').ReactNode} element
 */
export const render = (element) => {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(element));
	const unmount = () => {
		act(() => root.unmount());
		container.remove();
	};
	mounted.push(unmount);
	return {
		container,
		/** @param {import('react').ReactNode} next */
		rerender: (next) => act(() => root.render(next)),
		unmount,
	};
};

/** Unmount everything rendered by the current test. */
export const cleanup = () => {
	while (mounted.length > 0) mounted.pop()?.();
	document.body.innerHTML = '';
};

/** @param {Element} el */
export const click = (el) =>
	act(() => {
		/** @type {HTMLElement} */ (el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	});

/**
 * Set an input's value the way a person typing would (React listens to `input`).
 * @param {Element} el
 * @param {string} value
 */
export const type = (el, value) =>
	act(() => {
		const input = /** @type {HTMLInputElement} */ (el);
		const proto =
			input instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: input instanceof HTMLSelectElement
					? HTMLSelectElement.prototype
					: HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
		setter?.call(input, value);
		input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
	});

/**
 * @param {Element | Document} el
 * @param {string} key
 * @param {{ shiftKey?: boolean }} [init]
 */
export const keydown = (el, key, init = {}) =>
	act(() => {
		el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
	});

/**
 * Elements whose accessible-ish text includes `text`.
 * @param {ParentNode} root
 * @param {string} text
 * @param {string} [selector]
 * @returns {HTMLElement[]}
 */
const allByText = (root, text, selector = '*') =>
	/** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]).filter(
		(el) => el.textContent?.includes(text) && ![...el.children].some((c) => c.textContent?.includes(text)),
	);

/**
 * @param {ParentNode} root
 * @param {string} text
 * @param {string} [selector]
 */
export const byText = (root, text, selector) => {
	const found = allByText(root, text, selector)[0];
	if (!found) throw new Error(`no element with text “${text}”`);
	return found;
};

/**
 * Control labelled `label` (via <label for>).
 * @param {ParentNode} root
 * @param {string} label
 * @returns {HTMLInputElement}
 */
export const byLabel = (root, label) => {
	const el = [...root.querySelectorAll('label')].find((l) => l.textContent?.replace(/\s*\*$/, '').trim() === label);
	if (!el) throw new Error(`no label “${label}”`);
	const control = document.getElementById(/** @type {HTMLLabelElement} */ (el).htmlFor);
	if (!control) throw new Error(`label “${label}” is not associated`);
	return /** @type {HTMLInputElement} */ (control);
};

/**
 * @param {ParentNode} root
 * @param {string} role
 * @returns {HTMLElement[]}
 */
export const allByRole = (root, role) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(`[role="${role}"]`)]);

export { act };
