/**
 * Return and warranty claims in the orders admin widget (feature `returns`, ticket with `returns.manage`; PLAN 0.8.8
 * Returns and warranty, 0.6): a list-and-detail screen — the count of matching claims as a badge, status chips with
 * their counts, the kind, and the claims of one order or one customer (set from a claim's More menu, removable) —
 * beside one claim: its figures, lines, the shopper's photos (short presigned links) and history, with the actions its
 * status and kind allow as dialogs: approve, mark received, mark replaced (exchange and warranty) or repaired (warranty;
 * E33), refund (through Payments when paid online, else recorded), restock (exactly once) and close as buttons or in
 * the More menu, and reject last, in danger text behind its typed confirmation (it needs a note for the shopper).
 * @module
 */
import { CLAIM_KINDS, CLAIM_NOTES, CLAIM_STATUSES } from '../core/returns.js';
import { query } from './admin-kit.js';
import { card, chipFilter, detailHead, listScreen, scopeChip } from './admin-lists.js';
import { CLAIM_TONES, historyBy, warningsText } from './admin-order.js';

/** @typedef {import('./admin-kit.js').Kit} Kit */
/** @typedef {import('./admin-lists.js').Detail} Detail */

/** The actions that move a claim forward, in the order they are offered (the claim's `actions` say which apply). */
const FORWARD = Object.freeze(['approve', 'receive', 'replace', 'repair', 'refund', 'restock', 'close']);

/**
 * The note of a claim's history entry: the website's words for a note the server writes itself (its `code`, or on older
 * entries the code as the note: `ordersAdmin.historyNote.<code>`), else the note as staff typed it.
 * @param {Kit} kit @param {{ note: string, code?: string }} entry
 */
const claimNote = (kit, entry) => {
	const code = entry.code ?? (CLAIM_NOTES.includes(/** @type {any} */ (entry.note)) ? entry.note : '');
	return code ? kit.t(`ordersAdmin.historyNote.${code}`) : entry.note;
};

/**
 * The returns section.
 * @param {Kit} kit @param {HTMLElement} panel
 */
export const returnsTab = (kit, panel) => {
	const { t, h } = kit;
	const reload = () => void screen.reload();
	const chips = chipFilter(kit, {
		label: t('admin.status'),
		choices: [
			{ value: '', label: t('admin.all') },
			...CLAIM_STATUSES.map((key) => ({ value: key, label: t(`ordersAdmin.claim.${key}`) })),
		],
		onChange: reload,
	});
	const kind = kit.select([
		{ value: '', label: t('admin.all') },
		...CLAIM_KINDS.map((key) => ({ value: key, label: t(`ordersAdmin.claimKind.${key}`) })),
	]);
	kind.addEventListener('change', reload);
	/** @type {{ name: 'orderId' | 'userId', value: string }} */
	const scope = { name: 'orderId', value: '' };
	const chip = scopeChip(kit, (value) => {
		scope.value = value;
		reload();
	});

	/** @param {boolean} [withStatus] */
	const filters = (withStatus = true) => ({
		status: withStatus ? chips.value() : '',
		kind: kind.value,
		[scope.name]: scope.value,
	});
	const counts = async () => {
		const [total, byStatus] = await Promise.all([
			kit.call('GET', `/v1/admin/returns/count${query(filters())}`),
			kit.call('GET', `/v1/admin/returns/counts${query({ ...filters(false), by: 'status' })}`),
		]);
		screen.count(total);
		chips.counts(byStatus);
	};

	const screen = listScreen(kit, panel, {
		title: t('ordersAdmin.returns'),
		path: (cursor) => `/v1/admin/returns${query({ ...filters(), cursor })}`,
		row: (claim) => ({
			name: claim.reference,
			figure: claim.refundAmount > 0 ? kit.money(claim.refundAmount) : '',
			meta: [
				t('ordersAdmin.orderHead', { number: claim.orderNumber }),
				t(`ordersAdmin.claimKind.${claim.kind}`),
				t(`ordersAdmin.claim.${claim.status}`),
				kit.when(claim.createdAt),
			].join(' · '),
			tone: CLAIM_TONES[claim.status] ?? 'neutral',
			toneLabel: t(`ordersAdmin.claim.${claim.status}`),
		}),
		open: (claim, detail) =>
			claimDetail(kit, claim.id, detail, {
				/** @param {'orderId' | 'userId'} name @param {string} value @param {string} text */
				narrow: (name, value, text) => {
					scope.name = name;
					chip.set(value, text, t('ordersAdmin.allClaims'));
				},
			}),
		empty: t('ordersAdmin.noClaims'),
		nothing: t('ordersAdmin.nothingClaims'),
		filters: [chips.node, h('div', { class: 'row' }, [kit.field(t('ordersAdmin.claimKindLabel'), kind)]), chip.node],
		counts,
	});
	void screen.reload();
};

