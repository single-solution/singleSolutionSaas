/**
 * Return and warranty claims in the orders admin widget (feature `returns`, ticket with `returns.manage`; PLAN 0.8.8
 * Returns and warranty): the claims list with status and kind filters, and one claim with its lines, the shopper's
 * photos (short presigned links), history and the actions its status allows: approve, reject (with a note for the
 * shopper), mark received, refund (through Payments when paid online, else recorded), restock (exactly once) and close.
 * @module
 */
import { CLAIM_KINDS, CLAIM_STATUSES } from '../core/returns.js';
import { query } from './admin-kit.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */

/** Actions that only move the claim (with an optional note). */
const MOVES = Object.freeze(['approve', 'reject', 'receive', 'close']);

/**
 * The returns section.
 * @param {Kit} kit @param {HTMLElement} panel
 */
export const returnsTab = (kit, panel) => {
	const { t, h } = kit;
	const line = kit.status();
	const listView = h('div');
	const detailView = h('div');
	const status = kit.select([
		{ value: '', label: t('admin.all') },
		...CLAIM_STATUSES.map((key) => ({ value: key, label: t(`ordersAdmin.claim.${key}`) })),
	]);
	const kind = kit.select([
		{ value: '', label: t('admin.all') },
		...CLAIM_KINDS.map((key) => ({ value: key, label: t(`ordersAdmin.claimKind.${key}`) })),
	]);
	/** @param {any} claim */
	const rowOf = (claim) =>
		h('li', {}, [
			h('div', { class: 'what' }, [
				h('strong', {}, [t('ordersAdmin.claimTitle', { reference: claim.reference, number: claim.orderNumber })]),
				kit.text(
					'span',
					{ class: 'meta' },
					[t(`ordersAdmin.claimKind.${claim.kind}`), t(`ordersAdmin.claim.${claim.status}`), kit.when(claim.createdAt)].join(
						' · ',
					),
				),
			]),
			kit.button(t('admin.open'), () => open(claim.id)),
		]);
	const pages = kit.pager({
		path: (cursor) => `/v1/admin/returns${query({ status: status.value, kind: kind.value, cursor })}`,
		row: rowOf,
		line,
		empty: t('ordersAdmin.noClaims'),
	});
	/** @param {string} id */
	const open = (id) => {
		listView.hidden = true;
		detailView.replaceChildren(
			claimDetail(kit, {
				id,
				done: (changed) => {
					detailView.replaceChildren();
					listView.hidden = false;
					if (changed) void pages.load(true);
				},
			}),
		);
	};
	const filters = h('div', { class: 'row inline' }, [
		kit.field(t('admin.status'), status),
		kit.field(t('ordersAdmin.claimKindLabel'), kind),
	]);
	for (const control of [status, kind]) control.addEventListener('change', () => void pages.load(true));
	listView.append(filters, line, pages.node);
	panel.append(listView, detailView);
	void pages.load(true);
};

/**
 * One claim and its actions.
 * @param {Kit} kit @param {{ id: string, done: (changed: boolean) => void }} options
 */
