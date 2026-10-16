/**
 * Promotions (admin widget `promotions_admin`, tickets with `coupons.edit`, `deals.edit`, `bundles.edit` and
 * `loyalty.manage`; PLAN 0.8.8 Promotions, 0.6): a section for each switched-on feature — coupons (with batches of
 * random codes), deals and bundles (bundle items or buy X get Y) as list-and-detail screens from `./admin-offers.js`,
 * and loyalty accounts: look one up by its Accounts user id (accounts are not listed), then its balance and points
 * expiring soon as figures, Change points as a button (a dialog: points to add or take, with a note) and its history
 * and points by date earned as cards.
 * @module
 */
import { entriesOf, mountAdmin, wholeOf } from './admin-kit.js';
import { card, detailHead } from './admin-screen.js';
import { offersTab } from './admin-offers.js';
import { createSearches } from './admin-taxonomy.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */

/**
 * @param {import('./widget.js').AdminMount} input
 * @returns {Promise<void>}
 */
export const mountPromotionsAdmin = async (input) => {
	mountAdmin(input, 'promotions-admin', 'promotionsAdmin.title', (kit, box) => {
		const { t, has } = kit;
		const searches = createSearches(kit);
		/** @type {Array<'coupons' | 'deals' | 'bundles'>} */
		const kinds = ['coupons', 'deals', 'bundles'];
		box.append(
			kit.sections([
				...kinds
					.filter((kind) => has(kind))
					.map((kind) => ({
						key: kind,
						label: t(`promotionsAdmin.${kind}`),
						render: (/** @type {HTMLElement} */ panel) => offersTab(kit, panel, searches, kind),
					})),
				...(has('loyalty')
					? [
							{
								key: 'loyalty',
								label: t('promotionsAdmin.loyalty'),
								render: (/** @type {HTMLElement} */ panel) => loyaltyTab(kit, panel),
							},
						]
					: []),
			]),
		);
	});
};

/**
 * The loyalty section: look up a shopper's account by customer id (members and guests, K-6) or Accounts user id, see
 * the balance, lots and history, and add or take points with a note.
 * @param {Kit} kit @param {HTMLElement} panel
 */
const loyaltyTab = (kit, panel) => {
	const { t, h } = kit;
	const line = kit.status();
	const userId = kit.input('', { maxlength: '128', autocomplete: 'off' });
	const account = h('div');

	/** @param {any} data @param {string} [message] */
	const render = (data, message = '') => {
		const note = kit.status();
		const adjust = () => {
			const points = kit.input('', { type: 'number', step: '1' });
			const reason = kit.input('', { maxlength: '200' });
			kit.dialog({
				title: t('promotionsAdmin.adjustTitle'),
				body: [
					kit.text('p', { class: 'muted' }, t('promotionsAdmin.adjustHint')),
					h('div', { class: 'fields' }, [
						kit.field(t('promotionsAdmin.points'), points),
						kit.field(t('promotionsAdmin.note'), reason),
					]),
				],
				submitLabel: t('promotionsAdmin.adjust'),
				onSubmit: async () => {
					const value = wholeOf(points.value);
					if (value === null || Number.isNaN(value) || value === 0) return t('admin.checkNumbers');
					const owner = data.userId || data.customerId;
					const answer = await kit.call('POST', `/v1/admin/loyalty/accounts/${encodeURIComponent(owner)}/adjust`, {
						points: value,
						note: reason.value,
					});
					if (!answer.ok) return kit.reason(answer);
					render(answer.data, t('promotionsAdmin.adjusted'));
					return null;
				},
			});
		};
		/** @type {any[]} */
		const soon = data.expiringSoon ?? [];
		kit.put(account, [
			detailHead(kit, {
				title: String(data.userId || data.customerId),
				actions: [kit.button(t('promotionsAdmin.adjust'), adjust, { primary: true })],
			}),
			note,
			kit.fieldGrid([
				[t('promotionsAdmin.balanceLabel'), t('promotionsAdmin.pointsText', { points: data.balance })],
				[t('promotionsAdmin.worth'), kit.money(data.value)],
				...soon.map(
					(entry) =>
						/** @type {[string, string]} */ ([
							t('promotionsAdmin.expiringLabel', { when: kit.when(entry.expiresAt) }),
							t('promotionsAdmin.pointsText', { points: entry.points }),
						]),
				),
			]),
			kit.masonry([
				card(kit, t('promotionsAdmin.history'), [
					kit.table(
						[t('promotionsAdmin.when'), t('promotionsAdmin.what'), t('promotionsAdmin.points'), t('promotionsAdmin.note')],
						(data.history ?? []).map((/** @type {any} */ entry) => [
							kit.when(entry.at),
							t(`promotionsAdmin.pointsKind.${entry.kind}`),
							String(entry.points),
							entry.note,
						]),
					),
				]),
				card(kit, t('promotionsAdmin.lots'), [
					kit.table(
						[
							t('promotionsAdmin.earnedAt'),
							t('promotionsAdmin.points'),
							t('promotionsAdmin.left'),
							t('promotionsAdmin.expiresAt'),
						],
						(data.lots ?? []).map((/** @type {any} */ lot) => [
							kit.when(lot.earnedAt),
							String(lot.points),
							String(lot.left),
							kit.when(lot.expiresAt),
						]),
					),
				]),
			]),
		]);
		kit.say(note, message);
	};

	const form = h('form', { class: 'row inline' }, [
		kit.field(t('promotionsAdmin.userId'), userId),
		kit.text('button', { type: 'submit' }, t('promotionsAdmin.lookUp')),
	]);
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const id = entriesOf(userId.value)[0] ?? '';
		account.replaceChildren();
		if (!id) return;
		const answer = await kit.call('GET', `/v1/admin/loyalty/accounts/${encodeURIComponent(id)}`);
		if (!answer.ok) return kit.fail(line, answer);
		kit.say(line, '');
		render(answer.data);
	});
	panel.append(kit.text('p', { class: 'muted' }, t('promotionsAdmin.loyaltyHint')), form, line, account);
};
