import { describe, expect, it } from 'vitest';
import { createUseElement } from '../src/adapters/react.js';
import { defineElement } from '../src/element.js';

/**
 * A tiny hooks runtime implementing the slice of React the adapter uses, including StrictMode's
 * "mount → cleanup → mount again" effect replay.
 */
const createFakeReact = () => {
	/** @type {any[]} */
	const slots = [];
	/** @type {Array<() => void>} */
	let effects = [];
	let index = 0;
	let dirty = false;
	const React = {
		/** @param {any} initial */
		useRef: (initial) => (slots[index++] ??= { current: initial }),
		/** @param {(n: number) => number} reducer @param {number} initial @returns {[number, () => void]} */
		useReducer: (reducer, initial) => {
			const slot = (slots[index++] ??= { value: initial });
			return [
				slot.value,
				() => {
					slot.value = reducer(slot.value);
					dirty = true;
				},
			];
		},
		/** @param {(fn: () => void) => () => void} subscribe @param {() => any} getSnapshot */
		useSyncExternalStore: (subscribe, getSnapshot) => {
			const slot = (slots[index++] ??= {});
			if (slot.subscribe !== subscribe) {
				slot.unsubscribe?.();
				slot.subscribe = subscribe;
				slot.unsubscribe = subscribe(() => {
					dirty = true;
				});
			}
			return getSnapshot();
		},
		/** @param {() => void | (() => void)} effect @param {ReadonlyArray<unknown>} deps */
		useEffect: (effect, deps) => {
			const slot = (slots[index++] ??= { effect: true });
			slot.run = effect;
			if (!slot.deps || deps.some((dep, i) => dep !== slot.deps[i])) {
				slot.deps = deps;
				effects.push(() => {
					slot.cleanup?.();
					slot.cleanup = effect();
				});
			}
		},
	};
	/** @template T @param {() => T} component @returns {T} */
	const render = (component) => {
		index = 0;
		effects = [];
		dirty = false;
		const out = component();
		for (const run of effects) run();
		return out;
	};
	const strictReplay = () => {
		for (const slot of slots) {
			if (!slot?.effect) continue;
			slot.cleanup?.();
			slot.cleanup = slot.run();
		}
	};
	const unmount = () => {
		for (const slot of slots) {
			slot?.cleanup?.();
			slot?.unsubscribe?.();
		}
	};
	return { React, render, strictReplay, unmount, isDirty: () => dirty };
};

const counter = defineElement({
	key: 'counter',
	initialState: { count: 0 },
	create: ({ store }) => ({ actions: { inc: () => store.setState((s) => ({ count: s.count + 1 })) } }),
});

describe('createUseElement', () => {
	it('mounts once, re-renders on state change and destroys on unmount', async () => {
		const fake = createFakeReact();
		const useElement = createUseElement(/** @type {any} */ (fake.React));
		const component = () => useElement(counter, { config: {} });
		const first = fake.render(component);
		expect(first.state).toEqual({ count: 0 });
		await first.element.actions.inc?.();
		expect(fake.isDirty()).toBe(true);
		const second = fake.render(component);
		expect(second.element).toBe(first.element);
		expect(second.state).toEqual({ count: 1 });
		fake.unmount();
		expect(first.element.isDestroyed()).toBe(true);
	});

	it('survives StrictMode effect replay by remounting a destroyed instance', () => {
		const fake = createFakeReact();
		const useElement = createUseElement(/** @type {any} */ (fake.React));
		const component = () => useElement(counter);
		const first = fake.render(component);
		fake.strictReplay(); // cleanup destroyed the instance; the replayed effect requests a re-render
		expect(first.element.isDestroyed()).toBe(true);
		expect(fake.isDirty()).toBe(true);
		const next = fake.render(component);
		expect(next.element).not.toBe(first.element);
		expect(next.element.isDestroyed()).toBe(false);
	});

	it('remounts when the definition changes', () => {
		const fake = createFakeReact();
		const useElement = createUseElement(/** @type {any} */ (fake.React));
		const other = defineElement({ key: 'other', initialState: { x: 1 }, create: () => ({}) });
		let definition = counter;
		const component = () => useElement(definition);
		const first = fake.render(component);
		definition = other;
		const second = fake.render(component);
		expect(second.element.key).toBe('other');
		expect(first.element.isDestroyed()).toBe(true);
		expect(second.state).toEqual({ x: 1 });
	});
});
