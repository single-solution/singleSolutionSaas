/**
 * Absolute bounds of the product (pure constants). Feature limits from the entitlement document (schemas/) can only
 * narrow them; nothing here is a per-website value.
 * @module
 */

export const LIMITS = Object.freeze({
	/** Option groups per configurator. */
	groups: 30,
	/** Options per group. */
	options: 200,
	/** Combinations (variant matrix rows) per configurator. */
	combinations: 10_000,
	/** Exclusion rules per configurator. */
	rules: 200,
	/** Price rules per configurator. */
	priceRules: 200,
	/** Length of keys, labels, descriptions and rule sources. */
	keyLength: 64,
	optionKeyLength: 100,
	labelLength: 200,
	descriptionLength: 1000,
	messageLength: 300,
	urlLength: 2048,
	ruleSourceLength: 2000,
	/** Longest text a `text` group accepts. */
	textLength: 2000,
	/** Largest absolute value of a range bound. */
	rangeAbs: 1_000_000_000,
	/** Range groups with at most this many steps are searched exhaustively. */
	rangeEnumeration: 101,
	/** Multi-choice groups with at most this many visible options are searched over every subset. */
	multiEnumeration: 6,
	/** Largest absolute money amount (integer minor units) of a base price, a delta or a combination price. */
	amount: 10_000_000_000,
	/** Percent price rules in basis points (1 % = 100). */
	basisPointsMin: -10_000,
	basisPointsMax: 100_000,
	/** Largest rounding increment. */
	roundingIncrement: 1_000_000,
	/** Largest quantity priced at once. */
	quantity: 100_000,
	/** Resolver search steps (upper bound of the `resolver.max_steps` feature). */
	steps: 200_000,
	/** Popularity score of an option. */
	popularity: 1_000_000_000,
	/** Stock count of an option or combination. */
	stock: 1_000_000_000,
});
