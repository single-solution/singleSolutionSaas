/**
 * Copy for deal views (pure, DOM-free): money in the shopper's locale and the cart's currency, reward labels,
 * countdowns and condition notes — every word comes from the string catalog, so websites translate and retone it.
 * @module
 */

/** @typedef {(key: string, params?: Readonly<Record<string, string | number>>) => string} Translate */

/** @type {Map<string, Intl.NumberFormat>} */
const formats = new Map();

/**
 * Format integer minor units as money.
 * @param {string} locale
 * @param {string} currency ISO-4217
 * @returns {(minor: number) => string}
 */
export const moneyFormatter = (locale, currency) => {
	const key = `${locale}|${currency}`;
	let format = formats.get(key);
	if (!format) {
		try {
			format = new Intl.NumberFormat(locale, { style: 'currency', currency });
		} catch {
			format = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
		}
		formats.set(key, format);
	}
	const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
	const f = format;
	return (minor) => f.format(minor / 10 ** digits);
};

/**
 * Label of a reward summary (`core/evaluate.js#rewardSummary`): merchant badge text wins over the generated one.
 * @param {Translate} t
 * @param {Record<string, any>} reward
 * @param {(minor: number) => string} money
 * @returns {string}
 */
export const rewardText = (t, reward, money) => {
	const amount = typeof reward.amount === 'number' ? money(reward.amount) : '';
	if (reward.bundle === 'mix_and_match' || reward.bundle === 'buy_together')
		return t(`reward.bundle.${reward.bundle}.${reward.type}`, {
			percent: reward.percent ?? 0,
			amount,
			quantity: reward.quantity ?? 0,
		});
	switch (reward.type) {
		case 'percent':
			return t('reward.percent', { percent: reward.percent });
		case 'amount_off':
			return t('reward.amount_off', { amount });
		case 'fixed_price':
			return t('reward.fixed_price', { amount });
		case 'buy_x_get_y':
			return reward.percent !== undefined && reward.percent !== 100
				? t('reward.buy_x_get_y.percent', { buy: reward.buy, get: reward.get, percent: reward.percent })
				: t('reward.buy_x_get_y', { buy: reward.buy, get: reward.get });
		case 'free_shipping':
			return t('reward.free_shipping');
		case 'tiered':
			return reward.upTo ? t('reward.tiered', { reward: rewardText(t, reward.upTo, money) }) : t('reward.tiered.plain');
		case 'tier':
			return reward.percent !== undefined
				? t('reward.percent', { percent: reward.percent })
				: reward.amount !== undefined
					? t('reward.amount_off', { amount })
					: t('reward.free_shipping');
		default:
			return t('reward.generic');
	}
};

/**
 * Notes for a deal's cart conditions ("on orders over 50.00", "with card").
 * @param {Translate} t
 * @param {Record<string, any>} conditions
 * @param {(minor: number) => string} money
 * @returns {string[]}
 */
export const conditionNotes = (t, conditions, money) => [
	...(typeof conditions.minSubtotal === 'number'
		? [t('condition.min_subtotal', { amount: money(conditions.minSubtotal) })]
		: []),
	...(typeof conditions.minQuantity === 'number' && conditions.minQuantity > 1
		? [t('condition.min_quantity', { quantity: conditions.minQuantity })]
		: []),
	...(Array.isArray(conditions.paymentMethods)
		? [
				t('condition.payment', {
					methods: conditions.paymentMethods
						.map((m) => (t(`method.${m}`) === `method.${m}` ? m : t(`method.${m}`)))
						.join(', '),
				}),
			]
		: []),
	...(Array.isArray(conditions.deliveryMethods)
		? [
				t('condition.delivery', {
					methods: conditions.deliveryMethods
						.map((m) => (t(`method.${m}`) === `method.${m}` ? m : t(`method.${m}`)))
						.join(', '),
				}),
			]
		: []),
	...(conditions.newCustomersOnly === true ? [t('condition.new_customers')] : []),
];

/**
 * Countdown copy for the time left (ms): days+hours, hours+minutes, or minutes+seconds.
 * @param {Translate} t
 * @param {number} ms
 * @returns {string}
 */
export const countdownText = (t, ms) => {
	const total = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const time =
		days > 0
			? t('countdown.days', { days, hours })
			: hours > 0
				? t('countdown.hours', { hours, minutes })
				: t('countdown.minutes', { minutes, seconds });
	return t('countdown.label', { time });
};

/**
 * Date and time in the website's zone for "starts …" / "ends …" copy.
 * @param {string} locale
 * @param {string} timeZone
 * @returns {(iso: string) => string}
 */
export const dateFormatter = (locale, timeZone) => {
	/** @type {Intl.DateTimeFormat} */
	let format;
	try {
		format = new Intl.DateTimeFormat(locale, {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			timeZone,
		});
	} catch {
		format = new Intl.DateTimeFormat('en', {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			timeZone: 'UTC',
		});
	}
	return (iso) => format.format(new Date(iso));
};
