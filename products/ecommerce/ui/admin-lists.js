/**
 * The list side of the list-and-detail screens of the orders, customers and promotions admin widgets (PLAN 0.6): a
 * head with the list's name, its count as a badge and its main actions; its filters (chips with their counts, selects
 * whose options show counts, a removable chip for a filter set from a detail); the rows page by page with Load more —
 * a status dot, the name, one figure and a line of facts, and a checkbox when the list has bulk actions; and the picked
 * row's detail beside it. With nothing picked the first row opens by itself (a narrow widget keeps showing the list
 * until a row is chosen); an empty list shows a short note in the detail.
 * @module
 */

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-kit.js').Child} Child */
/** @typedef {import('./admin-kit.js').Choice} Choice */
/** @typedef {{ ok: boolean, status: number, data: any }} Answer */

/**
 * Filter chips: one is pressed at a time, and each shows its count as a badge once counts are known.
 * @param {Kit} kit
 * @param {{ label: string, choices: Choice[], value?: string, onChange: (value: string) => void }} options
 */
export const chipFilter = (kit, { label, choices, value = '', onChange }) => {
	let current = value;
	/** @type {Array<{ value: string, button: HTMLElement, badge: HTMLElement }>} */
	const chips = [];
	const node = kit.h('div', { class: 'chipbar', role: 'group', 'aria-label': label });
	const draw = () => {
		for (const chip of chips) chip.button.setAttribute('aria-pressed', String(chip.value === current));
	};
	for (const choice of choices) {
		const badge = kit.h('span', { class: 'count', hidden: '' });
		const button = kit.h('button', { type: 'button', 'data-value': choice.value }, [choice.label, badge]);
		button.addEventListener('click', () => {
			if (current === choice.value) return;
			current = choice.value;
			draw();
			onChange(current);
		});
		chips.push({ value: choice.value, button, badge });
		node.append(button);
	}
	draw();
	return {
		node,
		value: () => current,
		/**
		 * Show the counts: `''` (All) takes the total; unknown counts (a failed call) hide the badges.
		 * @param {Answer} answer of a `counts` route
		 */
		counts: (answer) => {
			for (const chip of chips) {
				const count = answer.ok ? (chip.value === '' ? answer.data.total : (answer.data.groups?.[chip.value] ?? 0)) : null;
				chip.badge.hidden = count === null;
				chip.badge.textContent = count === null ? '' : String(count);
			}
		},
	};
};

/**
 * A select whose options show their counts (`format(label, count)` writes them; All takes the total).
 * @param {Kit} kit
 * @param {Choice[]} choices
 * @param {(label: string, count: number) => string} format
 */
export const countedSelect = (kit, choices, format) => {
	const node = kit.select(choices);
	return {
		node,
		/** @param {Answer} answer of a `counts` route */
		counts: (answer) => {
			for (const option of node.options) {
				const label = choices.find((choice) => choice.value === option.value)?.label ?? option.value;
				const count = answer.ok
					? option.value === ''
						? answer.data.total
						: (answer.data.groups?.[option.value] ?? 0)
					: null;
				option.textContent = typeof count === 'number' ? format(label, count) : label;
			}
		},
	};
};

/**
 * A filter set from a detail (this order's claims, this product's reviews), shown as a removable chip.
 * @param {Kit} kit
 * @param {(value: string) => void} onChange called with '' when the chip is removed
 */
export const scopeChip = (kit, onChange) => {
	let value = '';
	const label = kit.h('span');
	const remove = kit.button('×', () => {
		value = '';
		node.hidden = true;
		onChange('');
	});
	const node = kit.h('ul', { class: 'chips', hidden: '' }, [kit.h('li', {}, [label, remove])]);
	return {
		node,
		value: () => value,
		/** @param {string} next @param {string} text what the chip says @param {string} removeLabel */
		set: (next, text, removeLabel) => {
			value = next;
			label.textContent = text;
			remove.setAttribute('aria-label', removeLabel);
			node.hidden = false;
			onChange(next);
		},
	};
};

