/**
 * The list-and-detail screens of the admin widgets (PLAN 0.6): a rich list (its tools on top: search, filters and the
 * main Add action; per row the name, a status dot and one figure) beside the picked item's detail. With nothing
 * picked the first item opens in the detail pane, which a wide widget shows beside the list (a narrow one keeps the
 * list until an item is picked, then shows it alone with Back). A detail has a head (title, badges, one or two main
 * buttons and the More menu, a destructive action last behind a typed confirmation) and its facts and cards below.
 * `createScreen` is the screen; `listScreen` is one whose list the server pages and counts (filter chips with counts,
 * Load more, a checkbox on each row for bulk actions), as the orders, customers, returns, reviews and offers are.
 * @module
 */

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Child} Child */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {import('./admin-kit.js').Choice} Choice */
/** @typedef {{ ok: boolean, status: number, data: any }} Answer */
/** @typedef {{ label: string, onSelect: () => unknown, danger?: boolean }} MoreEntry */
/**
 * What a list row shows.
 * @typedef {{ name: string, figure?: string, meta?: string, tone?: Tone, toneLabel?: string, lead?: Child,
 *   depth?: number }} RowSpec
 */
/**
 * What a detail gets to work with.
 * @typedef {object} Pane
 * @property {HTMLElement} pane where the item shows
 * @property {HTMLElement} back the Back link (narrow widgets)
 * @property {() => boolean} current whether this item is still the one shown
 * @property {(item: any) => void} changed redraw the item's row after a change
 */
/**
 * What a detail of a `listScreen` gets: the pane, and the list to load again.
 * @typedef {Pane & { reload: () => Promise<unknown> }} Detail `reload`: after a delete the first row opens
 */

/**
 * A list-and-detail screen in a section panel. The detail is shown by `open(item, detail)`, which puts the item in
 * `detail.pane` itself (a detail that changes puts itself again), or by `detail(item)` giving its nodes — with `read`,
 * an opened item is read again (the list's record shows when the read is refused) and its row follows the fresh record.
 * @template T
 * @param {Kit} kit
 * @param {HTMLElement} panel
 * @param {{ tools: Child[], empty: string, idOf: (item: T) => string, row: (item: T) => RowSpec,
 *   open?: (item: T, pane: Pane) => unknown, detail?: (item: T) => Child[], read?: (item: T) => Promise<T | null> }} spec
 *   `empty`: the detail's note while the list is empty
 */
export const createScreen = (kit, panel, spec) => {
	const view = kit.splitView();
	const line = kit.status();
	const list = kit.h('ul', { class: 'items' });
	const tail = kit.h('div');
	view.list.append(
		.../** @type {Array<Node | string>} */ (spec.tools.filter((tool) => tool !== null && tool !== undefined && tool !== false)),
		line,
		list,
		tail,
	);
	panel.append(view.root);
	/** @type {T[]} */
	let items = [];
	/** @type {string | null} */
	let current = null;
	let opened = 0;

	const draw = () =>
		list.replaceChildren(
			...items.map((item) => {
				const { depth = 0, ...row } = spec.row(item);
				const id = spec.idOf(item);
				const node = kit.listRow({ ...row, current: id === current, onPick: () => open(item, true) });
				node.setAttribute('data-id', id);
				if (depth > 0) node.style.paddingLeft = `${8 + depth * 16}px`;
				return node;
			}),
		);

	/** Change one listed item, keeping the detail as it is. @param {T} item */
	const replace = (item) => {
		items = items.map((other) => (spec.idOf(other) === spec.idOf(item) ? item : other));
		draw();
	};

	/**
	 * Show an item in the detail pane (or the empty state); answers when its detail is shown.
	 * @param {T | null} item @param {boolean} [picked] the person picked it (a narrow widget then shows it alone)
	 */
	const open = (item, picked = false) => {
		current = item === null ? null : spec.idOf(item);
		draw();
		opened += 1;
		const mine = opened;
		if (item === null) {
			kit.put(view.detail, [view.back, kit.emptyState(spec.empty)]);
			view.show('list');
			return undefined;
		}
		if (picked) {
			view.show('detail');
			view.detail.focus();
		}
		/** @type {Pane} */
		const pane = { pane: view.detail, back: view.back, current: () => mine === opened, changed: replace };
		return spec.open ? spec.open(item, pane) : showNodes(item, pane);
	};

	/** The nodes `detail` gives, after a fresh `read` when there is one. @param {T} item @param {Pane} pane */
	const showNodes = (item, pane) => {
		const detailOf = /** @type {(item: T) => Child[]} */ (spec.detail);
		if (!spec.read) return kit.put(pane.pane, [pane.back, ...detailOf(item)]);
		kit.put(pane.pane, [pane.back, kit.loadingState(kit.t('catalogAdmin.loading'))]);
		return spec.read(item).then((fresh) => {
			if (!pane.current()) return;
			const shown = fresh ? { ...item, ...fresh } : item;
			replace(shown);
			kit.put(pane.pane, [pane.back, ...detailOf(shown)]);
		});
	};

	return {
		view,
		line,
		list,
		tail,
		open,
		/**
		 * Replace the list; the picked item stays open (redrawn from the new list) when it is still there, else `pick`
		 * opens, else the first item.
		 * @param {T[]} next @param {string | null} [pick]
		 */
		set: (next, pick = null) => {
			items = next;
			const wanted = pick ?? current;
			const found = items.find((item) => spec.idOf(item) === wanted) ?? items[0] ?? null;
			return open(found, pick !== null && found !== null && spec.idOf(found) === pick);
		},
		/** Add more items at the end (Load more). @param {T[]} more */
		append: (more) => {
			items = [...items, ...more];
			draw();
		},
		/** Show something else in the detail pane (a form for a new item). @param {Child[]} nodes */
		show: (nodes) => {
			current = null;
			opened += 1;
			draw();
			kit.put(view.detail, [view.back, ...nodes]);
			view.show('detail');
		},
		/** Change one listed item (after its detail changed it), keeping the detail as it is. */
		replace,
		/** Redraw the rows (a selection changed). */
		redraw: draw,
		items: () => items,
		current: () => current,
	};
};

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
 * A screen whose list the server pages and counts: a head with the list's name, its count as a badge and its main
 * actions, its filters, the rows page by page with Load more, and a checkbox on each row when the list has bulk actions.
 * @param {Kit} kit @param {HTMLElement} panel @param {ListSpec} spec
 */
