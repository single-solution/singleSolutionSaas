/**
 * Redirects (admin widget `redirects`; feature `redirects`, ticket `redirects.edit`; SEO audit G9, PLAN 0.6). The
 * rules, newest first, with a search, filter chips by answer (with counts) and Load more; a rule opens in a dialog to
 * change or delete it; Add a rule opens the same dialog empty. The More menu imports a CSV file (a dry run first lists
 * what would change and every problem; Import then applies it) and exports the rules as CSV. Below, the suggestions
 * from the 404 log: the most-hit missing pages without a rule, each opening a new rule with its path (and a suggested
 * new page when one is found). Every word is a widget text; refused calls show the widget's own texts, never the
 * server's English (OT-4); times follow the website's Format and time zone (PLAN 0.8.10 K7).
 * @module
 */
import { adminCall, element, formatDate, formatText, moreMenu, mountWidget, openDialog, stateSlot } from '@ss/app-kit/widget';
import { PROBLEM_TEXTS, chipGroup, problemKey } from './admin-kit.js';
import { WIDGET_CSS } from './styles.js';

/** Rules per page of the list. */
const PAGE = 50;
/** The answers a rule may give, in the order they are offered (G14: 302 and 307 are temporary). */
const CODE_CHOICES = Object.freeze(['301', '308', '302', '307', '410']);

/** Changes of a checked file listed in the import dialog (the rest are counted). */
const LISTED_CHANGES = 100;
/** The days of the 404 log the suggestions read (the route's default). */
const SUGGESTION_DAYS = 90;

/** The widget texts of refused calls. */
export const REDIRECT_PROBLEMS = Object.freeze({
	...PROBLEM_TEXTS,
	'validation_failed:from': 'redirects.problem.from',
	'validation_failed:to': 'redirects.problem.to',
	'validation_failed:note': 'redirects.problem.note',
	'validation_failed:csv': 'redirects.problem.csv',
	redirect_taken: 'redirects.problem.taken',
	redirect_loop: 'redirects.problem.loop',
	redirect_chain: 'redirects.problem.chain',
	redirects_full: 'redirects.problem.full',
	not_found: 'redirects.problem.notFound',
});

/**
 * @typedef {{ id: string, from: string, match: 'exact' | 'prefix' | 'wildcard', to: string | null, code: 301 | 302 | 307 | 308 | 410,
 *   note: string, createdAt: string, updatedAt: string }} Rule
 */
/** @typedef {{ line: number, path: string, code: string, steps?: string[] }} RowProblem */

/**
 * @param {{ host: HTMLElement, api: import('@ss/app-kit/widget').AdminApi, config: import('./widget.js').WidgetConfig,
 *   viewer: import('./widget.js').Viewer, download: (name: string, bytes: ArrayBuffer) => void }} input `viewer`: the
 *   browser's language and time zone; `download`: save a file the widget made
 */
