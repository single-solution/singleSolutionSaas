// @vitest-environment jsdom
/* global document, window */
import { describe, expect, it, vi } from 'vitest';
import { formatText, mountWidget, themeCss } from '../src/widget.js';
import { placeholdersOf, samePlaceholders } from '../src/text.js';

describe('widget texts', () => {
	it('fills placeholders as plain text and compares placeholder sets', () => {
		expect(formatText('Hi {name}, {count} new {missing}', { name: '<b>Sam</b>', count: 3 })).toBe(
			'Hi <b>Sam</b>, 3 new {missing}',
		);
		expect(formatText('Plain')).toBe('Plain');
		expect(placeholdersOf('{b} {a} {b} {1x}')).toEqual(['a', 'b']);
		expect(samePlaceholders('{a} {b}', '{b} then {a}')).toBe(true);
		expect(samePlaceholders('{a}', '{a} {b}')).toBe(false);
	});
});

describe('mountWidget', () => {
	it('renders into an open shadow root with the theme, product CSS and custom CSS only there', () => {
		const host = document.createElement('div');
		document.body.append(host);
		const cleanup = vi.fn();
		const widget = mountWidget({
			host,
			theme: {
				colors: { accent: '#ff0000', bad: 'red', 'Bad-Name': '#000000' },
				fontFamily: 'Inter',
				radius: 6,
				mode: 'dark',
			},
			css: '.note { color: var(--ss-color-accent); }',
			customCss: '.note { font-weight: bold; }',
			render: (root) => {
				const note = root.ownerDocument.createElement('p');
				note.className = 'note';
				note.textContent = formatText('Hello {name}', { name: 'Sam' });
				root.append(note);
				return cleanup;
			},
		});
		expect(host.shadowRoot).toBe(widget.shadow);
		expect(widget.shadow.mode).toBe('open');
		const styles = [...widget.shadow.querySelectorAll('style')].map((style) => style.textContent);
		expect(styles[0]).toBe(':host { --ss-color-accent: #ff0000; --ss-font-family: "Inter", inherit; --ss-radius: 6px; }');
		expect(styles[1]).toContain('var(--ss-color-accent)');
		expect(styles[2]).toBe('.note { font-weight: bold; }');
		expect(document.head.querySelectorAll('style')).toHaveLength(0);
		expect(widget.root.querySelector('.note')?.textContent).toBe('Hello Sam');
		expect(host.getAttribute('data-ss-mode')).toBe('dark');
		widget.update({ theme: { mode: 'light', fontFamily: 'inherit' }, customCss: '' });
		expect(host.getAttribute('data-ss-mode')).toBe('light');
		expect(widget.shadow.querySelectorAll('style')[2]?.textContent).toBe('');
		widget.update({});
		widget.unmount();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(widget.shadow.childNodes).toHaveLength(0);
		expect(host.hasAttribute('data-ss-mode')).toBe(false);
	});

	it('follows the device in auto mode and reuses an existing shadow root', () => {
		/** @type {Array<() => void>} */
		const listeners = [];
		const media = {
			matches: true,
			addEventListener: (/** @type {string} */ _type, /** @type {() => void} */ fn) => listeners.push(fn),
			removeEventListener: vi.fn(),
		};
		const original = window.matchMedia;
		window.matchMedia = /** @type {any} */ (() => media);
		const host = document.createElement('div');
		host.attachShadow({ mode: 'open' }).append(document.createElement('span'));
		const widget = mountWidget({ host, render: () => {} });
		expect(widget.shadow.querySelector('span')).toBeNull();
		expect(host.getAttribute('data-ss-mode')).toBe('dark');
		media.matches = false;
		for (const listener of listeners) listener();
		expect(host.getAttribute('data-ss-mode')).toBe('light');
		widget.unmount();
		expect(media.removeEventListener).toHaveBeenCalled();
		window.matchMedia = original;
	});

	it('leaves out theme values that do not fit', () => {
		expect(themeCss({ fontFamily: 'x;} body{', radius: 99 })).toBe(':host {  }');
		expect(themeCss()).toBe(':host { --ss-font-family: inherit; }');
	});
});
