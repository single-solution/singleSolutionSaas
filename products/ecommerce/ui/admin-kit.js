/**
 * What the admin widgets share (PLAN 0.4.5, 0.4.10): the widget shell with its `Signed out` line, widget texts with
 * `{placeholders}`, money in the shop currency (decimals in inputs, minor units on the wire), calls with the ticket
 * (JSON, and plain text for CSV files and printable documents), problem texts (a 403 means the ticket's permissions do
 * not allow it), and small builders: labelled fields, tables, tabs, paged lists, id pickers, two-step buttons and
 * uploads to presigned addresses. Text is always set as text, never as HTML.
 * @module
 */
import { mountWidget } from '@ss/app-kit/widget';
import { formatMoney, fromDecimal, toDecimal } from '../core/money.js';
import { ADMIN_CSS } from './admin-styles.js';
import { element } from './dom.js';
import { WIDGET_CSS } from './styles.js';
import { adminCall } from './tickets.js';

/** @typedef {{ ok: boolean, status: number, data: any }} Answer status 0 when signed out or unreachable */
/** @typedef {Node | string | null | undefined | false} Child */
/** @typedef {{ value: string, label: string }} Choice */

const DAY_MS = 86_400_000;

/**
 * A text with its `{placeholders}` filled.
 * @param {string} text
 * @param {Record<string, string | number>} values
 */
const fill = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));

/**
 * The start of a day (`YYYY-MM-DD` from a date input) as ISO-8601, or ''.
 * @param {string} value
 */
export const dayStart = (value) => {
	const time = Date.parse(`${value}T00:00:00.000Z`);
	return value && !Number.isNaN(time) ? new Date(time).toISOString() : '';
};

/**
 * The end of a day (the next day's start, for filters whose end is exclusive) as ISO-8601, or ''.
 * @param {string} value
 */
export const dayEnd = (value) => {
	const start = dayStart(value);
	return start ? new Date(Date.parse(start) + DAY_MS).toISOString() : '';
};

/**
 * An ISO-8601 time as the value of a `datetime-local` input (the browser's time zone), or ''.
 * @param {string | null | undefined} iso
 */
