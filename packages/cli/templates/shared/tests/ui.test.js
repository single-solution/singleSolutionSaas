import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNotes } from '../headless/notes.js';
import { render, styles } from '../ui/notes.js';
import { createFakeDom, createMemoryClient, findAll } from './helpers.js';

const strings = JSON.parse(readFileSync(new URL('../strings/en.json', import.meta.url), 'utf8'));

describe('ui/notes renderer', () => {
	it('renders an accessible region wired to headless actions', async () => {
		const notes = createNotes({ strings, client: createMemoryClient() });
		await notes.actions.load();
		const dom = createFakeDom();
		const empty = render({ state: notes.state(), actions: notes.actions, strings, dom });
		assert.equal(empty.attributes.role, 'region');
		assert.equal(empty.attributes['aria-label'], 'Notes');
		assert.equal(findAll(empty, (node) => node.attributes?.class === 'ss-notes__empty').length, 1);

		const [input] = findAll(empty, (node) => node.tag === 'input');
		input.dispatch('input', { target: { value: 'hello' } });
		const [form] = findAll(empty, (node) => node.tag === 'form');
		let prevented = false;
		form.dispatch('submit', { preventDefault: () => (prevented = true) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(prevented, true);
		assert.equal(notes.state().notes.length, 1);

		const list = render({ state: notes.state(), actions: notes.actions, strings, theme: { variant: 'compact' }, dom });
		assert.match(list.attributes.class, /ss-notes--compact/);
		const items = findAll(list, (node) => node.tag === 'li');
		assert.equal(items.length, 1);
		assert.equal(findAll(list, (node) => node.tag === 'time').length, 1);
	});

	it('uses design tokens only', () => {
		assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
		assert.match(styles, /var\(--ss-color-text\)/);
	});
});
