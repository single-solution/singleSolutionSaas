/**
 * Size charts (measurement tables) in the catalog admin widget (feature `size_charts`, PLAN 0.8.10 E5, dynamic model
 * §6) as a list-and-detail screen: each table with how many products, brands and categories use it; its columns (each
 * with its own unit, or the table's) and rows of values in any unit or an own label, the unit shoppers may switch to,
 * advice and notes; an editor for all of it; and Delete, which the server refuses while the table is used (the answer
 * is shown).
 * @module
 */
import { UNIT_KEYS, unitOf } from '../core/units.js';
import { card, createScreen, deleteEntry, detailHead, fieldsOf, masonryOf, readFrom, saveDialog } from './admin-screen.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-taxonomy.js').Lookups} Lookups */
/** @typedef {{ key: string, label: string, unit: string }} Column */
/** @typedef {{ size: string, label: string, values: Record<string, string> }} Row */
/**
 * @typedef {{ id: string, name: string, unit: string, convertTo: string, columns: Column[], rows: Row[], advice: string,
 *   notes: string, active: boolean, uses?: { products: number, brands: number, categories: number } }} Chart
 */

/** Limits of a chart (E5). */
const MAX_COLUMNS = 12;
const MAX_ROWS = 40;

/**
 * A unit as staff read it: a known unit's name, an own label as written, none.
 * @param {Kit} kit @param {string} unit
 */
const unitName = (kit, unit) => (unitOf(unit) ? kit.t(`catalogAdmin.unit.${unit}`) : unit || kit.t('catalogAdmin.noUnit'));

/**
 * A unit field: any text, with the known units offered (`list` names the page's list of them).
 * @param {Kit} kit @param {string} value
 */
const unitInput = (kit, value) => kit.input(value, { maxlength: '20', list: 'ss-chart-units' });

/** The known units offered by unit fields. @param {Kit} kit */
const unitList = (kit) =>
	kit.h(
		'datalist',
		{ id: 'ss-chart-units' },
		UNIT_KEYS.map((key) => kit.h('option', { value: key }, [kit.t(`catalogAdmin.unit.${key}`)])),
	);

/**
 * A column key from its label (lowercase letters, digits and _; starting with a letter), unique among `taken`.
 * @param {string} label @param {Set<string>} taken
 */
export const columnKey = (label, taken) => {
	const slug = label
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 32);
	const base = /^[a-z]/.test(slug) ? slug : `c_${slug}`.replace(/_+$/, '');
	let key = base;
	for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
	taken.add(key);
	return key;
};

/**
 * The chart's table: a column per chart column, a row per size.
 * @param {Kit} kit @param {Chart} chart
 */
const chartTable = (kit, chart) =>
	chart.rows.length === 0
		? kit.text('p', { class: 'muted' }, kit.t('catalogAdmin.chartEmpty'))
		: kit.table(
				[
					kit.t('catalogAdmin.chartSize'),
					...chart.columns.map((column) =>
						column.unit ? kit.t('catalogAdmin.columnWithUnit', { label: column.label, unit: column.unit }) : column.label,
					),
				],
				chart.rows.map((row) => [row.label || row.size, ...chart.columns.map((column) => row.values[column.key] ?? '')]),
			);

/**
 * The chart editor's table: columns (label and key) and rows (size, label and a value per column), each removable,
 * with Add column and Add row.
 * @param {Kit} kit @param {Chart | null} chart
 */