/**
 * What a detail gets to work with.
 * @typedef {object} Detail
 * @property {HTMLElement} pane where the item shows
 * @property {HTMLElement} back the Back link (narrow widgets)
 * @property {() => boolean} current whether this item is still the one shown
 * @property {(item: any) => void} changed redraw the item's row after a change and refresh the counts
 * @property {() => Promise<unknown>} reload load the list again (after a delete: the first row opens)
 */

/**
 * @typedef {object} ListSpec
 * @property {string} title the list's heading
 * @property {(cursor: string | null) => string} path the list's address with its filters
 * @property {(item: any) => { name: string, figure?: string, meta?: string, tone?: Tone, toneLabel?: string }} row
 * @property {(item: any, detail: Detail) => unknown} open shows the item in `detail.pane`
 * @property {(item: any) => string} [key] what tells the items apart (default: their `id`)
 * @property {string} empty the status line when nothing matches
 * @property {string} nothing the detail's note while the list is empty
 * @property {Child[]} [actions] the head's actions (the main Add button, a More menu)
 * @property {Child[]} [filters] filters under the head
 * @property {Child[]} [after] shown under the list's status line (results of a bulk action)
 * @property {() => Promise<unknown>} [counts] refreshes the counts; called after each fresh load and change
 * @property {{ label: (item: any) => string, all: string, actions: Child[] }} [bulk] a checkbox on each row (`label`
 *   names the row) with Select all and the bulk actions above the rows
 */

/**
 * A list-and-detail screen in a section panel.
 * @param {Kit} kit @param {HTMLElement} panel @param {ListSpec} spec
 */
