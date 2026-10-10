/**
 * The list-and-detail screens of the catalog admin widget (PLAN 0.6): a rich list (its tools on top: search, filters
 * and the main Add action; per row the name, a status dot and one figure) beside the picked item's detail. With nothing
 * picked the first item opens in the detail pane, which a wide widget shows beside the list (a narrow one keeps the
 * list until an item is picked, then shows it alone with Back). A detail has a head (title, badges, one or two main
 * buttons and the More menu, a destructive action last behind a typed confirmation) and its facts and cards below.
 * @module
 */

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-kit.js').Child} Child */
/** @typedef {import('./admin-kit.js').Tone} Tone */
/** @typedef {{ label: string, onSelect: () => unknown, danger?: boolean }} MoreEntry */
/**
 * What a list row shows.
 * @typedef {{ name: string, figure?: string, meta?: string, tone?: Tone, toneLabel?: string, lead?: Child,
 *   depth?: number }} RowSpec
 */

/**
 * A list-and-detail screen in a section panel. With `read`, an opened item is read again (the list's record shows
 * when the read is refused) and its row follows the fresh record.
 * @template T
 * @param {Kit} kit
 * @param {HTMLElement} panel
 * @param {{ tools: Child[], empty: string, idOf: (item: T) => string, row: (item: T) => RowSpec,
 *   detail: (item: T) => Child[], read?: (item: T) => Promise<T | null> }} spec
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

	const draw = () =>
		list.replaceChildren(
			...items.map((item) => {
				const { depth = 0, ...row } = spec.row(item);
				const node = kit.listRow({ ...row, current: spec.idOf(item) === current, onPick: () => open(item, true) });
				if (depth > 0) node.style.paddingLeft = `${8 + depth * 16}px`;
				return node;
			}),
		);

	/**
	 * Show an item in the detail pane (or the empty state).
	 * @param {T | null} item @param {boolean} [picked] the person picked it (a narrow widget then shows it alone)
	 */
	const open = (item, picked = false) => {
		current = item === null ? null : spec.idOf(item);
		draw();
		if (item === null || !spec.read)
			kit.put(view.detail, [
				view.back,
				...(item === null ? [kit.text('p', { class: 'muted' }, spec.empty)] : spec.detail(item)),
			]);
		else {
			const id = spec.idOf(item);
			kit.put(view.detail, [view.back, kit.text('p', { class: 'muted' }, kit.t('catalogAdmin.loading'))]);
			void spec.read(item).then((fresh) => {
				if (current !== id) return;
				const shown = fresh ? { ...item, ...fresh } : item;
				items = items.map((other) => (spec.idOf(other) === id ? shown : other));
				draw();
				kit.put(view.detail, [view.back, ...spec.detail(shown)]);
			});
		}
		if (picked) view.show('detail');
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
			open(found, pick !== null && found !== null && spec.idOf(found) === pick);
		},
		/** Add more items at the end (Load more). @param {T[]} more */
		append: (more) => {
			items = [...items, ...more];
			draw();
		},
		/** Show something else in the detail pane (a form for a new item). @param {Child[]} nodes */
		show: (nodes) => {
			current = null;
			draw();
			kit.put(view.detail, [view.back, ...nodes]);
			view.show('detail');
		},
		/** Change one listed item (after its detail changed it), keeping the detail as it is. @param {T} item */
		replace: (item) => {
			items = items.map((other) => (spec.idOf(other) === spec.idOf(item) ? item : other));
			draw();
		},
		/** Redraw the rows (a selection changed). */
		redraw: draw,
		items: () => items,
		current: () => current,
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
