/**
 * The defaults and allowed values the code keeps beside a settings schema (it reads them from the settings without
 * asking the schema) say what the schema says.
 */
import { describe, expect, it } from 'vitest';
import checkout from '../schemas/checkout.settings.json' with { type: 'json' };
import deals from '../schemas/deals.settings.json' with { type: 'json' };
import invoices from '../schemas/invoices.settings.json' with { type: 'json' };
import loyalty from '../schemas/loyalty.settings.json' with { type: 'json' };
import { DEAL_RULES, dealRulesOf } from '../core/deals.js';
import { DEFAULT_COLUMNS, invoiceColumnsOf } from '../core/invoice.js';
import { LOYALTY_DEFAULTS, loyaltyRules } from '../core/loyalty.js';
import { DEFAULT_NUMBER_PATTERN, numberFormOf } from '../core/order-numbers.js';

/** @typedef {{ properties: Record<string, any> }} Schema */
const schemas = /** @type {Record<'checkout' | 'deals' | 'invoices' | 'loyalty', Schema>} */ (
	/** @type {unknown} */ ({ checkout, deals, invoices, loyalty })
);

/**
 * @param {Schema} schema
 * @returns {Record<string, unknown>}
 */
const defaultsOf = (schema) => Object.fromEntries(Object.entries(schema.properties).map(([key, node]) => [key, node.default]));

/**
 * Every allowed value of the schema's choices is kept by `read`, and a value the schema does not allow is not.
 * @param {Schema} schema
 * @param {(settings: Record<string, unknown>) => Record<string, any>} read
 * @param {string[]} keys the settings that are choices
 */
const keepsChoices = (schema, read, keys) => {
	for (const key of keys) {
		const allowed = schema.properties[key].enum;
		expect(Array.isArray(allowed), key).toBe(true);
		for (const value of allowed) expect(read({ [key]: value })[key], `${key} ${value}`).toBe(value);
		expect(read({ [key]: 'not allowed' })[key], key).toBe(schema.properties[key].default);
	}
};

describe('settings defaults kept in code', () => {
	it('loyalty', () => {
		const { roles, ...rest } = defaultsOf(schemas.loyalty);
		expect(LOYALTY_DEFAULTS).toEqual({ ...rest, roles });
		const choices = Object.keys(schemas.loyalty.properties).filter((key) => schemas.loyalty.properties[key].enum);
		keepsChoices(schemas.loyalty, loyaltyRules, choices);
	});

	it('deals', () => {
		const rules = Object.keys(DEAL_RULES);
		expect(DEAL_RULES).toEqual(Object.fromEntries(rules.map((key) => [key, schemas.deals.properties[key].default])));
		keepsChoices(schemas.deals, dealRulesOf, rules);
	});

	it('order numbers', () => {
		expect(DEFAULT_NUMBER_PATTERN).toBe(schemas.checkout.properties.numberPattern.default);
		expect(numberFormOf({}).digits).toBe(schemas.checkout.properties.numberDigits.default);
	});

	it('invoice columns', () => {
		expect(DEFAULT_COLUMNS).toEqual(schemas.invoices.properties.columns.default);
		expect(invoiceColumnsOf({})).toEqual(schemas.invoices.properties.columns.default);
	});
});
