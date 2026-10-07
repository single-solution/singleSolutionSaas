/**
 * "What happens next" after placement (pure; review lesson A10): the steps follow the order's real state — the payment
 * method and its status, the delivery kind (shipping, pickup, digital) — and the timing texts are the merchant's
 * settings, never a fixed promise. Steps are returned as string keys + parameters; the caller translates them.
 * @module
 */

/**
 * @typedef {object} SuccessSettings the `success_page` feature values
 * @property {string} prep_sla
 * @property {string} ship_sla
 * @property {string} pickup_sla
 * @property {string} confirm_sla
 * @property {boolean} show_bank_details
 * @property {string} continue_url
 */
/**
 * @typedef {object} Step
 * @property {string} key stable step key
 * @property {string} text string key of the step text
 * @property {Record<string, string>} params
 * @property {string | null} when merchant timing text
 * @property {boolean} current
 */

/**
 * @param {Record<string, any>} order
 * @param {SuccessSettings} settings
 * @param {{ formatMoney: (amount: number) => string, proofsEnabled: boolean }} options
 * @returns {Step[]}
 */
export const successSteps = (order, settings, { formatMoney, proofsEnabled }) => {
	const when = (/** @type {string} */ text) => (text.trim() === '' ? null : text.trim());
	/** @type {Step[]} */
	const steps = [];
	const { method, status: paid, dueNow, advance } = order.payment;
	const unpaid = paid !== 'paid';
	if (order.status === 'cancelled' || order.status === 'refunded')
		return [{ key: 'closed', text: `success.step.${order.status}`, params: {}, when: null, current: true }];
	if (order.status === 'pending_payment' && unpaid) {
		if (method === 'bank_transfer' || (method === 'cod' && advance > 0))
			steps.push({
				key: 'pay',
				text: method === 'cod' ? 'success.step.pay_advance' : 'success.step.pay_transfer',
				params: { amount: formatMoney(dueNow), number: order.number },
				when: null,
				current: true,
			});
		if ((method === 'bank_transfer' || method === 'cod') && proofsEnabled)
			steps.push({
				key: 'proof',
				text: 'success.step.upload_proof',
				params: { number: order.number },
				when: null,
				current: false,
			});
		if (method === 'gateway')
			steps.push({
				key: 'pay',
				text: 'success.step.pay_online',
				params: { amount: formatMoney(dueNow) },
				when: null,
				current: true,
			});
	}
	if (order.status === 'awaiting_confirmation')
		steps.push({ key: 'confirm', text: 'success.step.confirm', params: {}, when: when(settings.confirm_sla), current: true });
	steps.push({
		key: 'prepare',
		text: 'success.step.prepare',
		params: {},
		when: when(settings.prep_sla),
		current: steps.length === 0,
	});
	const kind = order.delivery?.kind ?? 'ship';
	if (kind === 'pickup')
		steps.push({
			key: 'pickup',
			text: method === 'pickup_pay' ? 'success.step.pickup_pay' : 'success.step.pickup',
			params: {
				location: order.pickupLocation?.name ?? '',
				amount: formatMoney(order.payment.dueLater ?? 0),
				number: order.number,
			},
			when: when(settings.pickup_sla),
			current: false,
		});
	else if (kind === 'digital')
		steps.push({ key: 'deliver', text: 'success.step.digital', params: {}, when: null, current: false });
	else
		steps.push({
			key: 'ship',
			text: method === 'cod' ? 'success.step.ship_cod' : 'success.step.ship',
			params: { amount: formatMoney(order.payment.dueLater ?? 0) },
			when: when(settings.ship_sla),
			current: false,
		});
	return steps;
};