export const listScreen = (kit, panel, spec) => {
	const { h, t } = kit;
	const view = kit.splitView();
	const line = kit.status();
	const list = h('ul', { class: 'items' });
	const badge = h('span', { class: 'count', hidden: '' });
	/** @type {Map<string, { item: any, node: HTMLElement, box: HTMLInputElement | null }>} */
	const rows = new Map();
	/** @type {Set<string>} */
	const selected = new Set();
	/** @type {string | null} */
	let cursor = null;
	/** @type {string | null} */
	let currentId = null;
	let opened = 0;
	const keyOf = spec.key ?? ((/** @type {any} */ item) => String(item.id));
	const all = spec.bulk ? kit.check(spec.bulk.all) : null;
	all?.box.addEventListener('change', () => {
		for (const [id, row] of rows) {
			if (!row.box) continue;
			row.box.checked = /** @type {HTMLInputElement} */ (all.box).checked;
			if (row.box.checked) selected.add(id);
			else selected.delete(id);
		}
	});

	/** @param {any} item */
	const rowOf = (item) => {
		const id = keyOf(item);
		const look = spec.row(item);
		/** @type {HTMLInputElement | null} */
		let box = null;
		if (spec.bulk) {
			const pick = kit.input('', { type: 'checkbox', 'aria-label': t('admin.select', { name: spec.bulk.label(item) }) });
			pick.checked = selected.has(id);
			// checking a box does not open the row
			pick.addEventListener('click', (event) => event.stopPropagation());
			pick.addEventListener('keydown', (event) => event.stopPropagation());
			pick.addEventListener('change', () => {
				if (pick.checked) selected.add(id);
				else selected.delete(id);
			});
			box = pick;
		}
		const node = kit.listRow({
			...look,
			lead: box ? h('span', { class: 'lead' }, [box, kit.dot(look.tone ?? 'neutral', look.toneLabel || look.name)]) : null,
			current: id === currentId,
			onPick: () => pick(item, true),
		});
		node.setAttribute('data-id', id);
		return { item, node, box };
	};

	/** @param {any} item */
	const changed = (item) => {
		const id = keyOf(item);
		const old = rows.get(id);
		if (old) {
			const row = rowOf(item);
			old.node.replaceWith(row.node);
			rows.set(id, row);
		}
		void spec.counts?.();
	};

	/** @param {any} item @param {boolean} show open the detail on a narrow widget too */
	const pick = (item, show) => {
		currentId = keyOf(item);
		for (const [id, row] of rows) row.node.setAttribute('aria-current', String(id === currentId));
		if (show) {
			view.show('detail');
			view.detail.focus();
		}
		opened += 1;
		const mine = opened;
		return spec.open(item, {
			pane: view.detail,
			back: view.back,
			current: () => mine === opened,
			changed,
			reload: () => load(true),
		});
	};

	/** @param {boolean} fresh @returns {Promise<Answer>} */
	const load = async (fresh) => {
		const answer = await kit.call('GET', spec.path(fresh ? null : cursor));
		if (fresh) {
			list.replaceChildren();
			rows.clear();
			selected.clear();
			if (all) all.box.checked = false;
		}
		if (!answer.ok) {
			kit.fail(line, answer);
			more.hidden = true;
			return answer;
		}
		cursor = answer.data.nextCursor ?? null;
		/** @type {any[]} */
		const items = answer.data.items ?? [];
		for (const item of items) {
			const row = rowOf(item);
			rows.set(keyOf(item), row);
			list.append(row.node);
		}
		more.hidden = !answer.data.hasMore;
		kit.say(line, fresh && items.length === 0 ? spec.empty : '');
		if (fresh) {
			void spec.counts?.();
			const first = (currentId ? rows.get(currentId)?.item : undefined) ?? items[0];
			if (first) await pick(first, false);
			else {
				currentId = null;
				opened += 1;
				kit.put(view.detail, [view.back, kit.text('p', { class: 'muted empty' }, spec.nothing)]);
				view.show('list');
			}
		}
		return answer;
	};
	const more = kit.button(t('admin.more'), () => load(false));
	more.hidden = true;

	kit.put(view.list, [
		h('div', { class: 'list-head' }, [h('h3', {}, [spec.title, badge]), h('div', { class: 'actions' }, spec.actions ?? [])]),
		...(spec.filters ?? []),
		spec.bulk && all ? h('div', { class: 'selectbar' }, [all.node, h('div', { class: 'actions' }, spec.bulk.actions)]) : null,
		line,
		...(spec.after ?? []),
		list,
		more,
	]);
	panel.append(view.root);

	return {
		view,
		line,
		selected,
		/**
		 * Load the list again, opening the item with this id when it is in it (a new item), else the open one or the first.
		 * @param {string} [id]
		 */
		reload: (id) => {
			if (id) currentId = id;
			return load(true);
		},
		/**
		 * Show the list's count as a badge (capped counts end with `+`; a failed count hides it).
		 * @param {Answer} answer of a `count` route
		 */
		count: (answer) => {
			badge.hidden = !answer.ok;
			badge.textContent = answer.ok ? `${answer.data.count}${answer.data.capped ? '+' : ''}` : '';
		},
	};
};

/**
 * The head of a detail: its title with badges, and its main actions (one or two buttons and the More menu) beside it.
 * @param {Kit} kit @param {Child[]} title @param {Child[]} actions
 */
export const detailHead = (kit, title, actions) =>
	kit.h('div', { class: 'detail-head' }, [kit.h('h3', {}, title), kit.h('div', { class: 'actions' }, actions)]);

/**
 * A card of a detail's masonry: a heading and its content.
 * @param {Kit} kit @param {string} title @param {Child[]} children
 */
export const card = (kit, title, children) => kit.h('section', {}, [kit.text('h4', {}, title), ...children]);

/**
 * Edit a record's tags (E11): one input, the tags separated by commas; `save` gets them trimmed, each once, and answers
 * the refusal to show (null: saved).
 * @param {Kit} kit @param {string[]} tags @param {(tags: string[]) => Promise<string | null>} save
 */
export const tagsDialog = (kit, tags, save) => {
	const input = kit.input(tags.join(', '), { maxlength: '1300', placeholder: kit.t('admin.tagPlaceholder') });
	kit.dialog({
		title: kit.t('admin.editTags'),
		body: [kit.text('p', {}, kit.t('admin.tagsHint')), kit.field(kit.t('admin.tags'), input)],
		submitLabel: kit.t('admin.save'),
		onSubmit: () =>
			save([
				...new Set(
					input.value
						.split(',')
						.map((tag) => tag.trim())
						.filter(Boolean),
				),
			]),
	});
};