const gridEditor = (kit, chart) => {
	const { t, h } = kit;
	let ids = 0;
	/** @type {Array<{ id: number, key: string, label: HTMLInputElement, unit: HTMLInputElement }>} */
	let columns = (chart?.columns ?? []).map((column) => ({
		id: (ids += 1),
		key: column.key,
		label: kit.input(column.label, { maxlength: '60' }),
		unit: unitInput(kit, column.unit),
	}));
	/** @type {Array<{ size: HTMLInputElement, label: HTMLInputElement, values: Map<number, HTMLInputElement> }>} */
	let rows = [];
	/** @param {Row} row */
	const makeRow = (row) => ({
		size: kit.input(row.size, { maxlength: '60' }),
		label: kit.input(row.label === row.size ? '' : row.label, { maxlength: '60' }),
		values: new Map(),
	});
	rows = (chart?.rows ?? []).map(makeRow);
	/** @param {(typeof rows)[number]} row @param {(typeof columns)[number]} column @param {string} [value] */
	const cell = (row, column, value = '') => {
		const known = row.values.get(column.id);
		if (known) return known;
		const control = kit.input(value, { maxlength: '60' });
		row.values.set(column.id, control);
		return control;
	};
	(chart?.rows ?? []).forEach((row, index) => {
		const entry = /** @type {(typeof rows)[number]} */ (rows[index]);
		for (const column of columns) cell(entry, column, row.values[column.key] ?? '');
	});
	const box = h('div');
	const draw = () => {
		box.replaceChildren(
			kit.group(t('catalogAdmin.chartColumns'), [
				...columns.map((column, index) =>
					h('div', { class: 'row inline' }, [
						kit.field(t('catalogAdmin.columnLabel', { number: index + 1 }), column.label),
						kit.field(t('catalogAdmin.columnUnit', { number: index + 1 }), column.unit),
						kit.button(
							t('admin.remove'),
							() => {
								columns = columns.filter((other) => other !== column);
								draw();
							},
							{ attributes: { 'aria-label': t('catalogAdmin.removeColumn', { number: index + 1 }) } },
						),
					]),
				),
				columns.length < MAX_COLUMNS
					? kit.button(t('catalogAdmin.addColumn'), () => {
							columns.push({
								id: (ids += 1),
								key: '',
								label: kit.input('', { maxlength: '60' }),
								unit: unitInput(kit, ''),
							});
							draw();
						})
					: null,
			]),
			kit.group(t('catalogAdmin.chartRows'), [
				kit.table(
					[
						t('catalogAdmin.chartSize'),
						t('catalogAdmin.chartLabel'),
						...columns.map((column, index) => column.label.value || t('catalogAdmin.columnN', { number: index + 1 })),
						'',
					],
					rows.map((row, index) => [
						withLabel(row.size, t('catalogAdmin.sizeOfRow', { number: index + 1 })),
						withLabel(row.label, t('catalogAdmin.labelOfRow', { number: index + 1 })),
						...columns.map((column, at) =>
							withLabel(
								cell(row, column),
								t('catalogAdmin.cellOf', {
									row: index + 1,
									column: column.label.value || t('catalogAdmin.columnN', { number: at + 1 }),
								}),
							),
						),
						kit.button(
							t('admin.remove'),
							() => {
								rows = rows.filter((other) => other !== row);
								draw();
							},
							{ attributes: { 'aria-label': t('catalogAdmin.removeRow', { number: index + 1 }) } },
						),
					]),
				),
				rows.length < MAX_ROWS
					? kit.button(t('catalogAdmin.addRow'), () => {
							rows.push(makeRow({ size: '', label: '', values: {} }));
							draw();
						})
					: null,
			]),
		);
	};
	/** @param {HTMLInputElement} control @param {string} label */
	const withLabel = (control, label) => {
		control.setAttribute('aria-label', label);
		return control;
	};
	box.addEventListener('change', (event) => {
		if (columns.some((column) => column.label === event.target)) draw();
	});
	draw();
	return {
		node: box,
		/** @returns {{ columns: Column[], rows: Row[] }} */
		value: () => {
			const taken = new Set(columns.map((column) => column.key).filter(Boolean));
			const keyed = columns
				.filter((column) => column.label.value.trim())
				.map((column) => ({ column, key: column.key || columnKey(column.label.value.trim(), taken) }));
			return {
				columns: keyed.map(({ column, key }) => ({ key, label: column.label.value.trim(), unit: column.unit.value.trim() })),
				rows: rows
					.filter((row) => row.size.value.trim())
					.map((row) => ({
						size: row.size.value.trim(),
						label: row.label.value.trim() || row.size.value.trim(),
						values: Object.fromEntries(
							keyed
								.map(({ column, key }) => [key, (row.values.get(column.id)?.value ?? '').trim()])
								.filter(([, value]) => value),
						),
					})),
			};
		},
	};
};