export const listScreen = (kit, panel, spec) => {
	const { h, t } = kit;
	const badge = h('span', { class: 'count', hidden: '' });
	/** @type {Set<string>} */
	const selected = new Set();
	/** @type {string | null} */
	let cursor = null;
	const keyOf = spec.key ?? ((/** @type {any} */ item) => String(item.id));
	const all = spec.bulk ? kit.check(spec.bulk.all) : null;
	const more = kit.button(t('admin.more'), () => load(false));
	more.hidden = true;

	const screen = createScreen(kit, panel, {
		tools: [
			h('div', { class: 'list-head' }, [h('h3', {}, [spec.title, badge]), h('div', { class: 'actions' }, spec.actions ?? [])]),
			...(spec.filters ?? []),
			spec.bulk && all
				? h('div', { class: 'selectbar' }, [all.node, h('div', { class: 'actions' }, spec.bulk.actions)])
				: null,
		],
		empty: spec.nothing,
		idOf: keyOf,
		row: (item) => {
			const look = spec.row(item);
			const { bulk } = spec;
			if (!bulk) return look;
			const id = keyOf(item);
			const pick = kit.input('', { type: 'checkbox', 'aria-label': t('admin.select', { name: bulk.label(item) }) });
			pick.checked = selected.has(id);
			// checking a box does not open the row
			pick.addEventListener('click', (event) => event.stopPropagation());
			pick.addEventListener('keydown', (event) => event.stopPropagation());
			pick.addEventListener('change', () => {
				if (pick.checked) selected.add(id);
				else selected.delete(id);
			});
			return {
				...look,
				lead: h('span', { class: 'lead' }, [pick, kit.dot(look.tone ?? 'neutral', look.toneLabel || look.name)]),
			};
		},
		open: (item, pane) =>
			spec.open(item, {
				...pane,
				changed: (changed) => {
					pane.changed(changed);
					void spec.counts?.();
				},
				reload: () => load(true),
			}),
	});
	screen.tail.append(more);
	screen.line.after(.../** @type {Array<Node | string>} */ ((spec.after ?? []).filter(Boolean)));
	all?.box.addEventListener('change', () => {
		for (const item of screen.items()) {
			if (/** @type {HTMLInputElement} */ (all.box).checked) selected.add(keyOf(item));
			else selected.delete(keyOf(item));
		}
		screen.redraw();
	});

	/** @param {boolean} fresh @param {string | null} [pick] the item to open (a new one) @returns {Promise<Answer>} */
	const load = async (fresh, pick = null) => {
		const answer = await kit.call('GET', spec.path(fresh ? null : cursor));
		if (fresh) {
			selected.clear();
			if (all) all.box.checked = false;
		}
		if (!answer.ok) {
			if (fresh) screen.set([]);
			kit.fail(screen.line, answer);
			more.hidden = true;
			return answer;
		}
		cursor = answer.data.nextCursor ?? null;
		/** @type {any[]} */
		const items = answer.data.items ?? [];
		more.hidden = !answer.data.hasMore;
		kit.say(screen.line, fresh && items.length === 0 ? spec.empty : '');
		if (!fresh) screen.append(items);
		else {
			void spec.counts?.();
			await screen.set(items, pick);
		}
		return answer;
	};

	return {
		line: screen.line,
		selected,
		/**
		 * Load the list again, opening the item with this id when it is in it (a new item), else the open one or the first.
		 * @param {string} [id]
		 */
		reload: (id) => load(true, id ?? null),
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
 * A `read` of a list-and-detail screen: the record at `<path>/<id>`, or null when it cannot be read.
 * @template {{ id: string }} T
 * @param {Kit} kit @param {string} path
 * @returns {(item: T) => Promise<T | null>}
 */
export const readFrom = (kit, path) => async (item) => {
	const answer = await kit.call('GET', `${path}/${item.id}`);
	return answer.ok ? answer.data : null;
};

/**
 * The head of a detail: the title with its badges, the main buttons and the More menu.
 * @param {Kit} kit
 * @param {{ title: string, badges?: Child[], actions?: Child[], more?: Array<MoreEntry | null | false> }} options
 */
export const detailHead = (kit, { title, badges = [], actions = [], more = [] }) =>
	kit.h('div', { class: 'detail-head' }, [
		kit.h('h3', {}, [kit.text('span', { class: 'name', title }, title), ...badges]),
		kit.h('div', { class: 'actions' }, [...actions, kit.moreMenu(more)]),
	]);

/**
 * A card of a detail's masonry: a heading with its actions, then its content.
 * @param {Kit} kit @param {string} title @param {Child[]} children @param {Child[]} [actions]
 */
export const card = (kit, title, children, actions = []) =>
	kit.h('section', { 'aria-label': title }, [
		kit.h('div', { class: 'card-head' }, [kit.text('h4', {}, title), ...actions]),
		...children,
	]);

/**
 * The More menu's Delete: a dialog asking to type the name; `done` runs after the record is deleted.
 * @param {Kit} kit
 * @param {{ name: string, path: string, done: () => unknown, note?: string }} options
 * @returns {MoreEntry}
 */
export const deleteEntry = (kit, { name, path, done, note }) => ({
	label: kit.t('admin.delete'),
	danger: true,
	onSelect: () =>
		kit.dialog({
			title: kit.t('catalogAdmin.deleteTitle', { name }),
			body: [kit.text('p', {}, note ?? kit.t('catalogAdmin.deleteNote'))],
			submitLabel: kit.t('admin.delete'),
			danger: true,
			confirmText: name,
			onSubmit: async () => {
				const answer = await kit.call('DELETE', path);
				if (!answer.ok) return kit.reason(answer);
				await done();
				return null;
			},
		}),
});

/**
 * A dialog that saves a record (POST for a new one, PATCH for a change); `saved` gets the answer's record.
 * @param {Kit} kit
 * @param {{ title: string, body: Child[], path: string, id: string | null, wide?: boolean,
 *   value: () => Record<string, unknown> | string, saved: (record: any) => unknown }} options `value` answers the body,
 *   or a text saying what to fix
 */
export const saveDialog = (kit, { title, body, path, id, wide = false, value, saved }) =>
	kit.dialog({
		title,
		body,
		wide,
		submitLabel: kit.t('admin.save'),
		onSubmit: async () => {
			const sent = value();
			if (typeof sent === 'string') return sent;
			const answer = await kit.call(id ? 'PATCH' : 'POST', id ? `${path}/${id}` : path, sent);
			if (!answer.ok) return kit.reason(answer);
			await saved(answer.data);
			return null;
		},
	});

/**
 * A masonry of the cards given (empty entries left out).
 * @param {Kit} kit @param {Child[]} cards
 */
export const masonryOf = (kit, cards) =>
	kit.masonry(cards.filter((entry) => entry !== null && entry !== undefined && entry !== false));

/**
 * A grid of short fields (1 to 3 columns by the form's width).
 * @param {Kit} kit @param {Child[]} children
 */
export const fieldsOf = (kit, children) => kit.h('div', { class: 'fields' }, children);

/**
 * Yes or No for people.
 * @param {Kit} kit @param {boolean | null | undefined} value
 */
export const yesNo = (kit, value) => kit.t(value ? 'admin.yes' : 'admin.no');

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