export const mountRedirects = ({ host, api, config, viewer, download }) => {
	/** @param {string} key @param {Record<string, string | number>} [values] */
	const t = (key, values) => formatText(config.texts[key] ?? key, values);
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = root.ownerDocument;
			/** @param {string} tag @param {Record<string, string>} [attributes] @param {string} [text] */
			const h = (tag, attributes, text) => element(doc, tag, attributes, text);
			/** @param {string} label @param {HTMLElement} control */
			const field = (label, control) => {
				const node = h('label', {}, label);
				node.append(control);
				return node;
			};
			/**
			 * The text of a refused call.
			 * @param {{ ok: boolean, status: number, data: any }} answer
			 */
			const failure = (answer) => {
				if (answer.status === 0 && !api.tickets.current()) return t('redirects.signedOut');
				const key = problemKey(answer, REDIRECT_PROBLEMS, 'redirects.failed');
				return t(key === 'redirects.problem.chain' && answer.data?.gone === true ? 'redirects.problem.gone' : key, {
					from: String(answer.data?.from ?? ''),
					steps: Array.isArray(answer.data?.steps) ? answer.data.steps.join(' → ') : '',
				});
			};
			/** @param {string | undefined} value */
			const time = (value) => formatDate(value, config.format, { timeZone: config.timeZone, style: 'datetime', viewer });
			/** @param {Rule | { from: string, to: string | null, code: number }} rule */
			const lineOf = (rule) => (rule.to === null ? `${rule.from} · ${t('redirects.gone')}` : `${rule.from} → ${rule.to}`);

			// ------------------------------------------------------------------------------------------ the rules
			const status = h('p', { class: 'status', role: 'status' });
			const sub = h('p', { class: 'sub' });
			const search = /** @type {HTMLInputElement} */ (
				h('input', { type: 'search', placeholder: t('redirects.searchHint'), 'aria-label': t('redirects.search') })
			);
			const chips = h('div');
			const list = h('ul', { class: 'rows' });
			const state = stateSlot(doc);
			const more = h('button', { type: 'button', class: 'secondary', hidden: '' }, t('redirects.loadMore'));
			/** @type {{ q: string, code: string, cursor: string | null }} */
			const view = { q: '', code: '', cursor: null };

			/**
			 * The list's first page (and the counts of its chips), or its next page.
			 * @param {boolean} [next]
			 */
			const load = async (next = false) => {
				const params = new URLSearchParams({ limit: String(PAGE) });
				if (!next && list.children.length === 0) state.loading(t('redirects.loading'));
				if (view.q) params.set('q', view.q);
				if (view.code) params.set('code', view.code);
				if (next && view.cursor) params.set('cursor', view.cursor);
				const counted = new URLSearchParams({ by: 'code', ...(view.q ? { q: view.q } : {}) });
				const [answer, counts] = await Promise.all([
					adminCall(api, 'GET', `/v1/admin/redirects?${params.toString()}`),
					next ? null : adminCall(api, 'GET', `/v1/admin/redirects/counts?${counted.toString()}`),
				]);
				if (!answer.ok) {
					// Try again helps when the server or the network failed, not when the answer says what to set up first
					const transient = answer.status === 0 || answer.status === 429 || answer.status >= 500;
					state.failed(
						failure(answer),
						transient && api.tickets.current() ? { label: t('redirects.tryAgain'), onRetry: () => load(next) } : undefined,
					);
					return;
				}
				state.clear();
				view.cursor = answer.data.nextCursor ?? null;
				more.toggleAttribute('hidden', !answer.data.hasMore);
				if (!next) {
					list.replaceChildren();
					if (counts?.ok) drawCounts(counts.data);
				}
				if (list.children.length === 0 && answer.data.items.length === 0)
					list.append(h('li', { class: 'empty' }, t(view.q || view.code ? 'redirects.noneFound' : 'redirects.none')));
				for (const rule of /** @type {Rule[]} */ (answer.data.items)) {
					const item = h('li', { tabindex: '0', role: 'button' });
					item.append(h('span', {}, lineOf(rule)), h('span', { class: 'figure' }, String(rule.code)));
					item.append(
						h('span', { class: 'meta' }, [t(`redirects.match.${rule.match}`), rule.note].filter(Boolean).join(' · ')),
					);
					item.addEventListener('click', () => ruleDialog(rule));
					item.addEventListener('keydown', (key) => {
						if (key.key === 'Enter' || key.key === ' ') {
							key.preventDefault();
							ruleDialog(rule);
						}
					});
					list.append(item);
				}
			};

			/** @param {{ total: number, groups: Record<string, number> }} counts */
			const drawCounts = ({ total, groups }) => {
				sub.textContent = view.q ? t('redirects.found', { count: total }) : t('redirects.sub', { count: total });
				chips.replaceChildren(
					chipGroup(
						doc,
						t('redirects.filter'),
						[
							{ value: '', label: t('redirects.all'), count: total },
							// only the answers some rule gives (or the one picked)
							...CODE_CHOICES.filter((code) => (groups[code] ?? 0) > 0 || view.code === code).map((code) => ({
								value: code,
								label: t(`redirects.code.${code}`),
								count: groups[code] ?? 0,
							})),
						],
						view.code,
						(code) => {
							view.code = code;
							void load();
						},
					),
				);
			};

			/** Reload the list and the suggestions after a change. */
			const changed = () => {
				void load();
				void loadSuggestions();
			};

			/**
			 * The dialog of a rule: a stored one to change (or delete), else a new one (from a suggestion, with its path).
			 * @param {Rule | null} rule
			 * @param {{ from: string, to: string | null }} [preset]
			 */
			const ruleDialog = (rule, preset) => {
				const from = /** @type {HTMLInputElement} */ (
					h('input', { type: 'text', placeholder: t('redirects.field.fromHint') })
				);
				from.value = rule?.from ?? preset?.from ?? '';
				const match = /** @type {HTMLSelectElement} */ (h('select'));
				for (const value of ['exact', 'prefix', 'wildcard'])
					match.append(h('option', { value }, t(`redirects.match.${value}`)));
				match.value = rule?.match ?? 'exact';
				const code = /** @type {HTMLSelectElement} */ (h('select'));
				for (const value of CODE_CHOICES) code.append(h('option', { value }, t(`redirects.code.${value}`)));
				code.value = String(rule?.code ?? 301);
				const to = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: t('redirects.field.toHint') }));
				to.value = rule?.to ?? preset?.to ?? '';
				const target = field(t('redirects.field.to'), to);
				const showTarget = () => target.toggleAttribute('hidden', code.value === '410');
				code.addEventListener('change', showTarget);
				showTarget();
				const note = /** @type {HTMLInputElement} */ (h('input', { type: 'text', maxlength: '200' }));
				note.value = rule?.note ?? '';
				const grid = h('div', { class: 'form-grid' });
				const wide = field(t('redirects.field.from'), from);
				wide.classList.add('wide');
				target.classList.add('wide');
				const noted = field(t('redirects.field.note'), note);
				noted.classList.add('wide');
				grid.append(wide, field(t('redirects.field.match'), match), field(t('redirects.field.code'), code), target, noted);
				const remove = rule ? h('button', { type: 'button', class: 'link remove' }, t('redirects.deleteRule')) : null;
				const dialog = openDialog(root, {
					title: rule ? t('redirects.edit') : t('redirects.add'),
					body: [
						h('p', { class: 'sub' }, t('redirects.help')),
						grid,
						rule
							? h(
									'p',
									{ class: 'meta' },
									t('redirects.times', { created: time(rule.createdAt), updated: time(rule.updatedAt) }),
								)
							: null,
						remove,
					],
					submitLabel: rule ? t('redirects.save') : t('redirects.create'),
					closeLabel: t('redirects.cancel'),
					onSubmit: async () => {
						const body = {
							from: from.value,
							match: match.value,
							code: Number(code.value),
							to: code.value === '410' ? null : to.value,
							note: note.value,
						};
						const answer = rule
							? await adminCall(api, 'PATCH', `/v1/admin/redirects/${encodeURIComponent(rule.id)}`, body)
							: await adminCall(api, 'POST', '/v1/admin/redirects', body);
						if (!answer.ok) return failure(answer);
						status.textContent = t(rule ? 'redirects.saved' : 'redirects.added', { from: answer.data.from });
						changed();
						return null;
					},
				});
				remove?.addEventListener('click', () => {
					openDialog(root, {
						title: t('redirects.deleteTitle'),
						body: [h('p', {}, t('redirects.deleteHelp', { from: /** @type {Rule} */ (rule).from }))],
						submitLabel: t('redirects.delete'),
						closeLabel: t('redirects.cancel'),
						danger: true,
						onSubmit: async () => {
							const answer = await adminCall(api, 'DELETE', `/v1/admin/redirects/${encodeURIComponent(String(rule?.id))}`);
							if (!answer.ok) return failure(answer);
							dialog.close();
							status.textContent = t('redirects.deleted', { from: String(rule?.from) });
							changed();
							return null;
						},
					});
				});
			};

			/** Import a CSV file: check it (a dry run), then import what the check listed. */
			const importDialog = () => {
				const file = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: '.csv,text/csv' }));
				const text = /** @type {HTMLTextAreaElement} */ (h('textarea', { rows: '8', spellcheck: 'false' }));
				const result = h('div');
				/** The text the last check found without problems (Import then applies it). */
				let checked = '';
				const dialog = openDialog(root, {
					title: t('redirects.import.title'),
					wide: true,
					body: [
						h('p', { class: 'sub' }, t('redirects.import.help')),
						field(t('redirects.import.file'), file),
						field(t('redirects.import.text'), text),
						result,
					],
					submitLabel: t('redirects.import.check'),
					closeLabel: t('redirects.cancel'),
					onSubmit: async () => {
						const csv = text.value;
						const real = checked !== '' && checked === csv;
						const answer = await adminCall(api, 'POST', '/v1/admin/redirects/csv', { csv, dryRun: !real });
						if (!answer.ok) {
							reset();
							return real && answer.status === 422 ? t('redirects.import.stale') : failure(answer);
						}
						if (real) {
							status.textContent = t('redirects.import.done', {
								created: answer.data.created,
								updated: answer.data.updated,
							});
							changed();
							return null;
						}
						draw(answer.data);
						if (answer.data.errors.length === 0 && answer.data.changes.length > 0) {
							checked = csv;
							submit.textContent = t('redirects.import.run', { count: answer.data.changes.length });
						}
						// the dialog stays open on the check's answer
						return t('redirects.import.checked');
					},
				});
				const submit = /** @type {HTMLButtonElement} */ (dialog.submit);
				const reset = () => {
					checked = '';
					submit.textContent = t('redirects.import.check');
				};
				text.addEventListener('input', reset);
				file.addEventListener('change', () => {
					const picked = file.files?.[0];
					const View = doc.defaultView;
					if (!picked || !View) return;
					const reader = new View.FileReader();
					reader.addEventListener('load', () => {
						text.value = String(reader.result ?? '');
						reset();
					});
					reader.readAsText(picked);
				});

				/**
				 * What a check found: the counts, every problem and what would change.
				 * @param {{ rows: number, created: number, updated: number, unchanged: number, errors: RowProblem[],
				 *   changes: Array<{ line: number, action: 'create' | 'update', from: string, to: string | null, code: number }> }} plan
				 */
				const draw = (plan) => {
					const { rows, created, updated, unchanged } = plan;
					const parts = [h('p', {}, t('redirects.import.summary', { rows, created, updated, unchanged }))];
					if (plan.errors.length > 0) {
						parts.push(h('h4', {}, t('redirects.import.problems', { count: plan.errors.length })));
						const problems = h('ul', { class: 'checks' });
						for (const error of plan.errors) {
							const key = `redirects.row.${error.path.slice(1) || 'file'}.${error.code}`;
							problems.append(
								h(
									'li',
									{},
									t(Object.hasOwn(config.texts, key) ? key : 'redirects.row.other', {
										line: error.line,
										steps: (error.steps ?? []).join(' → '),
									}),
								),
							);
						}
						parts.push(problems);
					}
					if (plan.changes.length === 0) parts.push(h('p', { class: 'lead' }, t('redirects.import.nothing')));
					else {
						parts.push(h('h4', {}, t('redirects.import.changes', { count: plan.changes.length })));
						const changes = h('ul', { class: 'list' });
						for (const change of plan.changes.slice(0, LISTED_CHANGES)) {
							const row = h('li');
							row.append(h('span', {}, lineOf(change)), h('span', {}, t(`redirects.import.${change.action}`)));
							changes.append(row);
						}
						parts.push(changes);
						if (plan.changes.length > LISTED_CHANGES)
							parts.push(
								h('p', { class: 'meta' }, t('redirects.import.more', { count: plan.changes.length - LISTED_CHANGES })),
							);
					}
					result.replaceChildren(...parts);
				};
			};

			/** Export the rules as `redirects.csv`. */
			const exportCsv = async () => {
				const ticket = api.tickets.current();
				if (!ticket) {
					status.textContent = t('redirects.signedOut');
					return;
				}
				try {
					const response = await api.fetch(`${api.base}/v1/admin/redirects/csv`, {
						headers: { authorization: `Bearer ${ticket}` },
					});
					if (!response.ok) {
						status.textContent = failure({
							ok: false,
							status: response.status,
							data: await response.json().catch(() => null),
						});
						return;
					}
					// the bytes as sent (text() would drop the byte order mark spreadsheets need to read UTF-8)
					download('redirects.csv', await response.arrayBuffer());
					status.textContent = t('redirects.exported');
				} catch {
					status.textContent = t('redirects.failed');
				}
			};

			const add = h('button', { type: 'button' }, t('redirects.add'));
			add.addEventListener('click', () => ruleDialog(null));
			const actions = h('div', { class: 'actions' });
			actions.append(
				add,
				moreMenu(doc, t('redirects.more'), [
					{ label: t('redirects.import.open'), onSelect: () => importDialog() },
					{ label: t('redirects.export'), onSelect: () => void exportCsv() },
				]),
			);
			const head = h('div', { class: 'head' });
			head.append(h('h2', {}, t('redirects.title')), actions);
			search.addEventListener('change', () => {
				view.q = search.value.trim();
				void load();
			});
			more.addEventListener('click', () => void load(true));
			const box = h('section', { class: 'box' });
			const filters = h('div', { class: 'section' });
			filters.append(search, chips);
			box.append(head, sub, filters, h('div', { class: 'section' }), state.root, list, more, status);

			// ------------------------------------------------------------------------- suggestions from the 404 log
			const ideas = h('ul', { class: 'rows' });
			const ideasNote = h('p', { class: 'status', role: 'status' });
			const loadSuggestions = async () => {
				const answer = await adminCall(api, 'GET', '/v1/admin/redirects/suggestions');
				if (!answer.ok) {
					ideasNote.textContent = failure(answer);
					return;
				}
				ideasNote.textContent = answer.data.recording ? '' : t('redirects.suggestions.off');
				ideas.replaceChildren();
				if (answer.data.items.length === 0) ideas.append(h('li', { class: 'empty' }, t('redirects.suggestions.none')));
				for (const idea of /** @type {Array<{ path: string, hits: number, to: string | null }>} */ (answer.data.items)) {
					const item = h('li', { tabindex: '0', role: 'button' });
					item.append(
						h('span', {}, idea.path),
						h('span', { class: 'figure' }, t('redirects.suggestions.hits', { count: idea.hits })),
					);
					if (idea.to) item.append(h('span', { class: 'meta' }, t('redirects.suggestions.to', { to: idea.to })));
					const open = () => ruleDialog(null, { from: idea.path, to: idea.to });
					item.addEventListener('click', open);
					item.addEventListener('keydown', (key) => {
						if (key.key === 'Enter' || key.key === ' ') {
							key.preventDefault();
							open();
						}
					});
					ideas.append(item);
				}
			};
			const suggestions = h('section', { class: 'box' });
			suggestions.append(
				h('h2', {}, t('redirects.suggestions.title')),
				h('p', { class: 'sub' }, t('redirects.suggestions.sub', { days: SUGGESTION_DAYS })),
				ideas,
				ideasNote,
			);

			const wrap = h('div', { class: 'stack' });
			wrap.append(box, suggestions);
			root.append(wrap);
			void load();
			void loadSuggestions();
			const stop = api.tickets.onChange((signedIn) => {
				if (!signedIn)
					for (const node of root.querySelectorAll('[role="status"]')) node.textContent = t('redirects.signedOut');
			});
			return () => {
				stop();
			};
		},
	});
};
