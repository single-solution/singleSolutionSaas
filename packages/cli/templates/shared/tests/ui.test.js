import { describe, it } from 'vitest';
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

	it('renders pinned notes, slots, loading and errors, and forwards pin and remove', () => {
		/** @type {string[]} */
		const calls = [];
		const actions = /** @type {any} */ ({
			setDraft: () => undefined,
			add: () => undefined,
			togglePin: (/** @type {string} */ id) => calls.push(`pin:${id}`),
			remove: (/** @type {string} */ id) => calls.push(`remove:${id}`),
		});
		const dom = createFakeDom();
		const note = { id: 'n1', text: 'Hi', pinned: true, createdAt: '2026-10-01T10:00:00.000Z' };
		const state = /** @type {any} */ ({
			status: 'loading',
			notes: [note],
			draft: '',
			canAdd: false,
			showTimestamps: false,
			error: 'Something went wrong',
		});
		const before = dom.createElement('div');
		const after = dom.createElement('div');
		const view = render({ state, actions, strings, slots: { before, after }, dom });
		assert.equal(view.children[0], before);
		assert.equal(view.children.at(-1), after);
		assert.equal(findAll(view, (node) => node.attributes?.class === 'ss-notes__loading').length, 1);
		assert.equal(findAll(view, (node) => node.tag === 'time').length, 0);
		const [submit] = findAll(view, (node) => node.attributes?.type === 'submit');
		assert.equal(submit.attributes.disabled, '');
		const [pin] = findAll(view, (node) => node.attributes?.class === 'ss-notes__pin');
		assert.equal(pin.attributes['aria-pressed'], 'true');
		pin.dispatch('click');
		findAll(view, (node) => node.attributes?.class === 'ss-notes__remove')[0].dispatch('click');
		assert.deepEqual(calls, ['pin:n1', 'remove:n1']);
		const [status] = findAll(view, (node) => node.attributes?.role === 'status');
		assert.equal(status.children.length, 1);

		const empty = dom.createElement('p');
		const ready = render({
			state: { ...state, status: 'ready', notes: [], error: null },
			actions,
			strings,
			slots: { empty },
			dom,
		});
		assert.equal(findAll(ready, (node) => node === empty).length, 1);
		assert.equal(findAll(ready, (node) => node.attributes?.class === 'ss-notes__loading').length, 0);
	});

	it('uses design tokens only', () => {
		assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
		assert.match(styles, /var\(--ss-color-text\)/);
	});
});
