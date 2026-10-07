/**
 * Money display (pure): integer minor units in the currency's own number of decimals, in the shopper's locale. No
 * currency or locale is assumed — both come from the data and the website's strings.
 * @module
 */

/**
 * @param {{ amount: number, currency: string } | null | undefined} money
 * @param {string | undefined} locale BCP 47, from the strings catalog (`wishlist.locale`) or the element config
 * @returns {string}
 */
export const formatMoney = (money, locale) => {
	if (!money) return '';
	/** @param {string | undefined} tag */
	const format = (tag) => {
		const fmt = new Intl.NumberFormat(tag, { style: 'currency', currency: money.currency });
		return fmt.format(money.amount / 10 ** (fmt.resolvedOptions().maximumFractionDigits ?? 2));
	};
	try {
		return format(locale);
	} catch {
		return format(undefined);
	}
};