export const localInput = (iso) => {
	const date = new Date(iso ?? '');
	if (!iso || Number.isNaN(date.getTime())) return '';
	const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * A `datetime-local` value as ISO-8601, or null when empty or not a time.
 * @param {string} value
 */
export const fromLocal = (value) => {
	const time = new Date(value).getTime();
	return value && !Number.isNaN(time) ? new Date(time).toISOString() : null;
};

/**
 * A query string of the given values (empty values left out), with its `?`.
 * @param {Record<string, string | number | boolean | null | undefined>} values
 */
export const query = (values) => {
	const out = new URLSearchParams();
	for (const [name, value] of Object.entries(values))
		if (value !== '' && value !== null && value !== undefined && value !== false) out.set(name, String(value));
	const text = out.toString();
	return text ? `?${text}` : '';
};

/**
 * The entries of a list typed in a box: one per line (or also split by commas), trimmed, without blanks.
 * @param {string} text
 * @param {boolean} [commas]
 */
export const entriesOf = (text, commas = false) =>
	text
		.split(commas ? /[\r\n,]+/ : /\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean);

/**
 * A whole number typed in an input, null when empty, NaN when not a whole number.
 * @param {string} text
 */
export const wholeOf = (text) => {
	const value = text.trim();
	if (value === '') return null;
	return /^-?\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
};

/**
 * @typedef {object} AdminInput
 * @property {HTMLElement} root
 * @property {import('./widget.js').WidgetConfig} config
 * @property {import('./tickets.js').AdminApi} api
 * @property {Window & typeof globalThis} win
 * @property {(name: string, text: string, type?: string) => void} save hand a file to the browser
 * @property {(url: string) => void} open open an address in a new tab
 */

/**
 * The helpers of one mounted admin widget.
 * @param {AdminInput} input
 */
const createKit = ({ root, config, api, win, save, open }) => {
	const doc = /** @type {Document} */ (root.ownerDocument);
	const currency = String(config.settings?.currency ?? '');
	/** @type {string[]} */
	const blobs = [];
	let ids = 0;

	/** @param {string} key @param {Record<string, string | number>} [values] */
	const t = (key, values = {}) => fill(config.texts[key] ?? key, values);
	/** @param {string} feature */
	const has = (feature) => config.features.includes(feature);

	// ------------------------------------------------------------------------------------------------- money

	/** An amount for people. @param {number | null | undefined} minor */
	const money = (minor) => (typeof minor === 'number' ? formatMoney(minor, currency) : '');
	/** An amount in an input. @param {number | null | undefined} minor */
	const decimal = (minor) => (typeof minor === 'number' ? toDecimal(minor, currency) : '');
	/**
	 * An amount typed in an input: minor units, 0, null when empty, NaN when it is not an amount.
	 * @param {string} text
	 */
	const amount = (text) => {
		const value = text.trim();
		if (value === '') return null;
		if (/^0+(\.0+)?$/.test(value)) return 0;
		return fromDecimal(value, currency) ?? Number.NaN;
	};

	// ------------------------------------------------------------------------------------------------- calls

	/**
	 * A JSON call with the ticket.
	 * @param {string} method @param {string} path @param {unknown} [body]
	 * @returns {Promise<Answer>}
	 */
	const call = (method, path, body) => adminCall(api, method, path, body);

	/**
	 * A GET whose answer is a file (CSV, a printable page) with the ticket.
	 * @param {string} path
	 * @returns {Promise<{ ok: boolean, status: number, text: string, data: any }>}
	 */
	const fetchText = async (path) => {
		const ticket = api.tickets.current();
		if (!ticket) return { ok: false, status: 0, text: '', data: null };
		try {
			const response = await api.fetch(`${api.base}${path}`, {
				method: 'GET',
				headers: { authorization: `Bearer ${ticket}` },
			});
			// keep a byte order mark (spreadsheets read CSV files as UTF-8 by it)
			const text = new win.TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer());
			if (response.ok) return { ok: true, status: response.status, text, data: null };
			/** @type {any} */
			let data = null;
			try {
				data = JSON.parse(text);
			} catch {
				data = null;
			}
			return { ok: false, status: response.status, text: '', data };
		} catch {
			return { ok: false, status: 0, text: '', data: null };
		}
	};

	/**
	 * What went wrong, for people: signed out, unreachable, not allowed by the ticket, or the server's problem.
	 * @param {{ status: number, data: any }} answer
	 */
	const reason = (answer) => {
		if (answer.status === 0) return api.tickets.current() ? t('admin.unreachable') : t('admin.signedOut');
		if (answer.status === 403) return t('admin.notAllowed');
		const text = answer.data?.detail ?? answer.data?.errors?.[0]?.message;
		return typeof text === 'string' && text ? text : t('admin.failed');
	};

	/**
	 * Send a file to a presigned upload address.
	 * @param {{ method?: string, url: string, headers?: Record<string, string> }} target
	 * @param {Blob} file
	 */
	const upload = async (target, file) => {
		try {
			const response = await api.fetch(target.url, {
				method: target.method ?? 'PUT',
				headers: target.headers ?? {},
				body: file,
			});
			return response.ok;
		} catch {
			return false;
		}
	};

	/** Open a printable page (HTML text) in a new tab. @param {string} html */
	const openHtml = (html) => {
		const url = win.URL.createObjectURL(new win.Blob([html], { type: 'text/html;charset=utf-8' }));
		blobs.push(url);
		open(url);
	};

	// -------------------------------------------------------------------------------------------------- DOM

	/**
	 * An element with children (strings become text).
	 * @param {string} tag @param {Record<string, string>} [attributes] @param {Child[]} [children]
	 */
	const h = (tag, attributes = {}, children = []) => {
		const node = element(doc, tag, attributes);
		node.append(
			.../** @type {Array<Node | string>} */ (
				children.filter((child) => child !== null && child !== undefined && child !== false)
			),
		);
		return node;
	};
	/**
	 * Replace a node's children (strings become text; empty entries are skipped).
	 * @param {HTMLElement} node @param {Child[]} children
	 */
	const put = (node, children) =>
		node.replaceChildren(
			.../** @type {Array<Node | string>} */ (
				children.filter((child) => child !== null && child !== undefined && child !== false)
			),
		);
	/** @param {string} tag @param {Record<string, string>} attributes @param {string} value */
	const text = (tag, attributes, value) => element(doc, tag, attributes, value);

	/** A status line (polite live region). */
	const status = () => element(doc, 'p', { class: 'status', role: 'status', 'aria-live': 'polite' });
	/**
	 * Show a message in a status line.
	 * @param {HTMLElement} line @param {string} message @param {boolean} [error]
	 */
	const say = (line, message, error = false) => {
		line.replaceChildren(message);
		line.classList.toggle('error', error);
	};
	/**
	 * Show what went wrong in a status line.
	 * @template {{ status: number, data: any }} A
	 * @param {HTMLElement} line @param {A} answer
	 * @returns {A} the answer (a button's action returns it, so a 403 keeps the button disabled)
	 */
	const fail = (line, answer) => {
		say(line, reason(answer), true);
		return answer;
	};

	/**
	 * A button; while its action runs it is disabled, and it stays disabled when the action answered 403.
	 * @param {string} label
	 * @param {() => unknown} action may return the answer of its call
	 * @param {{ primary?: boolean, attributes?: Record<string, string> }} [options]
	 */
	const button = (label, action, { primary = false, attributes = {} } = {}) => {
		const node = /** @type {HTMLButtonElement} */ (
			element(doc, 'button', { type: 'button', ...(primary ? {} : { class: 'secondary' }), ...attributes }, label)
		);
		node.addEventListener('click', async () => {
			node.disabled = true;
			/** @type {any} */
			let result = null;
			try {
				result = await action();
			} finally {
				node.disabled = result?.status === 403;
			}
		});
		return node;
	};

	/**
	 * A button that asks once more before acting (`Delete` → `Confirm delete`).
	 * @param {string} label @param {string} confirmLabel @param {() => unknown} action
	 */
	const confirmButton = (label, confirmLabel, action) => {
		let armed = false;
		const node = button(label, async () => {
			armed = !armed;
			node.replaceChildren(armed ? confirmLabel : label);
			return armed ? null : action();
		});
		return node;
	};

	/**
	 * A labelled field.
	 * @param {string} label @param {HTMLElement} control
	 */
	const field = (label, control) => {
		ids += 1;
		const id = `ss-field-${ids}`;
		control.setAttribute('id', id);
		return h('div', { class: 'field' }, [text('label', { for: id }, label), control]);
	};
	/** @param {string | number | null | undefined} [value] @param {Record<string, string>} [attributes] */
	const input = (value = '', attributes = {}) => {
		const node = /** @type {HTMLInputElement} */ (element(doc, 'input', attributes));
		node.value = value === null || value === undefined ? '' : String(value);
		return node;
	};
	/** @param {string} [value] @param {Record<string, string>} [attributes] */
	const area = (value = '', attributes = {}) => {
		const node = /** @type {HTMLTextAreaElement} */ (element(doc, 'textarea', { rows: '3', ...attributes }));
		node.value = value;
		return node;
	};
	/** @param {Choice[]} choices @param {string} [value] @param {Record<string, string>} [attributes] */
	const select = (choices, value = '', attributes = {}) => {
		const node = /** @type {HTMLSelectElement} */ (element(doc, 'select', attributes));
		node.append(...choices.map((choice) => element(doc, 'option', { value: choice.value }, choice.label)));
		if (choices.some((choice) => choice.value === value)) node.value = value;
		return node;
	};
	/** A checkbox with its label. @param {string} label @param {boolean} [checked] */
	const check = (label, checked = false) => {
		const box = input('', { type: 'checkbox' });
		box.checked = checked;
		return { box, node: h('label', { class: 'check' }, [box, label]) };
	};
	/** A group of fields with a legend. @param {string} legend @param {Child[]} children */
	const group = (legend, children) => h('fieldset', {}, [text('legend', {}, legend), ...children]);
	/** A row of fields that wraps on small screens. @param {Child[]} children */
	const row = (children) => h('div', { class: 'row' }, children);

	/**
	 * A table (scrolls sideways on small screens).
	 * @param {string[]} headers @param {Array<Child[]>} rows
	 */
	const table = (headers, rows) =>
		h('div', { class: 'scroll' }, [
			h('table', {}, [
				h('thead', {}, [
					h(
						'tr',
						{},
						headers.map((header) => text('th', { scope: 'col' }, header)),
					),
				]),
				h(
					'tbody',
					{},
					rows.map((cells) =>
						h(
							'tr',
							{},
							cells.map((cell) => h('td', {}, [cell])),
						),
					),
				),
			]),
		]);

	/**
	 * Tabs; each panel is built the first time it is shown. With one tab the bar is hidden.
	 * @param {Array<{ key: string, label: string, render: (panel: HTMLElement) => void }>} entries
	 */
	const tabs = (entries) => {
		const bar = h('div', { role: 'tablist', class: 'tabs' });
		const panels = h('div');
		/** @type {Set<string>} */
		const built = new Set();
		/** @param {string} key */
		const show = (key) => {
			for (const entry of entries) {
				const tab = /** @type {HTMLElement} */ (bar.querySelector(`[data-tab="${entry.key}"]`));
				const panel = /** @type {HTMLElement} */ (panels.querySelector(`[data-panel="${entry.key}"]`));
				const on = entry.key === key;
				tab.setAttribute('aria-selected', String(on));
				tab.setAttribute('tabindex', on ? '0' : '-1');
				panel.hidden = !on;
				if (on && !built.has(key)) {
					built.add(key);
					entry.render(panel);
				}
			}
		};
		for (const entry of entries) {
			ids += 1;
			const tab = text('button', { type: 'button', role: 'tab', 'data-tab': entry.key, id: `ss-tab-${ids}` }, entry.label);
			tab.addEventListener('click', () => show(entry.key));
			bar.append(tab);
			panels.append(h('div', { role: 'tabpanel', 'data-panel': entry.key, 'aria-labelledby': `ss-tab-${ids}` }));
		}
		bar.hidden = entries.length < 2;
		if (entries[0]) show(entries[0].key);
		return h('div', {}, [bar, panels]);
	};

	/**
	 * A list loaded page by page (`{ items, nextCursor, hasMore }`) with `Load more`.
	 * @param {{ path: (cursor: string | null) => string, row: (item: any) => Node, line: HTMLElement, empty: string }} options
	 */
	const pager = ({ path, row: rowOf, line, empty }) => {
		const list = h('ul', { class: 'rows' });
		/** @type {string | null} */
		let cursor = null;
		/** @param {boolean} fresh @returns {Promise<Answer>} */
		const load = async (fresh) => {
			const answer = await call('GET', path(fresh ? null : cursor));
			if (fresh) list.replaceChildren();
			if (!answer.ok) {
				fail(line, answer);
				more.hidden = true;
				return answer;
			}
			cursor = answer.data.nextCursor ?? null;
			/** @type {any[]} */
			const items = answer.data.items ?? [];
			say(line, fresh && items.length === 0 ? empty : '');
			list.append(...items.map(rowOf));
			more.hidden = !answer.data.hasMore;
			return answer;
		};
		const more = button(t('admin.more'), () => load(false));
		more.hidden = true;
		return { node: h('div', {}, [list, more]), list, load };
	};

	/**
	 * Ids picked by searching (products, categories, brands), shown as removable chips. When the search is not
	 * allowed (it answers null), the typed text is added as an id.
	 * @param {{ label: string, ids: string[], names: Map<string, string>,
	 *   search: (text: string) => Promise<Array<{ id: string, label: string }> | null> }} options
	 */
	const picker = ({ label, ids: start, names, search }) => {
		const chosen = [...start];
		const chips = h('ul', { class: 'chips' });
		const results = h('ul', { class: 'chips' });
		const box = input('', { type: 'search', placeholder: t('admin.searchToAdd') });
		const draw = () =>
			chips.replaceChildren(
				...chosen.map((id) =>
					h('li', {}, [
						names.get(id) ?? id,
						button(
							'×',
							() => {
								chosen.splice(chosen.indexOf(id), 1);
								draw();
							},
							{ attributes: { 'aria-label': t('admin.removeItem', { name: names.get(id) ?? id }) } },
						),
					]),
				),
			);
		/** @param {string} id */
		const add = (id) => {
			if (id && !chosen.includes(id)) chosen.push(id);
			draw();
		};
		const find = button(t('admin.find'), async () => {
			const found = await search(box.value.trim());
			if (found === null) {
				add(box.value.trim());
				box.value = '';
				results.replaceChildren();
				return;
			}
			results.replaceChildren(
				...(found.length === 0
					? [text('li', { class: 'muted' }, t('admin.noMatches'))]
					: found.map((item) =>
							h('li', {}, [
								button(item.label, () => {
									names.set(item.id, item.label);
									add(item.id);
								}),
							]),
						)),
			);
		});
		box.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			find.click();
		});
		draw();
		return {
			node: group(label, [chips, h('div', { class: 'row inline' }, [field(t('admin.search'), box), find]), results]),
			value: () => [...chosen],
		};
	};

	/** A time for people. @param {string | null | undefined} iso */
	const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

	return Object.freeze({
		doc,
		win,
		currency,
		/** @type {Record<string, any>} */
		settings: config.settings ?? {},
		t,
		has,
		money,
		decimal,
		amount,
		call,
		fetchText,
		reason,
		upload,
		openHtml,
		save,
		h,
		put,
		text,
		status,
		say,
		fail,
		button,
		confirmButton,
		field,
		input,
		area,
		select,
		check,
		group,
		row,
		table,
		tabs,
		pager,
		picker,
		when,
		dispose: () => {
			for (const url of blobs.splice(0)) win.URL.revokeObjectURL(url);
		},
	});
};

/** @typedef {ReturnType<typeof createKit>} Kit */

/**
 * Mount an admin widget: its shadow root, theme and CSS, a box with its title and the `Signed out` line, and its body.
 * @param {import('./widget.js').AdminMount} input
 * @param {string} name the widget's name on its host (`data-ss-mounted`)
 * @param {string} titleKey
 * @param {(kit: Kit, box: HTMLElement) => void} build fills the box
 */
export const mountAdmin = ({ host, config, api, win, save, open }, name, titleKey, build) => {
	host.setAttribute('data-ss-mounted', name);
	mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS + ADMIN_CSS,
		render: (root) => {
			const kit = createKit({ root, config, api, win, save, open });
			const banner = kit.status();
			const box = kit.h('section', { class: 'box admin' }, [kit.text('h2', {}, kit.t(titleKey)), banner]);
			root.append(box);
			const stop = api.tickets.onChange((signedIn) => kit.say(banner, signedIn ? '' : kit.t('admin.signedOut'), !signedIn));
			build(kit, box);
			return () => {
				stop();
				kit.dispose();
			};
		},
	});
};