const claimDetail = (kit, { id, done }) => {
	const { t, h } = kit;
	const box = h('div');
	const line = kit.status();
	box.append(line);
	let changed = false;

	/** @param {any} claim @param {string} [message] */
	const render = (claim, message = '') => {
		const note = kit.status();
		const currency = claim.order?.currency ?? kit.currency;
		/** @param {number} minor */
		const money = (minor) => kit.money(minor, currency);
		/** @param {{ ok: boolean, status: number, data: any }} answer @param {string} text */
		const after = (answer, text) => {
			if (!answer.ok) {
				kit.fail(note, answer);
				return answer;
			}
			changed = true;
			render(answer.data, text);
			return answer;
		};
		const actions = new Set(claim.actions ?? []);
		const shopperNote = kit.input('', { maxlength: '1000' });
		const moves = MOVES.filter((action) => actions.has(action)).map((action) =>
			kit.button(t(`ordersAdmin.claimAction.${action}`), async () =>
				after(
					await kit.call('POST', `/v1/admin/returns/${claim.id}/${action}`, { note: shopperNote.value }),
					t(`ordersAdmin.claimDone.${action}`),
				),
			),
		);
		const amount = kit.input(kit.decimal(claim.refundable), { inputmode: 'decimal' });
		const refund =
			actions.has('refund') && claim.refundable > 0
				? kit.group(t('ordersAdmin.refundTitle'), [
						kit.text(
							'p',
							{ class: 'muted' },
							t(claim.refundsOnline ? 'ordersAdmin.refundsOnline' : 'ordersAdmin.refundsRecorded'),
						),
						kit.field(t('ordersAdmin.refundAmount', { currency }), amount),
						kit.button(t('ordersAdmin.refund'), async () => {
							const minor = kit.amount(amount.value);
							if (minor === null || Number.isNaN(minor) || minor <= 0) return kit.say(note, t('admin.checkNumbers'), true);
							return after(
								await kit.call('POST', `/v1/admin/returns/${claim.id}/refund`, {
									amount: minor,
									note: shopperNote.value,
								}),
								t('ordersAdmin.refundDone', { amount: money(minor) }),
							);
						}),
					])
				: null;
		const restock = actions.has('restock')
			? kit.button(t('ordersAdmin.restock'), async () =>
					after(await kit.call('POST', `/v1/admin/returns/${claim.id}/restock`), t('ordersAdmin.restocked')),
				)
			: null;
		kit.put(box, [
			h('div', { class: 'head' }, [
				kit.text('h3', {}, t('ordersAdmin.claimTitle', { reference: claim.reference, number: claim.orderNumber })),
				kit.button(t('admin.back'), () => done(changed)),
			]),
			kit.h('dl', {}, [
				...[
					[t('admin.status'), t(`ordersAdmin.claim.${claim.status}`)],
					[t('ordersAdmin.claimKindLabel'), t(`ordersAdmin.claimKind.${claim.kind}`)],
					[
						t('ordersAdmin.customer'),
						[claim.order?.customer?.name, claim.order?.customer?.email].filter(Boolean).join(' · '),
					],
					[t('ordersAdmin.claimReason'), claim.reason],
					[t('ordersAdmin.refundedAmount'), claim.refundAmount > 0 ? money(claim.refundAmount) : ''],
					[t('ordersAdmin.restockedAt'), kit.when(claim.restockedAt)],
				]
					.filter(([, value]) => value)
					.flatMap(([label, value]) => [kit.text('dt', {}, String(label)), kit.text('dd', {}, String(value))]),
			]),
			kit.table(
				[t('ordersAdmin.item'), t('ordersAdmin.sku'), t('ordersAdmin.quantity'), t('ordersAdmin.serials')],
				claim.lines.map((/** @type {any} */ item) => [
					[item.name, item.variantName].filter(Boolean).join(' · '),
					item.sku,
					t('ordersAdmin.claimedOf', { claimed: item.quantity, bought: item.bought }),
					(item.serials ?? []).join(', '),
				]),
			),
			claim.photos.length > 0
				? kit.group(t('ordersAdmin.photos'), [
						h(
							'div',
							{ class: 'thumbs' },
							claim.photos
								.filter((/** @type {any} */ photo) => typeof photo.url === 'string')
								.map((/** @type {any} */ photo, /** @type {number} */ index) =>
									h('a', { href: photo.url, target: '_blank', rel: 'noopener noreferrer' }, [
										h('img', { src: photo.url, alt: t('ordersAdmin.photoNumber', { number: index + 1 }) }),
									]),
								),
						),
					])
				: null,
			actions.size > 0
				? kit.group(t('ordersAdmin.claimActions'), [
						kit.field(t('ordersAdmin.shopperNote'), shopperNote),
						h('div', { class: 'actions' }, [...moves, restock]),
					])
				: null,
			refund,
			note,
			kit.group(t('ordersAdmin.history'), [
				h(
					'ul',
					{},
					[...claim.history]
						.reverse()
						.map((/** @type {any} */ entry) =>
							kit.text(
								'li',
								{},
								[kit.when(entry.at), t(`ordersAdmin.claim.${entry.status}`), entry.by, entry.note]
									.filter(Boolean)
									.join(' · '),
							),
						),
				),
			]),
		]);
		kit.say(note, message);
	};

	void kit.call('GET', `/v1/admin/returns/${id}`).then((answer) => {
		if (answer.ok) render(answer.data);
		else {
			kit.fail(line, answer);
			box.append(kit.button(t('admin.back'), () => done(false)));
		}
	});
	return box;
};