/** @param {Kit} kit @param {HTMLElement} panel @param {Lookups} lookups */
export const chartsTab = (kit, panel, lookups) => {
	const { t, h } = kit;
	const path = '/v1/admin/size-charts';
	let needle = '';
	/** @type {Chart[]} */
	let all = [];
	/** @param {string | null} [pick] */
	const show = (pick = null) => {
		const shown = all.filter((item) => !needle || item.name.toLowerCase().includes(needle));
		screen.set(shown, pick);
		kit.say(screen.line, all.length === 0 ? t('catalogAdmin.noCharts') : shown.length === 0 ? t('admin.noMatches') : '');
	};
	/** @param {string | null} [pick] */
	const load = async (pick = null) => {
		const answer = await kit.call('GET', path);
		if (!answer.ok) return kit.fail(screen.line, answer);
		all = answer.data.items ?? [];
		show(pick);
		return answer;
	};
	/** @param {any} saved */
	const after = async (saved) => {
		await Promise.all([lookups.reload(), load(saved.id)]);
	};
	/** @param {Chart} chart */
	const usesText = (chart) =>
		t('catalogAdmin.chartUses', {
			products: chart.uses?.products ?? 0,
			brands: chart.uses?.brands ?? 0,
			categories: chart.uses?.categories ?? 0,
		});

	/** @param {Chart | null} chart */
	const edit = (chart) => {
		const name = kit.input(chart?.name ?? '', { maxlength: '120', required: '' });
		const unit = unitInput(kit, chart?.unit ?? '');
		const convertTo = kit.select(
			[
				{ value: '', label: t('catalogAdmin.noSwitch') },
				...UNIT_KEYS.map((key) => ({ value: key, label: t(`catalogAdmin.unit.${key}`) })),
			],
			chart?.convertTo ?? '',
		);
		const active = kit.check(t('catalogAdmin.chartActive'), chart?.active !== false);
		const grid = gridEditor(kit, chart);
		const advice = kit.area(chart?.advice ?? '', { rows: '3', maxlength: '2000' });
		const notes = kit.area(chart?.notes ?? '', { rows: '3', maxlength: '2000' });
		saveDialog(kit, {
			title: chart ? t('admin.editing', { name: chart.name }) : t('catalogAdmin.newChart'),
			wide: true,
			path,
			id: chart?.id ?? null,
			body: [
				fieldsOf(kit, [
					kit.field(t('catalogAdmin.name'), name),
					kit.field(t('catalogAdmin.chartUnit'), unit),
					kit.field(t('catalogAdmin.chartConvertTo'), convertTo),
					active.node,
				]),
				unitList(kit),
				grid.node,
				kit.field(t('catalogAdmin.advice'), advice),
				kit.field(t('catalogAdmin.chartNotes'), notes),
			],
			value: () => {
				const { columns, rows } = grid.value();
				if (columns.length === 0) return t('catalogAdmin.chartNeedsColumns');
				return {
					name: name.value,
					unit: unit.value.trim(),
					convertTo: convertTo.value,
					active: active.box.checked,
					columns,
					rows,
					advice: advice.value,
					notes: notes.value,
				};
			},
			saved: after,
		});
	};

	const screen = createScreen(kit, panel, {
		tools: [
			h('div', { class: 'tools' }, [
				(() => {
					const search = kit.input('', { type: 'search', placeholder: t('catalogAdmin.searchList') });
					search.addEventListener('input', () => {
						needle = search.value.trim().toLowerCase();
						show();
					});
					return kit.field(t('admin.search'), search);
				})(),
				kit.button(t('catalogAdmin.newChart'), () => edit(null), { primary: true }),
			]),
		],
		empty: t('catalogAdmin.noCharts'),
		read: readFrom(kit, path),
		idOf: (chart) => chart.id,
		row: (chart) => ({
			name: chart.name,
			tone: chart.active === false ? 'neutral' : 'success',
			toneLabel: t(chart.active === false ? 'catalogAdmin.inactive' : 'catalogAdmin.active'),
			figure: unitName(kit, chart.unit),
			meta: usesText(chart),
		}),
		detail: (chart) => [
			detailHead(kit, {
				title: chart.name,
				badges: [
					kit.badge(
						t(chart.active === false ? 'catalogAdmin.inactive' : 'catalogAdmin.active'),
						chart.active === false ? 'neutral' : 'success',
					),
				],
				actions: [kit.button(t('admin.edit'), () => edit(chart), { primary: true })],
				more: [
					deleteEntry(kit, {
						name: chart.name,
						path: `${path}/${chart.id}`,
						done: () => after({ id: null }),
						note: t('catalogAdmin.deleteChartNote'),
					}),
				],
			}),
			kit.fieldGrid([
				[t('catalogAdmin.chartUnit'), unitName(kit, chart.unit)],
				[t('catalogAdmin.chartConvertTo'), chart.convertTo ? unitName(kit, chart.convertTo) : t('catalogAdmin.noSwitch')],
				[t('catalogAdmin.usedBy'), usesText(chart)],
				[t('catalogAdmin.chartSizes'), String(chart.rows.length)],
			]),
			masonryOf(kit, [
				card(kit, t('catalogAdmin.chartTable'), [chartTable(kit, chart)]),
				chart.advice ? card(kit, t('catalogAdmin.advice'), [kit.text('p', { class: 'prose' }, chart.advice)]) : null,
				chart.notes ? card(kit, t('catalogAdmin.chartNotes'), [kit.text('p', { class: 'prose' }, chart.notes)]) : null,
			]),
		],
	});
	void load();
};
