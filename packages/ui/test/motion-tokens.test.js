import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');

/** The text of the first `@media (prefers-reduced-motion: reduce)` blocks, joined. */
const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');

describe('motion tokens (layout contract item 12)', () => {
	it('defines the three durations and the one easing', () => {
		expect(css).toMatch(/--dur-fast:\s*120ms/);
		expect(css).toMatch(/--dur:\s*160ms/);
		expect(css).toMatch(/--dur-slow:\s*220ms/);
		expect(css).toMatch(/--ease:\s*cubic-bezier\(0\.2,\s*0\.8,\s*0\.2,\s*1\)/);
	});

	it('points the older motion names at the new tokens, so every curve is the one easing', () => {
		expect(css).toMatch(/--ss-motion:\s*var\(--dur\)/);
		expect(css).toMatch(/--ss-motion-fast:\s*var\(--dur-fast\)/);
		expect(css).toMatch(/--ss-motion-slow:\s*var\(--dur-slow\)/);
		for (const name of ['--ss-ease', '--ss-ease-move', '--ss-ease-exit'])
			expect(css).toMatch(new RegExp(`${name}:\\s*var\\(--ease\\)`));
	});

	it('enters with a fade and a 4px rise, and opens menus from scale .98', () => {
		expect(css).toMatch(/@keyframes ss-enter \{\s*from \{\s*opacity: 0;\s*translate: 0 4px;/);
		expect(css).toMatch(/@keyframes ss-pop \{\s*from \{\s*opacity: 0;\s*scale: 0\.98;/);
	});

	it('moves nothing but opacity with prefers-reduced-motion', () => {
		for (const name of ['ss-enter', 'ss-pop', 'ss-sheet', 'ss-drawer', 'ss-side', 'ss-toast', 'ss-pop-out', 'ss-side-out'])
			expect(reduced).toMatch(new RegExp(`@keyframes ${name} \\{[^}]*\\{[^}]*opacity: 0;\\s*\\}`));
		expect(reduced).not.toMatch(/translate:\s*[-\d]/);
		expect(reduced).not.toMatch(/scale:\s*0/);
		expect(reduced).toMatch(/ss-press/);
	});
});

describe('the Page fills the pane', () => {
	it('lets a wrapper around a page (the page transition) pass the pane height on', () => {
		expect(css).toMatch(/\[data-ss-transition\]:has\(\[data-ss-page\]\)/);
	});
});