/**
 * Show one claim in the detail pane.
 * @param {Kit} kit @param {string} id @param {Detail} detail
 * @param {{ narrow: (name: 'orderId' | 'userId', value: string, text: string) => void }} list
 */
const claimDetail = async (kit, id, detail, list) => {
	const line = kit.status();
	kit.put(detail.pane, [detail.back, line]);
	kit.say(line, kit.t('ordersAdmin.loading'));
	const answer = await kit.call('GET', `/v1/admin/returns/${id}`);
	if (!detail.current()) return;
	if (answer.ok) renderClaim(kit, answer.data, detail, list, '');
	else kit.fail(line, answer);
};

/**
 * @param {Kit} kit @param {any} claim @param {Detail} detail
 * @param {{ narrow: (name: 'orderId' | 'userId', value: string, text: string) => void }} list
 * @param {string} message
 */
const renderClaim = (kit, claim, detail, list, message) => {
	const { t, h } = kit;
	const note = kit.status();
	const currency = claim.order?.currency ?? kit.currency;
	/** @param {number} minor */
	const money = (minor) => kit.money(minor, currency);
	/** @param {any} next @param {string} text */
	const done = (next, text) => {
		renderClaim(kit, next, detail, list, text);
		detail.changed(next);
	};
	const actions = new Set(claim.actions ?? []);
	const forward = FORWARD.filter((action) => actions.has(action) && (action !== 'refund' || claim.refundable > 0));
	/** @param {string} action */
	const run = (action) => () =>
		action === 'refund'
			? refundDialog(kit, claim, money, done)
			: action === 'restock'
				? restockDialog(kit, claim, done)
				: moveDialog(kit, claim, action, done);
	/** @param {string} action */
	const labelOf = (action) =>
		action === 'restock'
			? t('ordersAdmin.restock')
			: action === 'refund'
				? t('ordersAdmin.refund')
				: t(`ordersAdmin.claimAction.${action}`);
	const customer = [claim.order?.customer?.name, claim.order?.customer?.email].filter(Boolean).join(' · ');
	const head = detailHead(
		kit,
		[
			t('ordersAdmin.claimHead', { reference: claim.reference }),
			kit.badge(t(`ordersAdmin.claim.${claim.status}`), CLAIM_TONES[claim.status]),
		],
		[
			...forward.slice(0, 2).map((action, index) => kit.button(labelOf(action), run(action), { primary: index === 0 })),
			kit.moreMenu([
				...forward.slice(2).map((action) => ({ label: labelOf(action), onSelect: run(action) })),
				{
					label: t('ordersAdmin.showOrderClaims'),
					onSelect: () => list.narrow('orderId', claim.orderId, t('ordersAdmin.orderHead', { number: claim.orderNumber })),
				},
				claim.userId
					? {
							label: t('ordersAdmin.showCustomerClaims'),
							onSelect: () =>
								list.narrow('userId', claim.userId, t('ordersAdmin.claimsOf', { name: customer || claim.userId })),
						}
					: null,
				actions.has('reject') ? { label: t('ordersAdmin.claimAction.reject'), onSelect: run('reject'), danger: true } : null,
			]),
		],
	);
	const photos = claim.photos.filter((/** @type {any} */ photo) => typeof photo.url === 'string');
	kit.put(detail.pane, [
		detail.back,
		head,
		note,
		kit.fieldGrid([
			[t('ordersAdmin.claimKindLabel'), t(`ordersAdmin.claimKind.${claim.kind}`)],
			[t('ordersAdmin.claimOrder'), claim.orderNumber],
			[t('ordersAdmin.customer'), customer],
			[t('ordersAdmin.claimedAt'), kit.when(claim.createdAt)],
			[t('ordersAdmin.deliveredAt'), kit.when(claim.order?.deliveredAt)],
			[t('ordersAdmin.claimReason'), claim.reason],
			[t('ordersAdmin.refundedAmount'), claim.refundAmount > 0 ? money(claim.refundAmount) : ''],
			[t('ordersAdmin.refundableAmount'), claim.refundable > 0 ? money(claim.refundable) : ''],
			[t('ordersAdmin.refundsHow'), t(claim.refundsOnline ? 'ordersAdmin.refundsOnline' : 'ordersAdmin.refundsRecorded')],
			[t('ordersAdmin.restockedAt'), kit.when(claim.restockedAt)],
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
		kit.masonry(
			[
				photos.length > 0
					? card(kit, t('ordersAdmin.photos'), [
							h(
								'div',
								{ class: 'thumbs' },
								photos.map((/** @type {any} */ photo, /** @type {number} */ index) =>
									h('a', { href: photo.url, target: '_blank', rel: 'noopener noreferrer' }, [
										h('img', { src: photo.url, alt: t('ordersAdmin.photoNumber', { number: index + 1 }) }),
									]),
								),
							),
						])
					: null,
				card(kit, t('ordersAdmin.history'), [
					h(
						'ul',
						{},
						[...claim.history]
							.reverse()
							.map((/** @type {any} */ entry) =>
								kit.text(
									'li',
									{},
									[
										kit.when(entry.at),
										t(`ordersAdmin.claim.${entry.status}`),
										historyBy(kit, entry),
										claimNote(kit, entry),
									]
										.filter(Boolean)
										.join(' · '),
								),
							),
					),
				]),
			].filter(Boolean),
		),
	]);
	kit.say(note, message);
};

/**
 * Approve, mark received, replaced or repaired, close or reject (with a note for the shopper; a reject needs it and asks
 * for the reference).
 * @param {Kit} kit @param {any} claim @param {string} action @param {(claim: any, text: string) => void} done
 */
const moveDialog = (kit, claim, action, done) => {
	const { t } = kit;
	const rejecting = action === 'reject';
	const note = kit.area('', { maxlength: '1000' });
	kit.dialog({
		title: t(`ordersAdmin.claimAction.${action}`),
		body: [
			rejecting ? kit.text('p', {}, t('ordersAdmin.rejectHint')) : null,
			kit.field(t(rejecting ? 'ordersAdmin.noteForShopperNeeded' : 'ordersAdmin.noteForShopper'), note),
		],
		submitLabel: t(`ordersAdmin.claimAction.${action}`),
		danger: rejecting,
		confirmText: rejecting ? claim.reference : '',
		onSubmit: async () => {
			const answer = await kit.call('POST', `/v1/admin/returns/${claim.id}/${action}`, { note: note.value });
			if (!answer.ok) return kit.reason(answer);
			done(answer.data, t(`ordersAdmin.claimDone.${action}`));
			return null;
		},
	});
};

/**
 * Refund the claim (up to what can still be refunded).
 * @param {Kit} kit @param {any} claim @param {(minor: number) => string} money
 * @param {(claim: any, text: string) => void} done
 */
const refundDialog = (kit, claim, money, done) => {
	const { t } = kit;
	const currency = claim.order?.currency ?? kit.currency;
	const amount = kit.input(kit.decimal(claim.refundable), { inputmode: 'decimal' });
	const note = kit.input('', { maxlength: '1000' });
	kit.dialog({
		title: t('ordersAdmin.refundTitle'),
		body: [
			kit.text('p', { class: 'muted' }, t(claim.refundsOnline ? 'ordersAdmin.refundsOnline' : 'ordersAdmin.refundsRecorded')),
			kit.h('div', { class: 'fields' }, [
				kit.field(t('ordersAdmin.refundAmount', { currency }), amount),
				kit.field(t('ordersAdmin.noteForShopper'), note),
			]),
		],
		submitLabel: t('ordersAdmin.refund'),
		onSubmit: async () => {
			const minor = kit.amount(amount.value);
			if (minor === null || Number.isNaN(minor) || minor <= 0) return t('admin.checkNumbers');
			const answer = await kit.call('POST', `/v1/admin/returns/${claim.id}/refund`, { amount: minor, note: note.value });
			if (!answer.ok) return kit.reason(answer);
			done(
				answer.data,
				[t('ordersAdmin.refundDone', { amount: money(minor) }), ...warningsText(kit, answer.data, money)].join(' '),
			);
			return null;
		},
	});
};

/**
 * Put the claimed units back in stock (exactly once).
 * @param {Kit} kit @param {any} claim @param {(claim: any, text: string) => void} done
 */
const restockDialog = (kit, claim, done) => {
	const { t } = kit;
	kit.dialog({
		title: t('ordersAdmin.restock'),
		body: [kit.text('p', {}, t('ordersAdmin.restockHint'))],
		submitLabel: t('ordersAdmin.restock'),
		onSubmit: async () => {
			const answer = await kit.call('POST', `/v1/admin/returns/${claim.id}/restock`);
			if (!answer.ok) return kit.reason(answer);
			done(answer.data, t('ordersAdmin.restocked'));
			return null;
		},
	});
};
