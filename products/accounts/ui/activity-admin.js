/**
 * The admin widget `activity_admin` (Activity log copy; permission `activity.read`): the activity-log copies every
 * connected product sends to Accounts, newest first, with a chip per product carrying its count, search (labels,
 * details, names, targets), the action, the person and a time range (days in the business time zone), and paging.
 * Each entry shows what was done, its label, what changed (its values through the texts `activity.value` and
 * `activity.yes`/`activity.no`, A8, or a product's detail), who did it (with their role) and when. PLAN 0.4.11,
 * 0.8.10 K9.
 * @module
 */
import { adminCall, element, formatText, mountWidget } from '@ss/app-kit/widget';
import { datesOf, errorText, fieldMaker, setHidden, textsOf } from './common.js';
import { chips } from './parts.js';
import { WIDGET_CSS } from './styles.js';

/** The products that send copies (the chips; `''` is every product). */
const PRODUCTS = /** @type {const} */ (['', 'accounts', 'chat', 'ecommerce', 'notifications', 'payments', 'growth']);

/**
 * @param {{ host: HTMLElement, api: import('@ss/app-kit/widget').AdminApi, config: import('./widget.js').WidgetConfig }} input
 */
export const mountActivityAdmin = ({ host, api, config }) => {
	const t = textsOf(config);
	const when = datesOf(config, host.ownerDocument.defaultView);
	return mountWidget({
		host,
		theme: config.theme,
		customCss: config.customCss,
		css: WIDGET_CSS,
		render: (root) => {
			const doc = /** @type {Document} */ (root.ownerDocument);
			const make = fieldMaker(doc, 'ss-activity');
			let product = '';
			/** @type {string | null} */
			let cursor = null;
			/** @param {import('./common.js').Answer} answer */
			const failure = (answer) =>
				answer.status === 0 && !api.tickets.current() ? t('activity.signedOut') : errorText(t, answer, when);

			const productChips = chips(
				doc,
				PRODUCTS.map((value) => ({ value, label: value === '' ? t('activity.all') : value })),
				(value) => {
					product = value;
					productChips.pick(value);
					void load(true);
				},
			);
			productChips.pick('');
			const filters = element(doc, 'form', { class: 'grid' });
			const q = make.field('input', t('activity.search'), { type: 'search', maxlength: '200' });
			const action = make.field('input', t('activity.action'), { maxlength: '200' });
			const actor = make.field('input', t('activity.actor'), { maxlength: '64' });
			const from = make.field('input', t('activity.from'), { type: 'date' });
			const to = make.field('input', t('activity.to'), { type: 'date' });
			const search = element(doc, 'button', { type: 'submit' }, t('activity.searchButton'));
			filters.append(q.wrap, action.wrap, actor.wrap, from.wrap, to.wrap, search);
			const note = element(doc, 'p', { class: 'status', role: 'status' });
			const list = element(doc, 'ul');
			const more = element(doc, 'button', { type: 'button', class: 'secondary', hidden: '' }, t('activity.more'));
			const box = element(doc, 'section', { class: 'box' });
			box.append(
				element(doc, 'h2', {}, t('activity.title')),
				element(doc, 'p', { class: 'meta' }, t('activity.help')),
				productChips.group,
				filters,
				note,
				list,
				more,
			);
			root.append(box);

			/** The filters as a query (without the product). */
			const query = () => {
				const out = new URLSearchParams();
				for (const [key, field] of /** @type {const} */ ([
					['q', q],
					['action', action],
					['actor', actor],
					['from', from],
					['to', to],
				]))
					if (field.input.value.trim()) out.set(key, field.input.value.trim());
				return out;
			};

			const loadCounts = async () => {
				const answer = await adminCall(api, 'GET', `/v1/admin/activity-copies/counts?by=productId&${query().toString()}`);
				if (answer.ok) productChips.counts({ '': answer.data.total, ...answer.data.groups });
			};

			/**
			 * What changed, in words (A8): each value as `activity.value` with its name and value, yes/no as texts.
			 * @param {Record<string, string | number | boolean>} values
			 */
			const valuesText = (values) =>
				Object.entries(values)
					.map(([name, value]) =>
						formatText(t('activity.value'), {
							name,
							value: value === true ? t('activity.yes') : value === false ? t('activity.no') : String(value),
						}),
					)
					.join(' · ');

			/** @param {boolean} reset */
			const load = async (reset) => {
				const params = query();
				params.set('limit', '50');
				if (product) params.set('productId', product);
				if (!reset && cursor) params.set('cursor', cursor);
				const answer = await adminCall(api, 'GET', `/v1/admin/activity-copies?${params.toString()}`);
				if (reset) {
					list.replaceChildren();
					void loadCounts();
				}
				if (!answer.ok) {
					note.textContent = failure(answer);
					setHidden(more, true);
					return;
				}
				cursor = answer.data.nextCursor;
				note.textContent = reset && answer.data.items.length === 0 ? t('activity.empty') : '';
				for (const entry of answer.data.items) {
					const item = element(doc, 'li');
					item.append(
						element(doc, 'span', {}, [entry.label ?? entry.target, entry.action].join(' · ')),
						...(entry.detail ? [element(doc, 'span', { class: 'meta' }, entry.detail)] : []),
						...(Object.keys(entry.values ?? {}).length > 0
							? [element(doc, 'span', { class: 'meta' }, valuesText(entry.values))]
							: []),
						element(
							doc,
							'span',
							{ class: 'meta' },
							`${entry.productId} · ${formatText(t('activity.by'), {
								name: [entry.actor?.name ?? entry.actor?.id, entry.actor?.role].filter(Boolean).join(', '),
								time: when(entry.at),
							})}`,
						),
					);
					list.append(item);
				}
				setHidden(more, !answer.data.hasMore);
			};

			filters.addEventListener('submit', (event) => {
				event.preventDefault();
				void load(true);
			});
			more.addEventListener('click', () => void load(false));
			const off = api.tickets.onChange((signedIn) => {
				if (!signedIn) {
					list.replaceChildren();
					note.textContent = t('activity.signedOut');
				}
			});
			void load(true);
			return () => void off();
		},
	});
};
