/**
 * The admin widget `knowledge_editor` (permission `knowledge.edit`): search, add, change and delete FAQ entries and
 * articles; with Website pages as knowledge, the pages the AI learns from (add a URL, Fetch again, delete, status).
 * Pages are fetched when added and by Fetch again, never on a schedule. A part whose route answers 403 hides itself.
 * @module
 */
import { adminCall, element, formatText, mountWidget } from '@ss/app-kit/widget';
import { buttonOf, fieldMaker, formPart, isInvalid, setHidden, textsOf, webAddress, whenOf } from './common.js';
import { WIDGET_CSS } from './styles.js';

/**
 * @param {{ host: HTMLElement, win: Window, api: import('@ss/app-kit/widget').AdminApi, config: import('./common.js').WidgetConfig }} input
 */
export const mountKnowledge = ({ host, win, api, config }) => {
	const t = textsOf(config);
	const when = whenOf(config, win);
	/**
	 * What to tell staff when a call failed: the widget's own texts, never the server's detail.
	 * @param {import('@ss/app-kit/widget').Answer} answer
	 * @param {string} [invalid] the text of a refused value (`validation_failed`) for this action
	 */
	const failure = (answer, invalid = 'common.error') => {
		if (answer.status === 0 && !api.tickets.current()) return t('knowledge.signedOut');
		if (answer.status === 403) return t('knowledge.noAccess');
		return isInvalid(answer) ? t(invalid) : t('common.error');
	};
	/**
	 * Why a page could not be fetched, in the widget texts, from the answer's `reason`: the status the page answered,
	 * else that it cannot be reached (never the server's English `error`).
	 * @param {{ reason?: string | null, httpStatus?: number | null }} page
	 */
	const pageProblem = (page) =>
		page.reason === 'http_status'
			? formatText(t('knowledge.pageStatus'), { status: page.httpStatus ?? '' })
			: t('knowledge.pageUnreachable');
	/** @type {Record<string, string>} */
	const kinds = { faq: t('knowledge.faq'), article: t('knowledge.article') };

	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-knowledge');
			/** @type {string | null} */
			let cursor = null;
			/** @type {any} */
			let editing = null;

			const box = element(doc, 'section', { class: 'box' });
			const search = element(doc, 'form', { class: 'row' });
			const q = make.field('input', t('knowledge.search'), { type: 'search', maxlength: '200' });
			// the merchant's own collections (C21): a filter, and the names offered while typing one
			const filter = make.field('select', t('knowledge.collectionFilter'));
			const known = element(doc, 'datalist', { id: 'ss-knowledge-collections' });
			search.append(q.wrap, filter.wrap, element(doc, 'button', { type: 'submit' }, t('knowledge.searchButton')), known);
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = buttonOf(doc, t('knowledge.more'), { class: 'secondary', hidden: '' });

			const kind = make.field('select', t('knowledge.kind'));
			kind.input.append(...Object.entries(kinds).map(([value, label]) => element(doc, 'option', { value }, label)));
			const title = make.field('input', t('knowledge.entryTitle'), { maxlength: '200', required: '' });
			const text = make.field('textarea', t('knowledge.entryText'), { rows: '6', maxlength: '20000', required: '' });
			const collection = make.field('input', t('knowledge.collection'), {
				maxlength: '60',
				list: 'ss-knowledge-collections',
			});
			const language = make.field('input', t('knowledge.language'), { maxlength: '20' });
			const heading = element(doc, 'h3', {}, t('knowledge.add'));
			const cancel = buttonOf(doc, t('knowledge.cancel'), { class: 'secondary', hidden: '' });
			const reset = () => {
				editing = null;
				/** @type {HTMLFormElement} */ (form).reset();
				heading.textContent = t('knowledge.add');
				setHidden(cancel, true);
			};
			const form = formPart(doc, {
				nodes: [heading, kind.wrap, title.wrap, text.wrap, collection.wrap, language.wrap, cancel],
				label: t('common.save'),
				submit: async () => {
					const body = {
						kind: kind.input.value,
						title: title.input.value.trim(),
						text: text.input.value.trim(),
						collection: collection.input.value.trim(),
						language: language.input.value.trim(),
					};
					const answer = editing
						? await adminCall(api, 'PUT', `/v1/admin/knowledge/entries/${encodeURIComponent(editing.id)}`, body)
						: await adminCall(api, 'POST', '/v1/admin/knowledge/entries', body);
					if (!answer.ok) return failure(answer, 'knowledge.entryInvalid');
					reset();
					await Promise.all([load(true), loadCollections()]);
					return t('knowledge.saved');
				},
			});
			cancel.addEventListener('click', reset);
			box.append(element(doc, 'h2', {}, t('knowledge.title')), search, note, list, more, form);
			root.append(box);

			/** @param {any} entry */
			const entryNode = (entry) => {
				const item = element(doc, 'li', {}, entry.title);
				item.append(
					element(
						doc,
						'span',
						{ class: 'meta' },
						[kinds[entry.kind] ?? entry.kind, entry.collection, entry.language, when(entry.updatedAt)]
							.filter(Boolean)
							.join(' · '),
					),
				);
				const edit = buttonOf(doc, t('common.edit'), { class: 'secondary small' });
				const remove = buttonOf(doc, t('common.delete'), { class: 'secondary small' });
				edit.addEventListener('click', () => {
					editing = entry;
					kind.input.value = entry.kind;
					title.input.value = entry.title;
					text.input.value = entry.text;
					collection.input.value = entry.collection ?? '';
					language.input.value = entry.language ?? '';
					heading.textContent = t('knowledge.edit');
					setHidden(cancel, false);
				});
				remove.addEventListener('click', async () => {
					if (remove.dataset.sure !== '1') {
						remove.dataset.sure = '1';
						remove.textContent = t('knowledge.confirmDelete');
						return;
					}
					const answer = await adminCall(api, 'DELETE', `/v1/admin/knowledge/entries/${encodeURIComponent(entry.id)}`);
					note.textContent = answer.ok ? t('knowledge.deleted') : failure(answer);
					if (answer.ok) await Promise.all([load(true), loadCollections()]);
				});
				item.append(edit, remove);
				return item;
			};
			/** @param {boolean} fresh */
			const load = async (fresh) => {
				const query = new URLSearchParams();
				if (q.input.value.trim()) query.set('q', q.input.value.trim());
				if (filter.input.value) query.set('collection', filter.input.value);
				if (!fresh && cursor) query.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/knowledge/entries?${query.toString()}`);
				if (!answer.ok) {
					note.textContent = failure(answer);
					if (answer.status === 403) setHidden(form, true);
					return;
				}
				/** @type {any[]} */
				const items = answer.data.items ?? [];
				if (fresh) list.replaceChildren();
				cursor = answer.data.hasMore ? (answer.data.nextCursor ?? null) : null;
				note.textContent = fresh && items.length === 0 ? t('knowledge.empty') : '';
				list.append(...items.map(entryNode));
				setHidden(more, !cursor);
			};
			search.addEventListener('submit', (event) => {
				event.preventDefault();
				void load(true);
			});
			filter.input.addEventListener('change', () => void load(true));
			const loadCollections = async () => {
				const answer = await adminCall(api, 'GET', '/v1/admin/knowledge/collections');
				/** @type {Array<{ name: string }>} */
				const items = answer.ok ? (answer.data.items ?? []) : [];
				const chosen = filter.input.value;
				filter.input.replaceChildren(
					element(doc, 'option', { value: '' }, t('knowledge.allCollections')),
					...items.map((each) => element(doc, 'option', { value: each.name }, each.name)),
				);
				filter.input.value = items.some((each) => each.name === chosen) ? chosen : '';
				known.replaceChildren(...items.map((each) => element(doc, 'option', { value: each.name })));
			};
			more.addEventListener('click', () => void load(false));

			// website pages
			if (config.features.includes('knowledge_pages')) {
				const pages = element(doc, 'section', { class: 'part', hidden: '' });
				const pageList = element(doc, 'ul');
				const pageNote = element(doc, 'p', { class: 'status', role: 'status' });
				const url = make.field('input', t('knowledge.pageUrl'), { type: 'url', maxlength: '500', required: '' });
				const add = formPart(doc, {
					nodes: [url.wrap],
					label: t('knowledge.pageAdd'),
					submit: async () => {
						const answer = await adminCall(api, 'POST', '/v1/admin/knowledge/pages', { url: url.input.value.trim() });
						if (!answer.ok) return failure(answer, 'knowledge.pageInvalid');
						/** @type {HTMLFormElement} */ (add).reset();
						await loadPages();
						return t('knowledge.pageAdded');
					},
				});
				pages.append(element(doc, 'h3', {}, t('knowledge.pages')), pageList, pageNote, add);
				box.append(pages);

				/** @param {any} page */
				const pageNode = (page) => {
					const address = webAddress(page.url);
					const item = element(doc, 'li');
					item.append(
						address
							? element(doc, 'a', { href: address, target: '_blank', rel: 'noopener noreferrer' }, page.title || page.url)
							: doc.createTextNode(page.url),
						element(
							doc,
							'span',
							{ class: 'meta' },
							[
								page.status === 'ok' ? t('knowledge.pageOk') : pageProblem(page),
								page.fetchedAt ? formatText(t('knowledge.pageFetched'), { time: when(page.fetchedAt) }) : '',
							]
								.filter(Boolean)
								.join(' · '),
						),
					);
					const again = buttonOf(doc, t('knowledge.pageFetch'), { class: 'secondary small' });
					const remove = buttonOf(doc, t('common.delete'), { class: 'secondary small' });
					again.addEventListener('click', async () => {
						again.setAttribute('disabled', '');
						const answer = await adminCall(api, 'POST', `/v1/admin/knowledge/pages/${encodeURIComponent(page.id)}/fetch`);
						again.removeAttribute('disabled');
						pageNote.textContent = answer.ok ? t('knowledge.pageFetchedNow') : failure(answer);
						if (answer.ok) await loadPages();
					});
					remove.addEventListener('click', async () => {
						const answer = await adminCall(api, 'DELETE', `/v1/admin/knowledge/pages/${encodeURIComponent(page.id)}`);
						pageNote.textContent = answer.ok ? t('knowledge.deleted') : failure(answer);
						if (answer.ok) await loadPages();
					});
					item.append(again, remove);
					return item;
				};
				const loadPages = async () => {
					const answer = await adminCall(api, 'GET', '/v1/admin/knowledge/pages');
					if (!answer.ok) {
						pageNote.textContent = failure(answer);
						setHidden(pages, answer.status === 403);
						return;
					}
					setHidden(pages, false);
					pageList.replaceChildren(...(answer.data.items ?? []).map(pageNode));
				};
				void loadPages();
			}

			const off = api.tickets.onChange((signedIn) => {
				if (signedIn) return;
				list.replaceChildren();
				setHidden(more, true);
				note.textContent = t('knowledge.signedOut');
			});
			void loadCollections();
			void load(true);
			return () => void off();
		},
	});
};
