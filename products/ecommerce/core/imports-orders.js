/**
 * The shoppers' and orders' records in import mode (PLAN 0.8.10 K10, Migration: order step 6 and the conversion rules
 * "Money", "Payments", "Orders" and "Loyalty"; IMP-5, IMP-9, IMP-10, IMP-13, IMP-23, IMP-31, IMP-49): the check each
 * record moved in from another system passes before the kit's import routes write it, with the product's own rules
 * where they exist (the order flow, payment states, addresses, shipments, dispatch videos, serial numbers, customer
 * flags, reviews, claims and alerts) and given ids, numbers, past times and histories allowed. Strict, so mapping
 * mistakes show in a dry run: unknown fields are refused by name, text over a limit is refused (never cut), the tenant
 * never comes from a record, and money must add up as checkout adds it (each line: unit price × quantity − discount,
 * plus tax when prices exclude tax; the order: its lines + delivery + fee; `paid` and `refunded` add up the payments
 * and refunds, and the payment state follows from them). Values the shop derives are left out or worked out here
 * (a customer's counts are written as 0 and filled by `finish`), with the pure parts of `finish`. Nothing here sends,
 * emits, holds stock or moves points. No I/O.
 * @module
 */
import { isId } from '@ss/contracts';
import { normalisePhone } from '@ss/contracts/phone';
import { checkAlertInput } from './alerts.js';
import { LIMITS } from './catalog.js';
import { statusOf } from './flow.js';
import { phoneDigitsOf, phoneRules } from './guests.js';
import { ID_PREFIX } from './model.js';
import { MAX_AMOUNT } from './money.js';
import {
	ADDRESS_FIELDS,
	MAX_NOTE,
	MAX_REFERENCE,
	MAX_STAFF_NOTE,
	PAYMENT_METHODS,
	PAYMENT_STATES,
	RECORDED_METHODS,
	checkCustomerEdit,
	paymentStateOf,
	serialsOf,
	shipmentFields,
	videoOf,
} from './orders.js';
import { balanceOf, expireLots } from './points.js';
import { CLAIM_KINDS, CLAIM_STATUSES, REFUND_METHODS, checkClaimInput, checkNote, plainText } from './returns.js';
import { REVIEW_STATUSES, checkReply, checkReviewInput } from './reviews.js';

/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** @typedef {import('./model.js').StatusRole} StatusRole */
/** @typedef {{ path: string, message: string }} ImportError */
/** @typedef {{ ok: true, value: Record<string, unknown> } | { ok: false, errors: ImportError[] }} ImportCheck */

/**
 * What the checks of one import call read of the website (the collections' `prepare`): the order flow, the order
 * number's form (`checkout.numberPrefix`, `numberDigits`), the shop's currency (`catalog.currency`), its phone rules
 * (`checkout.defaultCallingCode`, `trunkPrefix`; business.json's country is not read, so phones come as E.164 or with
 * that setting) and the time of the call.
 * @typedef {{ now: number, flow: OrderFlow, numberPrefix: string, numberDigits: number, currency: string,
 *   phoneRules: { defaultCallingCode: string, trunkPrefix: string } }} ImportRules
 */

/** The longest name of a person (checkout's guest and address name, IMP-31) and e-mail address. */
const MAX_PERSON = 120;
const MAX_EMAIL = 254;
/** Lines of an imported order, units of one line, entries of its logs, at most. */
const MAX_LINES = 100;
const MAX_QUANTITY = 10_000;
const MAX_ENTRIES = 1000;
/** Lots and history entries of an imported loyalty account, at most (the product keeps the newest 200 entries). */
const MAX_LOTS = 5000;
const MAX_POINTS_HISTORY = 5000;
/** Products of a wishlist, at most (as `server/extras-shopper.js` keeps them). */
const MAX_WISHLIST = 200;
/** Photos of a claim, staff notes of a claim, staff ids that opened a record, at most. */
const MAX_PHOTOS = 10;
const MAX_CLAIM_NOTES = 200;
const MAX_SEEN = 50;
/** Longest storage key and https address. */
const MAX_KEY = 300;
const MAX_URL = 2000;
/** Most tries of an alert's message (`core/alerts.js` `ALERT_TRIES`). */
const MAX_TRIES = 5;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** A phone as checkout keeps one the normaliser cannot read (digits, spaces, + ( ) -). */
const PHONE_TEXT = /^\+?[0-9][0-9 ()-]{5,38}$/;
/** A staff member's id (who opened a record), a Payments id, a stored key hash (SHA-256, base64url). */
const STAFF_ID = /^[A-Za-z0-9_.:@-]{1,80}$/;
const PAYMENTS_ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEY_HASH = /^[A-Za-z0-9_-]{43}$/;

/** Order numbers' parts, `<prefix><year>-<sequence>`, as `finish` reads them to set the counters (E30). */
export const NUMBER_PARTS = '^(.*)(\\d{4})-(\\d{1,12})$';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const missing = (value) => value === undefined || value === null;

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A record's known fields, from their names separated by spaces.
 * @param {string} names
 * @returns {ReadonlyArray<string>}
 */
const fieldList = (names) => Object.freeze(names.split(' '));

/**
 * The checks of one record: each reads a value, notes what is wrong with it under its JSON pointer and gives the clean
 * value, so a dry run lists every problem of a record at once.
 */
const checker = () => {
	/** @type {ImportError[]} */
	const errors = [];
	/** @param {string} path @param {string} message */
	const fail = (path, message) => {
		errors.push({ path, message });
	};

	/**
	 * An object with known fields only (each other field is refused by name); null when it is not an object.
	 * @param {unknown} value @param {string} path @param {ReadonlyArray<string>} known @param {string} what
	 * @returns {Record<string, unknown> | null}
	 */
	const fields = (value, path, known, what) => {
		if (!isObject(value)) {
			fail(path, `${what} is an object.`);
			return null;
		}
		for (const name of Object.keys(value))
			if (!known.includes(name)) fail(`${path}/${name}`, `${name} is not a field of ${what}: check the mapping.`);
		return value;
	};

	/**
	 * Text, trimmed ('' when missing); refused when longer than `max` (text is never cut, IMP-31).
	 * @param {unknown} value @param {string} path @param {number} max @param {{ required?: boolean }} [options]
	 */
	const text = (value, path, max, { required = false } = {}) => {
		if (missing(value)) {
			if (required) fail(path, 'This is required.');
			return '';
		}
		if (typeof value !== 'string') {
			fail(path, 'Text is expected.');
			return '';
		}
		const clean = value.trim();
		if (clean.length > max) fail(path, `At most ${max} characters (this has ${clean.length}); text is never cut.`);
		else if (required && clean === '') fail(path, 'This is required.');
		return clean;
	};

	/**
	 * An id with a prefix (`<prefix>_…`); null when it is missing and may be.
	 * @param {unknown} value @param {string} prefix @param {string} path @param {{ nullable?: boolean }} [options]
	 * @returns {string | null}
	 */
	const id = (value, prefix, path, { nullable = false } = {}) => {
		if (nullable && missing(value)) return null;
		if (!isId(value, prefix)) {
			fail(path, `An id ${prefix}_… is expected.`);
			return null;
		}
		return value;
	};

	/**
	 * An Accounts user id, or '' for a guest (missing, null or '').
	 * @param {unknown} value @param {string} path
	 */
	const user = (value, path) => (missing(value) || value === '' ? '' : (id(value, 'usr', path) ?? ''));

	/**
	 * A list of at most `max` items ([] when missing).
	 * @param {unknown} value @param {string} path @param {number} max
	 * @returns {unknown[]}
	 */
	const list = (value, path, max) => {
		if (missing(value)) return [];
		if (!Array.isArray(value)) {
			fail(path, 'A list is expected.');
			return [];
		}
		if (value.length > max) {
			fail(path, `At most ${max} items (this has ${value.length}).`);
			return [];
		}
		return value;
	};

	/**
	 * Ids with a prefix, each once.
	 * @param {unknown} value @param {string} prefix @param {string} path @param {number} max
	 * @returns {string[]}
	 */
	const ids = (value, prefix, path, max) => {
		/** @type {string[]} */
		const out = [];
		for (const [index, item] of list(value, path, max).entries()) {
			const clean = id(item, prefix, `${path}/${index}`);
			if (clean) out.push(clean);
		}
		if (new Set(out).size !== out.length) fail(path, 'An id is listed twice.');
		return out;
	};

	/**
	 * A whole number from `min` to `max` (money in minor units by default), else `fallback` when missing.
	 * @param {unknown} value @param {string} path @param {{ min?: number, max?: number, fallback?: number }} [options]
	 */
	const whole = (value, path, { min = 0, max = MAX_AMOUNT, fallback } = {}) => {
		if (missing(value) && fallback !== undefined) return fallback;
		if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
			fail(path, `A whole number from ${min} to ${max} is expected.`);
			return fallback ?? min;
		}
		return Number(value);
	};

	/**
	 * A whole number or null (missing = null).
	 * @param {unknown} value @param {string} path @param {{ max?: number }} [options]
	 * @returns {number | null}
	 */
	const wholeOrNull = (value, path, { max = MAX_AMOUNT } = {}) => (missing(value) ? null : whole(value, path, { max }));

	/**
	 * true or false, else `fallback` when missing.
	 * @param {unknown} value @param {string} path @param {boolean} [fallback]
	 */
	const flag = (value, path, fallback) => {
		if (missing(value) && fallback !== undefined) return fallback;
		if (typeof value !== 'boolean') {
			fail(path, 'true or false is expected.');
			return fallback ?? false;
		}
		return value;
	};

	/**
	 * One of the values allowed, else `fallback` when missing.
	 * @template {string} T
	 * @param {unknown} value @param {ReadonlyArray<T>} allowed @param {string} path @param {T} [fallback]
	 * @returns {T}
	 */
	const oneOf = (value, allowed, path, fallback) => {
		if (missing(value) && fallback !== undefined) return fallback;
		if (!allowed.includes(/** @type {T} */ (value))) {
			fail(path, `One of ${allowed.join(', ')} is expected.`);
			return /** @type {T} */ (fallback ?? allowed[0]);
		}
		return /** @type {T} */ (value);
	};

	/**
	 * A time (ISO 8601) as a Date: a past one unless `future`; null when it is missing and may be.
	 * @param {unknown} value @param {string} path @param {number} now @param {{ nullable?: boolean, future?: boolean }} [options]
	 * @returns {Date | null}
	 */
	const time = (value, path, now, { nullable = false, future = false } = {}) => {
		if (missing(value)) {
			if (!nullable) fail(path, 'A time (ISO 8601) is required.');
			return null;
		}
		const at = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : Number.NaN;
		if (Number.isNaN(at)) {
			fail(path, 'A time (ISO 8601) is expected.');
			return null;
		}
		if (!future && at > now) {
			fail(path, 'A past time is expected.');
			return null;
		}
		return new Date(at);
	};

	/**
	 * An e-mail address, lower case ('' when missing).
	 * @param {unknown} value @param {string} path
	 */
	const email = (value, path) => {
		const clean = text(value, path, MAX_EMAIL).toLowerCase();
		if (clean !== '' && !EMAIL.test(clean)) fail(path, 'An e-mail address or nothing is expected.');
		return clean;
	};

	/**
	 * A phone as E.164 by the website's rules (`@ss/contracts/phone`, K12) ('' when missing). With `strict` it must be
	 * one (a customer's, an alert's); else a phone-like text the normaliser cannot read is kept as checkout keeps it (an
	 * order's).
	 * @param {unknown} value @param {string} path @param {ImportRules['phoneRules']} rules
	 * @param {{ required?: boolean, strict?: boolean }} [options]
	 */
	const phone = (value, path, rules, { required = false, strict = false } = {}) => {
		const raw = text(value, path, 40, { required });
		if (raw === '') return '';
		const normal = normalisePhone(raw, rules);
		if (normal) return normal;
		if (!strict && PHONE_TEXT.test(raw)) return raw;
		fail(path, 'A phone number with its country code (+…) is expected, or set checkout.defaultCallingCode first.');
		return '';
	};

	/**
	 * Staff ids that opened a record (E31).
	 * @param {unknown} value @param {string} path
	 * @returns {string[]}
	 */
	const seen = (value, path) => {
		const out = list(value, path, MAX_SEEN).map((item) => (typeof item === 'string' ? item : ''));
		if (!out.every((item) => STAFF_ID.test(item))) fail(path, 'Staff ids are expected.');
		return out;
	};

	/**
	 * A refusal of one of the product's own checks (`field` without the leading slash), under `base`.
	 * @param {{ ok: false, field: string, message: string }} refusal @param {string} [base]
	 */
	const refused = (refusal, base = '') => fail(`${base}/${refusal.field}`, refusal.message);

	return { errors, fail, fields, text, id, user, list, ids, whole, wholeOrNull, flag, oneOf, time, email, phone, seen, refused };
};

/** @typedef {ReturnType<typeof checker>} Checker */

/**
 * The answer of a check.
 * @param {Checker} c @param {Record<string, unknown>} value
 * @returns {ImportCheck}
 */
const answer = (c, value) => (c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value });

/**
 * The rules of one import call from what the website has (`prepare`).
 * @param {{ flow: unknown, checkout: Record<string, unknown>, catalog: Record<string, unknown>, now: number }} input
 * @returns {ImportRules}
 */
export const importRules = ({ flow, checkout, catalog, now }) => {
	const { defaultCallingCode, trunkPrefix } = phoneRules(checkout, undefined);
	return {
		now,
		flow: /** @type {OrderFlow} */ (flow),
		numberPrefix: typeof checkout.numberPrefix === 'string' ? checkout.numberPrefix : '',
		numberDigits: Math.min(8, Math.max(4, Number.isSafeInteger(checkout.numberDigits) ? Number(checkout.numberDigits) : 6)),
		currency: typeof catalog.currency === 'string' && catalog.currency ? catalog.currency : 'USD',
		phoneRules: { defaultCallingCode, trunkPrefix },
	};
};

// ----------------------------------------------------------------------------------------------------- customers

/** Fields of a customer (`CustomerRecord`); the counts, `lastOrderAt` and `phoneDigits` are derived and ignored. */
const CUSTOMER_FIELDS = fieldList(
	'id userId guest name email phone phoneDigits city blocked blockedReason note seenBy orderCount rtoCount ' +
		'lastOrderAt createdAt updatedAt',
);

/**
 * A customer (`customers`, by `id`): a member (`userId`) or a guest (no `userId`, a phone, E21: one per normalised
 * phone); the phone as E.164; blocked with a reason (as staff block). `orderCount`, `rtoCount` and `lastOrderAt` given
 * are ignored: they are 0 until `finish` counts the customer's orders.
 * @param {Record<string, unknown>} record
 * @param {ImportRules} rules
 * @returns {ImportCheck}
 */
export const checkImportedCustomer = (record, rules) => {
	const c = checker();
	c.fields(record, '', CUSTOMER_FIELDS, 'a customer');
	const id = c.id(record.id, ID_PREFIX.customer, '/id');
	const userId = c.user(record.userId, '/userId');
	const guest = userId === '';
	if (record.guest !== undefined && record.guest !== guest)
		c.fail('/guest', 'guest is true exactly when the customer has no userId.');
	const name = c.text(record.name, '/name', MAX_PERSON, { required: guest });
	const email = c.email(record.email, '/email');
	const phone = c.phone(record.phone, '/phone', rules.phoneRules, { required: guest, strict: true });
	const city = c.text(record.city, '/city', ADDRESS_FIELDS.city);
	const flags = checkCustomerEdit({
		blocked: record.blocked ?? false,
		blockedReason: record.blockedReason,
		note: record.note ?? '',
	});
	if (!flags.ok) c.refused(flags);
	const createdAt = c.time(record.createdAt, '/createdAt', rules.now, { nullable: true });
	return answer(c, {
		id,
		userId: guest ? null : userId,
		guest,
		name,
		email,
		phone,
		phoneDigits: phoneDigitsOf(phone),
		city,
		blocked: flags.ok ? flags.value.blocked === true : false,
		blockedReason: flags.ok ? (flags.value.blockedReason ?? '') : '',
		note: flags.ok ? (flags.value.note ?? '') : '',
		seenBy: c.seen(record.seenBy, '/seenBy'),
		orderCount: 0,
		rtoCount: 0,
		lastOrderAt: null,
		...(createdAt ? { createdAt } : {}),
	});
};

// -------------------------------------------------------------------------------------------------------- orders

/** Fields of an order and its parts (`OrderRecord`); `role` must be the flow's, `phoneDigits` is derived. */
const ORDER_FIELDS = fieldList(
	'id number customer address delivery lines totals promotions payment payments refunds status role history ' +
		'shipment media seenBy phoneDigits accessKeyHash stockHeld returnRestocked claimRestockedAt holdUntil ' +
		'idempotencyKey note staffNote placedAt deliveredAt createdAt updatedAt',
);
const ORDER_CUSTOMER_FIELDS = fieldList('userId customerId name email phone');
const DELIVERY_FIELDS = fieldList('method zone fee locationId');
const LINE_FIELDS = fieldList(
	'id productId variantId kind name variantName sku grade gradeLabel image unitPrice quantity discount tax ' +
		'total cost categoryIds brandId locationId serials booking licences downloads returnedQuantity ' +
		'warrantyDays dealId',
);
const TOTALS_FIELDS = fieldList('subtotal discount delivery tax total currency taxIncluded fee roleDiscount');
const PROMOTIONS_FIELDS = fieldList(
	'couponId couponCode dealIds bundleIds pointsRedeemed pointsValue pointsEarned released role pointsFixed ' +
		'pointsCredited pointsBlocked pointsReversed',
);
const PAYMENT_FIELDS = fieldList(
	'method state paymentId advance paid refunded checkedAt checkoutUrl via proof voidedAt voidPendingAt',
);
const PAYMENT_ENTRY_FIELDS = fieldList('id method amount reference proofKey note by at');
const REFUND_ENTRY_FIELDS = fieldList('id method amount reference claimId note by at refundId manual');
const BY_FIELDS = fieldList('kind id name role email');
const HISTORY_FIELDS = fieldList('at from to by note reason kind');
const SHIPMENT_FIELDS = fieldList('courier trackingNumber trackingUrl booked status checkedAt trackingNote estimatedDeliveryAt');
const MEDIA_FIELDS = fieldList('kind key url at by');

/** Why an order moved (E27: a return's, or a cancel's). */
const MOVE_REASONS = Object.freeze(/** @type {const} */ (['rto', 'customer_return', 'staff', 'shopper', 'expired']));
/** History entries that are not moves. */
const ENTRY_KINDS = Object.freeze(/** @type {const} */ (['edited', 'payment', 'refund']));
/** Roles of orders never delivered: they have no delivery time (IMP-9). */
const UNDELIVERED_ROLES = Object.freeze(
	/** @type {StatusRole[]} */ ([
		'awaiting_payment',
		'awaiting_confirmation',
		'open',
		'packed',
		'shipped',
		'cancelled',
		'returned_to_origin',
	]),
);
/** Roles whose orders gave their stock back: they hold none (IMP-49). */
const RELEASED_ROLES = Object.freeze(/** @type {StatusRole[]} */ (['cancelled', 'returned_to_origin', 'returned']));
/** Roles that wait (the only ones with a time to wait until). */
const WAITING = Object.freeze(/** @type {StatusRole[]} */ (['awaiting_payment', 'awaiting_confirmation']));
/** Who wrote a log entry when an import does not say. */
const IMPORTED_BY = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/**
 * The website's order number form: `<prefix><year>-<sequence>`, the sequence of at least `numberDigits` digits (E30).
 * @param {ImportRules} rules
 */
const numberForm = (rules) => new RegExp(`^${escapeRegex(rules.numberPrefix)}\\d{4}-\\d{${rules.numberDigits},12}$`);

/**
 * Who made a payment or refund entry ({@link IMPORTED_BY} when not given).
 * @param {Checker} c @param {unknown} value @param {string} path
 */
const byOf = (c, value, path) => {
	if (missing(value)) return { ...IMPORTED_BY };
	const by = c.fields(value, path, BY_FIELDS, 'who') ?? {};
	const role = c.text(by.role, `${path}/role`, 60);
	const email = c.email(by.email, `${path}/email`);
	return {
		kind: c.text(by.kind, `${path}/kind`, 20, { required: true }),
		id: c.text(by.id, `${path}/id`, 80, { required: true }),
		name: c.text(by.name, `${path}/name`, MAX_PERSON, { required: true }),
		...(role ? { role } : {}),
		...(email ? { email } : {}),
	};
};

/**
 * The order's customer (`customerId` is required: every imported order has its customer record).
 * @param {Checker} c @param {unknown} value @param {ImportRules} rules
 */
const orderCustomerOf = (c, value, rules) => {
	const input = c.fields(value, '/customer', ORDER_CUSTOMER_FIELDS, 'the order’s customer') ?? {};
	return {
		userId: c.user(input.userId, '/customer/userId'),
		name: c.text(input.name, '/customer/name', MAX_PERSON),
		email: c.email(input.email, '/customer/email'),
		phone: c.phone(input.phone, '/customer/phone', rules.phoneRules),
		customerId: c.id(input.customerId, ID_PREFIX.customer, '/customer/customerId') ?? '',
	};
};

/**
 * The delivery address (null for pickup, digital and booking-only orders), at the lengths staff edits take.
 * @param {Checker} c @param {unknown} value @param {ImportRules} rules
 * @returns {Record<string, string> | null}
 */
const addressOf = (c, value, rules) => {
	if (missing(value)) return null;
	const input = c.fields(value, '/address', Object.keys(ADDRESS_FIELDS), 'the address') ?? {};
	/** @type {Record<string, string>} */
	const out = {};
	for (const [field, max] of Object.entries(ADDRESS_FIELDS))
		out[field] =
			field === 'phone'
				? c.phone(input.phone, '/address/phone', rules.phoneRules)
				: c.text(input[field], `/address/${field}`, max);
	return out;
};

/**
 * A booked slot of a line (no slot is held by the import).
 * @param {Checker} c @param {unknown} value @param {string} path @param {number} now
 */
const bookingOf = (c, value, path, now) => {
	if (missing(value)) return null;
	const slot = c.fields(value, path, ['start', 'end'], 'a booking');
	if (!slot) return null;
	return {
		start: c.time(slot.start, `${path}/start`, now, { future: true }),
		end: c.time(slot.end, `${path}/end`, now, { future: true }),
	};
};

/**
 * One order line: a snapshot of what was bought, its money as checkout counts it.
 * @param {Checker} c @param {unknown} value @param {string} path @param {boolean} taxIncluded @param {number} now
 */
const lineOf = (c, value, path, taxIncluded, now) => {
	const input = c.fields(value, path, LINE_FIELDS, 'an order line') ?? {};
	const kind = c.oneOf(input.kind, /** @type {const} */ (['physical', 'digital', 'booking']), `${path}/kind`, 'physical');
	const unitPrice = c.whole(input.unitPrice, `${path}/unitPrice`);
	const quantity = c.whole(input.quantity, `${path}/quantity`, { min: 1, max: MAX_QUANTITY });
	const gross = unitPrice * quantity;
	if (gross > MAX_AMOUNT) c.fail(`${path}/unitPrice`, `unitPrice × quantity is at most ${MAX_AMOUNT}.`);
	const discount = c.whole(input.discount, `${path}/discount`, { fallback: 0 });
	const tax = c.whole(input.tax, `${path}/tax`, { fallback: 0 });
	const total = c.whole(input.total, `${path}/total`);
	if (discount > gross) c.fail(`${path}/discount`, 'The discount is at most unitPrice × quantity.');
	const expected = gross - discount + (taxIncluded ? 0 : tax);
	if (total !== expected)
		c.fail(
			`${path}/total`,
			`total is unitPrice × quantity − discount${taxIncluded ? '' : ' + tax'} = ${expected}, not ${total} (spread the order's discount over its lines, IMP-10).`,
		);
	const returnedQuantity = c.whole(input.returnedQuantity, `${path}/returnedQuantity`, { fallback: 0, max: quantity });
	const serials = c.list(input.serials, `${path}/serials`, MAX_QUANTITY);
	if (serials.length > quantity) c.fail(`${path}/serials`, 'At most one serial number per unit.');
	const downloads = missing(input.downloads) ? undefined : c.whole(input.downloads, `${path}/downloads`, { max: 1_000_000 });
	const warrantyDays = missing(input.warrantyDays)
		? undefined
		: c.whole(input.warrantyDays, `${path}/warrantyDays`, { max: LIMITS.days });
	return {
		id: c.id(input.id, ID_PREFIX.line, `${path}/id`) ?? '',
		productId: c.id(input.productId, ID_PREFIX.product, `${path}/productId`) ?? '',
		variantId: c.id(input.variantId, ID_PREFIX.variant, `${path}/variantId`) ?? '',
		kind,
		name: c.text(input.name, `${path}/name`, LIMITS.name, { required: true }),
		variantName: c.text(input.variantName, `${path}/variantName`, LIMITS.axes * (LIMITS.axisValue + 3)),
		sku: c.text(input.sku, `${path}/sku`, LIMITS.sku),
		grade: missing(input.grade) || input.grade === '' ? null : c.text(input.grade, `${path}/grade`, 40),
		gradeLabel: c.text(input.gradeLabel, `${path}/gradeLabel`, 60),
		image: missing(input.image) || input.image === '' ? null : c.text(input.image, `${path}/image`, MAX_KEY),
		unitPrice,
		quantity,
		discount,
		tax,
		total,
		cost: c.wholeOrNull(input.cost, `${path}/cost`),
		categoryIds: c.ids(input.categoryIds, ID_PREFIX.category, `${path}/categoryIds`, LIMITS.categories),
		brandId: c.id(input.brandId, ID_PREFIX.brand, `${path}/brandId`, { nullable: true }),
		locationId: c.id(input.locationId, ID_PREFIX.location, `${path}/locationId`, { nullable: true }),
		serials,
		booking: bookingOf(c, input.booking, `${path}/booking`, now),
		licences: c.ids(input.licences, ID_PREFIX.licence, `${path}/licences`, MAX_QUANTITY),
		returnedQuantity,
		...(downloads === undefined ? (kind === 'digital' ? { downloads: 0 } : {}) : { downloads }),
		...(warrantyDays === undefined ? {} : { warrantyDays }),
		...(missing(input.dealId) ? {} : { dealId: c.id(input.dealId, ID_PREFIX.deal, `${path}/dealId`) }),
	};
};

/**
 * The order's totals, as checkout adds them up (IMP-10): `subtotal` the lines' unit price × quantity, `discount` and
 * `tax` their sums, `delivery` the delivery's fee and `total` the lines' totals + delivery + fee.
 * @param {Checker} c @param {Record<string, unknown>} input @param {Array<{ unitPrice: number, quantity: number,
 *   discount: number, tax: number, total: number }>} lines @param {{ fee: number, taxIncluded: boolean }} order the
 *   delivery fee and whether prices include tax @param {ImportRules} rules
 */
const totalsOf = (c, input, lines, { fee: deliveryFee, taxIncluded }, rules) => {
	const subtotal = c.whole(input.subtotal, '/totals/subtotal');
	const discount = c.whole(input.discount, '/totals/discount', { fallback: 0 });
	const delivery = c.whole(input.delivery, '/totals/delivery', { fallback: 0 });
	const tax = c.whole(input.tax, '/totals/tax', { fallback: 0 });
	const total = c.whole(input.total, '/totals/total');
	const fee = c.whole(input.fee, '/totals/fee', { fallback: 0 });
	const roleDiscount = c.whole(input.roleDiscount, '/totals/roleDiscount', { fallback: 0 });
	const currency = c.text(input.currency, '/totals/currency', 3, { required: true });
	if (currency && currency !== rules.currency) c.fail('/totals/currency', `The shop's currency is ${rules.currency}.`);
	/** @param {(line: { unitPrice: number, quantity: number, discount: number, tax: number, total: number }) => number} pick */
	const sum = (pick) => lines.reduce((n, line) => n + pick(line), 0);
	/** @type {Array<[string, number, number, string]>} */
	const sums = [
		['subtotal', subtotal, sum((line) => line.unitPrice * line.quantity), 'the lines’ unit price × quantity'],
		['discount', discount, sum((line) => line.discount), 'the lines’ discounts (deals, coupon, points, role)'],
		['tax', tax, sum((line) => line.tax), 'the lines’ tax'],
		['delivery', delivery, deliveryFee, 'the delivery fee'],
		['total', total, sum((line) => line.total) + delivery + fee, 'the lines’ totals + delivery + fee'],
	];
	for (const [field, given, expected, what] of sums)
		if (given !== expected) c.fail(`/totals/${field}`, `${field} is ${what} = ${expected}, not ${given} (IMP-10).`);
	if (roleDiscount > discount) c.fail('/totals/roleDiscount', 'The role discount is part of the discount.');
	return { subtotal, discount, delivery, tax, total, currency, taxIncluded, fee, roleDiscount };
};

/**
 * The role price an order got (E19), or null.
 * @param {Checker} c @param {unknown} value
 */
const rolePriceOf = (c, value) => {
	if (missing(value)) return null;
	const raw = c.fields(value, '/promotions/role', ['key', 'percent', 'label'], 'the role price');
	if (!raw) return null;
	return {
		key: c.text(raw.key, '/promotions/role/key', 40, { required: true }),
		percent: c.whole(raw.percent, '/promotions/role/percent', { max: 90 }),
		label: c.text(raw.label, '/promotions/role/label', 60),
	};
};

/**
 * What offers and points did (IMP-49): the flags as given, `released` and, when points were earned, `pointsCredited`
 * required, so a later cancel or return gives back or takes back exactly what the old shop did.
 * @param {Checker} c @param {unknown} value @param {number} discount
 */
const promotionsOf = (c, value, discount) => {
	const input = c.fields(value, '/promotions', PROMOTIONS_FIELDS, 'the promotions') ?? {};
	const pointsRedeemed = c.whole(input.pointsRedeemed, '/promotions/pointsRedeemed', { fallback: 0 });
	const pointsValue = c.whole(input.pointsValue, '/promotions/pointsValue', { fallback: 0 });
	const pointsEarned = c.whole(input.pointsEarned, '/promotions/pointsEarned', { fallback: 0 });
	if (pointsValue > discount) c.fail('/promotions/pointsValue', 'The points’ value is part of the order’s discount (IMP-10).');
	if (pointsRedeemed > 0 !== pointsValue > 0)
		c.fail('/promotions/pointsValue', 'Redeemed points have a value, and a value has redeemed points.');
	if (pointsEarned > 0 && typeof input.pointsCredited !== 'boolean')
		c.fail('/promotions/pointsCredited', 'Say whether the points earned were credited (true or false, IMP-49).');
	/** @type {Record<string, unknown>} */
	const optional = {};
	for (const name of ['pointsFixed', 'pointsCredited', 'pointsBlocked'])
		if (!missing(input[name])) optional[name] = c.flag(input[name], `/promotions/${name}`);
	if (!missing(input.pointsReversed))
		optional.pointsReversed = c.whole(input.pointsReversed, '/promotions/pointsReversed', { max: pointsEarned });
	return {
		couponId: c.id(input.couponId, ID_PREFIX.coupon, '/promotions/couponId', { nullable: true }),
		couponCode: c.text(input.couponCode, '/promotions/couponCode', 40),
		dealIds: c.ids(input.dealIds, ID_PREFIX.deal, '/promotions/dealIds', 50),
		bundleIds: c.ids(input.bundleIds, ID_PREFIX.bundle, '/promotions/bundleIds', 50),
		pointsRedeemed,
		pointsValue,
		pointsEarned,
		released: c.flag(input.released, '/promotions/released'),
		role: rolePriceOf(c, input.role),
		...optional,
	};
};

/**
 * The payments log (E26).
 * @param {Checker} c @param {unknown} value @param {number} now
 */
const paymentEntriesOf = (c, value, now) =>
	c.list(value, '/payments', MAX_ENTRIES).map((raw, index) => {
		const path = `/payments/${index}`;
		const input = c.fields(raw, path, PAYMENT_ENTRY_FIELDS, 'a payment') ?? {};
		return {
			id: c.id(input.id, ID_PREFIX.orderPayment, `${path}/id`) ?? '',
			method: c.oneOf(input.method, [...RECORDED_METHODS, /** @type {const} */ ('online')], `${path}/method`),
			amount: c.whole(input.amount, `${path}/amount`, { min: 1 }),
			reference: c.text(input.reference, `${path}/reference`, MAX_REFERENCE),
			proofKey: missing(input.proofKey) || input.proofKey === '' ? null : c.text(input.proofKey, `${path}/proofKey`, MAX_KEY),
			note: c.text(input.note, `${path}/note`, MAX_NOTE),
			by: byOf(c, input.by, `${path}/by`),
			at: c.time(input.at, `${path}/at`, now),
		};
	});

/**
 * The refunds log (E26).
 * @param {Checker} c @param {unknown} value @param {number} now
 */
const refundEntriesOf = (c, value, now) =>
	c.list(value, '/refunds', MAX_ENTRIES).map((raw, index) => {
		const path = `/refunds/${index}`;
		const input = c.fields(raw, path, REFUND_ENTRY_FIELDS, 'a refund') ?? {};
		const refundId = missing(input.refundId) || input.refundId === '' ? null : c.text(input.refundId, `${path}/refundId`, 80);
		return {
			id: c.id(input.id, ID_PREFIX.orderRefund, `${path}/id`) ?? '',
			method: c.oneOf(input.method, REFUND_METHODS, `${path}/method`),
			amount: c.whole(input.amount, `${path}/amount`, { min: 1 }),
			reference: c.text(input.reference, `${path}/reference`, MAX_REFERENCE),
			claimId: c.id(input.claimId, ID_PREFIX.claim, `${path}/claimId`, { nullable: true }),
			note: c.text(input.note, `${path}/note`, MAX_NOTE),
			by: byOf(c, input.by, `${path}/by`),
			at: c.time(input.at, `${path}/at`, now),
			refundId,
			...(missing(input.manual) ? {} : { manual: c.flag(input.manual, `${path}/manual`) }),
		};
	});

/**
 * A bank transfer's proof the shopper sent (E24), or null.
 * @param {Checker} c @param {unknown} value @param {number} now
 */
const proofOf = (c, value, now) => {
	if (missing(value)) return null;
	const raw = c.fields(value, '/payment/proof', ['key', 'reference', 'at'], 'a transfer proof');
	if (!raw) return null;
	return {
		key: c.text(raw.key, '/payment/proof/key', MAX_KEY, { required: true }),
		reference: c.text(raw.reference, '/payment/proof/reference', MAX_REFERENCE),
		at: c.time(raw.at, '/payment/proof/at', now),
	};
};

/**
 * The order's payment, consistent with its logs (E26, IMP-13): `paid` and `refunded` are the sums of the payments and
 * refunds (derived when missing, refused when different), and the state is the one they give (`paymentStateOf`: with
 * nothing paid an order is unpaid, or pending while Payments is asked; only a free order is paid without a payment).
 * @param {Checker} c @param {unknown} value @param {number} total
 * @param {Array<{ amount: number }>} payments @param {Array<{ amount: number }>} refunds @param {number} now
 */
const paymentOf = (c, value, total, payments, refunds, now) => {
	const input = c.fields(value, '/payment', PAYMENT_FIELDS, 'the payment') ?? {};
	const paid = payments.reduce((n, entry) => n + entry.amount, 0);
	const refunded = refunds.reduce((n, entry) => n + entry.amount, 0);
	if (!missing(input.paid) && input.paid !== paid)
		c.fail('/payment/paid', `paid adds up the payments: ${paid}, not ${String(input.paid)}.`);
	if (!missing(input.refunded) && input.refunded !== refunded)
		c.fail('/payment/refunded', `refunded adds up the refunds: ${refunded}, not ${String(input.refunded)}.`);
	if (paid > total) c.fail('/payments', `The payments (${paid}) are more than the order total (${total}).`);
	if (refunded > paid) c.fail('/refunds', `The refunds (${refunded}) are more than was paid (${paid}).`);
	const given = c.oneOf(input.state, PAYMENT_STATES, '/payment/state', total === 0 ? 'paid' : 'unpaid');
	const state = paymentStateOf({
		total,
		paid,
		refunded,
		state: total === 0 ? 'paid' : given === 'pending' ? 'pending' : 'unpaid',
	});
	if (PAYMENT_STATES.includes(/** @type {any} */ (input.state)) && given !== state)
		c.fail(
			'/payment/state',
			`The payments (${paid} paid, ${refunded} refunded of ${total}) make the state ${state}: add the entries that make it ${given} (IMP-13).`,
		);
	const paymentId =
		missing(input.paymentId) || input.paymentId === '' ? null : c.text(input.paymentId, '/payment/paymentId', 80);
	if (paymentId !== null && !PAYMENTS_ID.test(paymentId)) c.fail('/payment/paymentId', 'A Payments payment id is expected.');
	const checkoutUrl = c.text(input.checkoutUrl, '/payment/checkoutUrl', MAX_URL);
	if (checkoutUrl !== '' && !/^https:\/\//i.test(checkoutUrl)) c.fail('/payment/checkoutUrl', 'An https address is expected.');
	/** @type {Record<string, unknown>} */
	const optional = {};
	if (!missing(input.via)) optional.via = c.oneOf(input.via, /** @type {const} */ (['payments', 'manual']), '/payment/via');
	for (const name of ['voidedAt', 'voidPendingAt'])
		if (!missing(input[name])) optional[name] = c.time(input[name], `/payment/${name}`, now);
	return {
		method: c.oneOf(input.method, PAYMENT_METHODS, '/payment/method'),
		state,
		paymentId,
		advance: c.whole(input.advance, '/payment/advance', { fallback: 0, max: total }),
		paid,
		refunded,
		checkedAt: c.time(input.checkedAt, '/payment/checkedAt', now, { nullable: true }),
		checkoutUrl,
		proof: proofOf(c, input.proof, now),
		...optional,
	};
};

/**
 * The order's history: each status a key of the website's flow, the last entry the status the order is in.
 * @param {Checker} c @param {unknown} value @param {ImportRules} rules @param {string} status
 */
const historyOf = (c, value, { flow, now }, status) => {
	const entries = c.list(value, '/history', MAX_ENTRIES);
	if (entries.length === 0) c.fail('/history', 'At least one entry: the order’s placement.');
	/** @param {unknown} key @param {string} path */
	const statusKey = (key, path) => {
		if (typeof key === 'string' && statusOf(flow, key)) return key;
		c.fail(path, 'A status of the website’s order flow is expected.');
		return '';
	};
	const out = entries.map((raw, index) => {
		const path = `/history/${index}`;
		const input = c.fields(raw, path, HISTORY_FIELDS, 'a history entry') ?? {};
		return {
			at: c.time(input.at, `${path}/at`, now),
			from: missing(input.from) ? null : statusKey(input.from, `${path}/from`),
			to: statusKey(input.to, `${path}/to`),
			by: c.text(input.by, `${path}/by`, MAX_PERSON),
			note: c.text(input.note, `${path}/note`, MAX_NOTE),
			...(missing(input.reason) ? {} : { reason: c.oneOf(input.reason, MOVE_REASONS, `${path}/reason`) }),
			...(missing(input.kind) ? {} : { kind: c.oneOf(input.kind, ENTRY_KINDS, `${path}/kind`) }),
		};
	});
	const last = out[out.length - 1];
	if (last && last.to && last.to !== status)
		c.fail(`/history/${out.length - 1}/to`, `The last entry moves the order to its status ${status}.`);
	return out;
};

/**
 * The shipment (E28): the courier, tracking number, note and expected date as staff give them (`shipmentFields`).
 * @param {Checker} c @param {unknown} value @param {number} now
 */
const shipmentOf = (c, value, now) => {
	if (missing(value)) return null;
	const input = c.fields(value, '/shipment', SHIPMENT_FIELDS, 'the shipment') ?? {};
	const checked = shipmentFields(input);
	if (!checked.ok) c.refused(checked);
	const trackingUrl = c.text(input.trackingUrl, '/shipment/trackingUrl', MAX_URL);
	if (trackingUrl !== '' && !/^https?:\/\//i.test(trackingUrl))
		c.fail('/shipment/trackingUrl', 'An http(s) address is expected.');
	return {
		courier: checked.ok ? checked.value.courier : '',
		trackingNumber: checked.ok ? checked.value.trackingNumber : '',
		trackingUrl,
		booked: c.flag(input.booked, '/shipment/booked', false),
		status: c.text(input.status, '/shipment/status', 60),
		checkedAt: c.time(input.checkedAt, '/shipment/checkedAt', now, { nullable: true }),
		trackingNote: checked.ok ? checked.value.trackingNote : '',
		estimatedDeliveryAt: checked.ok ? checked.value.estimatedDeliveryAt : null,
	};
};

/**
 * Dispatch videos (E28): an upload key, or a YouTube or https address (`videoOf`).
 * @param {Checker} c @param {unknown} value @param {number} now
 */
const mediaOf = (c, value, now) =>
	c.list(value, '/media', 10).map((raw, index) => {
		const path = `/media/${index}`;
		const input = c.fields(raw, path, MEDIA_FIELDS, 'a dispatch video') ?? {};
		c.oneOf(input.kind, /** @type {const} */ (['dispatch_video']), `${path}/kind`);
		const byKey = !missing(input.key);
		const video = videoOf(byKey ? input.key : input.url);
		// an upload key must read as a key, an address as an address
		if (!video || byKey !== 'key' in video)
			c.fail(path, 'A dispatch video is an upload key (key), or a YouTube or https address (url).');
		const by = c.text(input.by, `${path}/by`, MAX_PERSON);
		const at = c.time(input.at, `${path}/at`, now, { nullable: true });
		return { ...(video ?? { kind: 'dispatch_video' }), ...(at ? { at } : {}), ...(by ? { by } : {}) };
	});

/**
 * An order (`orders`, by `id`) with its lines, payments, refunds and history (PLAN 0.8.8 `OrderRecord`): its number
 * kept in the website's form; its status a key of the website's flow (statuses keep their keys), its role the flow's;
 * `deliveredAt` a past time for delivered and returned orders (IMP-9); `idempotencyKey` `import:<id>` when it has none
 * (IMP-23); `stockHeld` and the promotions' flags as given (IMP-49), never true on an order that gave its stock back;
 * the money adding up (IMP-10, IMP-13). `role` given must be the flow's; `phoneDigits` is derived (given is ignored);
 * `createdAt` is the placement time when not given (so imported orders are not "new").
 * @param {Record<string, unknown>} record
 * @param {ImportRules} rules
 * @returns {ImportCheck}
 */
export const checkImportedOrder = (record, rules) => {
	const c = checker();
	const { flow, now } = rules;
	c.fields(record, '', ORDER_FIELDS, 'an order');
	const id = c.id(record.id, ID_PREFIX.order, '/id') ?? '';
	const number = c.text(record.number, '/number', 40, { required: true });
	if (number !== '' && !numberForm(rules).test(number))
		c.fail(
			'/number',
			`An order number of this website is ${rules.numberPrefix}<year>-<at least ${rules.numberDigits} digits> (checkout.numberPrefix and numberDigits).`,
		);
	const status = typeof record.status === 'string' ? record.status : '';
	const definition = statusOf(flow, status);
	if (!definition)
		c.fail('/status', `A status of the website’s order flow is expected: ${flow.statuses.map((s) => s.key).join(', ')}.`);
	const role = definition?.role ?? 'open';
	if (definition && !missing(record.role) && record.role !== role)
		c.fail('/role', `The role of ${status} is ${role} in the order flow.`);

	const customer = orderCustomerOf(c, record.customer, rules);
	const address = addressOf(c, record.address, rules);
	const deliveryInput = c.fields(record.delivery, '/delivery', DELIVERY_FIELDS, 'the delivery') ?? {};
	const delivery = {
		method: c.oneOf(deliveryInput.method, /** @type {const} */ (['delivery', 'pickup', 'none']), '/delivery/method'),
		zone: c.text(deliveryInput.zone, '/delivery/zone', 80),
		fee: c.whole(deliveryInput.fee, '/delivery/fee', { fallback: 0 }),
		locationId: c.id(deliveryInput.locationId, ID_PREFIX.location, '/delivery/locationId', { nullable: true }),
	};
	if (delivery.method === 'delivery' && !address) c.fail('/address', 'A delivered order has its address.');

	const totalsInput = c.fields(record.totals, '/totals', TOTALS_FIELDS, 'the totals') ?? {};
	const taxIncluded = c.flag(totalsInput.taxIncluded, '/totals/taxIncluded');
	if (!Array.isArray(record.lines) || record.lines.length === 0) c.fail('/lines', 'An order has at least one line.');
	const checked = c
		.list(record.lines, '/lines', MAX_LINES)
		.map((raw, index) => lineOf(c, raw, `/lines/${index}`, taxIncluded, now));
	if (new Set(checked.map((line) => line.id)).size !== checked.length) c.fail('/lines', 'Each line has its own id.');
	// serial numbers as staff type them: 1–64 characters, none twice in the order
	const serials = serialsOf(Object.fromEntries(checked.map((line) => [line.id, line.serials])));
	if (!serials.ok) {
		const index = checked.findIndex((line) => serials.field === `serials/${line.id}`);
		c.fail(index >= 0 ? `/lines/${index}/serials` : '/lines', serials.message);
	}
	const lines = checked.map((line) => ({ ...line, serials: serials.ok ? (serials.value[line.id] ?? []) : [] }));
	const totals = totalsOf(c, totalsInput, lines, { fee: delivery.fee, taxIncluded }, rules);
	const promotions = promotionsOf(c, record.promotions, totals.discount);
	const payments = paymentEntriesOf(c, record.payments, now);
	const refunds = refundEntriesOf(c, record.refunds, now);
	const entryIds = [...payments, ...refunds].map((entry) => entry.id);
	if (new Set(entryIds).size !== entryIds.length) c.fail('/payments', 'Each payment and refund has its own id.');
	const payment = paymentOf(c, record.payment, totals.total, payments, refunds, now);
	const history = historyOf(c, record.history, rules, status);

	const placedAt = c.time(record.placedAt, '/placedAt', now);
	const deliveredAt = c.time(record.deliveredAt, '/deliveredAt', now, { nullable: true });
	if (definition && (role === 'delivered' || role === 'returned') && missing(record.deliveredAt))
		c.fail('/deliveredAt', `A ${role} order has its delivery time (the last delivered entry, IMP-9).`);
	if (definition && deliveredAt && UNDELIVERED_ROLES.includes(role))
		c.fail('/deliveredAt', `A ${role} order was never delivered.`);
	if (deliveredAt && placedAt && deliveredAt < placedAt) c.fail('/deliveredAt', 'An order is delivered after it is placed.');
	const stockHeld = c.flag(record.stockHeld, '/stockHeld');
	if (definition && stockHeld && RELEASED_ROLES.includes(role))
		c.fail('/stockHeld', `A ${role} order gave its stock back (IMP-49).`);
	const holdUntil = c.time(record.holdUntil, '/holdUntil', now, { nullable: true, future: true });
	if (definition && holdUntil && !WAITING.includes(role)) c.fail('/holdUntil', 'Only a waiting order has a time to wait until.');
	const accessKeyHash = missing(record.accessKeyHash) ? null : String(record.accessKeyHash);
	if (accessKeyHash !== null && !(typeof record.accessKeyHash === 'string' && KEY_HASH.test(accessKeyHash)))
		c.fail('/accessKeyHash', 'The SHA-256 hash of a guest order’s key (base64url) is expected.');
	const idempotencyKey = c.text(record.idempotencyKey, '/idempotencyKey', 200) || `import:${id}`;
	const createdAt = c.time(record.createdAt, '/createdAt', now, { nullable: true }) ?? placedAt;
	const claimRestockedAt = c.time(record.claimRestockedAt, '/claimRestockedAt', now, { nullable: true });

	return answer(c, {
		id,
		number,
		customer,
		address,
		delivery,
		lines,
		totals,
		promotions,
		payment,
		payments,
		refunds,
		status,
		role,
		history,
		shipment: shipmentOf(c, record.shipment, now),
		media: mediaOf(c, record.media, now),
		seenBy: c.seen(record.seenBy, '/seenBy'),
		phoneDigits: phoneDigitsOf(customer.phone),
		accessKeyHash,
		stockHeld,
		...(missing(record.returnRestocked) ? {} : { returnRestocked: c.flag(record.returnRestocked, '/returnRestocked') }),
		...(claimRestockedAt ? { claimRestockedAt } : {}),
		holdUntil,
		idempotencyKey,
		note: c.text(record.note, '/note', MAX_NOTE),
		staffNote: c.text(record.staffNote, '/staffNote', MAX_STAFF_NOTE),
		placedAt,
		deliveredAt,
		...(createdAt ? { createdAt } : {}),
	});
};

// ------------------------------------------------------------------------------------------------------- loyalty

/** Fields of a loyalty account, its lots and its history (`LoyaltyRecord`). */
const LOYALTY_FIELDS = fieldList('customerId userId lots history balance lifetimeEarned version createdAt updatedAt');
const LOT_FIELDS = fieldList('id points left earnedAt expiresAt orderId kind');
const POINTS_ENTRY_FIELDS = fieldList('at kind points orderId note');
/** Lot kinds (`adapters/ledger.js` `givePoints`; IMP-5: bonus and positive adjust become `adjust` credits). */
const LOT_KINDS = Object.freeze(/** @type {const} */ (['earn', 'refund', 'adjust']));
const POINTS_KINDS = Object.freeze(/** @type {const} */ (['earn', 'redeem', 'refund', 'expire', 'adjust', 'reverse']));

/**
 * What an account ever earned: its `earn` entries (as the ledger counts `lifetimeEarned`).
 * @param {ReadonlyArray<{ kind: string, points: number }>} history
 */
const earnedIn = (history) => history.reduce((n, entry) => n + (entry.kind === 'earn' ? entry.points : 0), 0);

/**
 * A loyalty account's derived values: the balance of its lots not expired at `now`, and what it ever earned (its earn
 * entries; never less than it holds already, since the product keeps only the newest history).
 * @param {{ lots?: import('./model.js').LoyaltyRecord['lots'], history?: import('./model.js').LoyaltyRecord['history'],
 *   lifetimeEarned?: number }} account
 * @param {number} now
 */
export const loyaltyDerived = (account, now) => ({
	balance: balanceOf(expireLots(account.lots ?? [], now).lots),
	lifetimeEarned: Math.max(account.lifetimeEarned ?? 0, earnedIn(account.history ?? [])),
});

/**
 * A loyalty account (`loyalty`, by `customerId`, E20): the lots the importer rebuilt from the old transactions, oldest
 * first (IMP-5), and the history as given. `balance`, `lifetimeEarned` and `version` given are ignored: the balance is
 * the unexpired lots' points left and `lifetimeEarned` the earn entries (again in `finish`).
 * @param {Record<string, unknown>} record
 * @param {ImportRules} rules
 * @returns {ImportCheck}
 */
export const checkImportedLoyalty = (record, rules) => {
	const { now } = rules;
	const c = checker();
	c.fields(record, '', LOYALTY_FIELDS, 'a loyalty account');
	const customerId = c.id(record.customerId, ID_PREFIX.customer, '/customerId');
	const userId = c.user(record.userId, '/userId');
	const lots = c.list(record.lots, '/lots', MAX_LOTS).map((raw, index) => {
		const path = `/lots/${index}`;
		const input = c.fields(raw, path, LOT_FIELDS, 'a lot') ?? {};
		const points = c.whole(input.points, `${path}/points`, { min: 1, max: 1_000_000_000 });
		return {
			id: c.id(input.id, 'lot', `${path}/id`) ?? '',
			points,
			left: c.whole(input.left, `${path}/left`, { max: points }),
			earnedAt: /** @type {Date} */ (c.time(input.earnedAt, `${path}/earnedAt`, now)),
			expiresAt: c.time(input.expiresAt, `${path}/expiresAt`, now, { nullable: true, future: true }),
			orderId: c.id(input.orderId, ID_PREFIX.order, `${path}/orderId`, { nullable: true }),
			...(missing(input.kind) ? {} : { kind: c.oneOf(input.kind, LOT_KINDS, `${path}/kind`) }),
		};
	});
	if (new Set(lots.map((lot) => lot.id)).size !== lots.length) c.fail('/lots', 'Each lot has its own id.');
	const history = c.list(record.history, '/history', MAX_POINTS_HISTORY).map((raw, index) => {
		const path = `/history/${index}`;
		const input = c.fields(raw, path, POINTS_ENTRY_FIELDS, 'a points entry') ?? {};
		return {
			at: /** @type {Date} */ (c.time(input.at, `${path}/at`, now)),
			kind: c.oneOf(input.kind, POINTS_KINDS, `${path}/kind`),
			points: c.whole(input.points, `${path}/points`, { max: 1_000_000_000 }),
			orderId: c.id(input.orderId, ID_PREFIX.order, `${path}/orderId`, { nullable: true }),
			note: c.text(input.note, `${path}/note`, 500),
		};
	});
	const createdAt = c.time(record.createdAt, '/createdAt', now, { nullable: true });
	return answer(c, {
		customerId,
		userId: userId === '' ? null : userId,
		lots,
		history,
		...loyaltyDerived({ lots, history }, now),
		version: 1,
		...(createdAt ? { createdAt } : {}),
	});
};

// ------------------------------------------------------------------------------------------------ shopper extras

/** Fields of a review (`ReviewRecord`). */
const REVIEW_FIELDS = fieldList(
	'id productId userId orderId lineId variantName name rating title body status reply createdAt updatedAt',
);

/**
 * A review (`reviews`, by `id`; E34: of a product, or of one order line with `lineId`): rating, title and text as
 * shoppers write them (`checkReviewInput`), the reply as staff do (`checkReply`).
 * @param {Record<string, unknown>} record
 * @param {ImportRules} rules
 * @returns {ImportCheck}
 */
export const checkImportedReview = (record, rules) => {
	const { now } = rules;
	const c = checker();
	c.fields(record, '', REVIEW_FIELDS, 'a review');
	// the rating, title and text as shoppers write them (the product id is checked as an id below)
	const words = checkReviewInput({ productId: 'prd_checked', rating: record.rating, title: record.title, body: record.body });
	if (!words.ok) c.refused(words);
	const reply = checkReply(record.reply);
	if (!reply.ok) c.fail('/reply', reply.message);
	const createdAt = c.time(record.createdAt, '/createdAt', now, { nullable: true });
	return answer(c, {
		id: c.id(record.id, ID_PREFIX.review, '/id'),
		productId: c.id(record.productId, ID_PREFIX.product, '/productId'),
		userId: c.user(record.userId, '/userId'),
		orderId: c.id(record.orderId, ID_PREFIX.order, '/orderId'),
		lineId: c.id(record.lineId, ID_PREFIX.line, '/lineId', { nullable: true }),
		variantName: c.text(record.variantName, '/variantName', LIMITS.axes * (LIMITS.axisValue + 3)),
		name: c.text(record.name, '/name', 80),
		rating: words.ok ? words.value.rating : 0,
		title: words.ok ? words.value.title : '',
		body: words.ok ? words.value.body : '',
		status: c.oneOf(record.status, REVIEW_STATUSES, '/status'),
		reply: reply.ok ? reply.reply : '',
		...(createdAt ? { createdAt } : {}),
	});
};

/** Fields of a claim, its lines and photos (`ReturnRecord`). */
const CLAIM_FIELDS = fieldList(
	'id reference orderId orderNumber userId kind lines reason photos status refundAmount refundId restockedAt ' +
		'history notes refundMethod refundReference createdAt updatedAt',
);
const CLAIM_LINE_FIELDS = fieldList('lineId quantity serials restock restockedAt');
const PHOTO_FIELDS = fieldList('key type size alt sizes width height blur');

/**
 * A return, warranty or exchange claim (`returns`, by `id`; E33): its lines, reason and kind as shoppers claim them
 * (`checkClaimInput`), its history, notes, refund and restock times as given, and its reference (`R-…`) kept.
 * @param {Record<string, unknown>} record
 * @param {ImportRules} rules
 * @returns {ImportCheck}
 */
export const checkImportedReturn = (record, rules) => {
	const { now } = rules;
	const c = checker();
	c.fields(record, '', CLAIM_FIELDS, 'a claim');
	const rawLines = c.list(record.lines, '/lines', 50);
	const lines = rawLines.map((raw, index) => {
		const path = `/lines/${index}`;
		const input = c.fields(raw, path, CLAIM_LINE_FIELDS, 'a claimed line') ?? {};
		const serials = c
			.list(input.serials, `${path}/serials`, MAX_QUANTITY)
			.map((serial) => (typeof serial === 'string' ? serial.trim() : ''));
		if (serials.some((serial) => serial === '' || serial.length > 64))
			c.fail(`${path}/serials`, 'Serial numbers have 1–64 characters.');
		const restockedAt = c.time(input.restockedAt, `${path}/restockedAt`, now, { nullable: true });
		return {
			lineId: c.id(input.lineId, ID_PREFIX.line, `${path}/lineId`) ?? '',
			quantity: c.whole(input.quantity, `${path}/quantity`, { min: 1, max: MAX_QUANTITY }),
			serials,
			...(missing(input.restock) ? {} : { restock: c.flag(input.restock, `${path}/restock`) }),
			...(missing(input.restockedAt) ? {} : { restockedAt }),
		};
	});
	const claim = checkClaimInput(
		{
			orderId: record.orderId,
			kind: record.kind,
			lines: lines.map(({ lineId, quantity }) => ({ lineId, quantity })),
			reason: record.reason,
		},
		{ maxPhotos: 0, kinds: CLAIM_KINDS },
	);
	if (!claim.ok) c.refused(claim);
	const photos = c.list(record.photos, '/photos', MAX_PHOTOS).map((raw, index) => {
		const path = `/photos/${index}`;
		const input = c.fields(raw, path, PHOTO_FIELDS, 'a photo') ?? {};
		return {
			key: c.text(input.key, `${path}/key`, MAX_KEY, { required: true }),
			type: c.text(input.type, `${path}/type`, 100),
			size: c.whole(input.size, `${path}/size`, { fallback: 0, max: 1_000_000_000 }),
			alt: c.text(input.alt, `${path}/alt`, LIMITS.alt),
		};
	});
	const history = c.list(record.history, '/history', MAX_ENTRIES).map((raw, index) => {
		const path = `/history/${index}`;
		const input = c.fields(raw, path, ['at', 'status', 'by', 'note'], 'a claim history entry') ?? {};
		const note = checkNote(input.note);
		if (!note.ok) c.fail(`${path}/note`, note.message);
		return {
			at: c.time(input.at, `${path}/at`, now),
			status: c.oneOf(input.status, CLAIM_STATUSES, `${path}/status`),
			by: c.text(input.by, `${path}/by`, MAX_PERSON),
			note: note.ok ? note.note : '',
		};
	});
	if (history.length === 0) c.fail('/history', 'At least one entry: the claim’s request.');
	const notes = c.list(record.notes, '/notes', MAX_CLAIM_NOTES).map((raw, index) => {
		const path = `/notes/${index}`;
		const input = c.fields(raw, path, ['at', 'by', 'text'], 'a staff note') ?? {};
		const note = checkNote(input.text, true);
		if (!note.ok) c.fail(`${path}/text`, note.message);
		return {
			at: c.time(input.at, `${path}/at`, now),
			by: c.text(input.by, `${path}/by`, MAX_PERSON),
			text: note.ok ? note.note : '',
		};
	});
	const reference = c.text(record.reference, '/reference', 40);
	const refundReference = plainText(record.refundReference);
	if (refundReference.length > MAX_REFERENCE) c.fail('/refundReference', `At most ${MAX_REFERENCE} characters.`);
	const createdAt = c.time(record.createdAt, '/createdAt', now, { nullable: true }) ?? history[0]?.at ?? null;
	return answer(c, {
		id: c.id(record.id, ID_PREFIX.claim, '/id'),
		...(reference ? { reference } : {}),
		orderId: claim.ok ? claim.value.orderId : '',
		orderNumber: c.text(record.orderNumber, '/orderNumber', 40, { required: true }),
		userId: c.user(record.userId, '/userId'),
		kind: claim.ok ? claim.value.kind : 'return',
		lines,
		reason: claim.ok ? claim.value.reason : '',
		photos,
		status: c.oneOf(record.status, CLAIM_STATUSES, '/status'),
		refundAmount: c.whole(record.refundAmount, '/refundAmount', { fallback: 0 }),
		refundId: missing(record.refundId) || record.refundId === '' ? null : c.text(record.refundId, '/refundId', 80),
		restockedAt: c.time(record.restockedAt, '/restockedAt', now, { nullable: true }),
		history,
		notes,
		...(missing(record.refundMethod) ? {} : { refundMethod: c.oneOf(record.refundMethod, REFUND_METHODS, '/refundMethod') }),
		...(refundReference ? { refundReference } : {}),
		...(createdAt ? { createdAt } : {}),
	});
};

/** Fields of an alert (`AlertRecord`); `dueAt` is never imported. */
const ALERT_FIELDS = fieldList(
	'id kind productId variantId userId email phone customerId price targetPrice status tokenHash tries dueAt ' +
		'createdAt updatedAt',
);

/**
 * A back-in-stock or price-drop alert (`alerts`, by `id`; E34): what it watches as shoppers set it (`checkAlertInput`),
 * for a member (`userId`) or a guest's phone, `waiting`, `sent` or `failed`. Nothing is sent: `dueAt` is always null
 * (a waiting alert is sent once a catalog change makes it due).
 * @param {Record<string, unknown>} record
 * @param {ImportRules} rules
 * @returns {ImportCheck}
 */
export const checkImportedAlert = (record, rules) => {
	const { now } = rules;
	const c = checker();
	c.fields(record, '', ALERT_FIELDS, 'an alert');
	if (!missing(record.dueAt)) c.fail('/dueAt', 'An imported alert is not due: leave dueAt out.');
	const watched = checkAlertInput(record);
	if (!watched.ok) c.refused(watched);
	const kind = watched.ok ? watched.value.kind : 'back_in_stock';
	const userId = c.user(record.userId, '/userId');
	const email = c.email(record.email, '/email');
	const phone = c.phone(record.phone, '/phone', rules.phoneRules, { strict: true, required: userId === '' });
	if (userId !== '' && !email && !phone) c.fail('/email', 'An alert goes to an e-mail address or a phone.');
	const price = c.wholeOrNull(record.price, '/price');
	const targetPrice = c.wholeOrNull(record.targetPrice, '/targetPrice');
	if (kind === 'price_drop' && price === null) c.fail('/price', 'A price-drop alert keeps the price it watches.');
	if (kind === 'back_in_stock' && (price !== null || targetPrice !== null))
		c.fail('/price', 'A back-in-stock alert has no price or target price.');
	if (targetPrice !== null && price !== null && targetPrice >= price)
		c.fail('/targetPrice', 'The target price is below the price.');
	const tokenHash = missing(record.tokenHash) ? '' : String(record.tokenHash);
	if (tokenHash !== '' && !(typeof record.tokenHash === 'string' && KEY_HASH.test(tokenHash)))
		c.fail('/tokenHash', 'The SHA-256 hash of a stop link’s token is expected.');
	const createdAt = c.time(record.createdAt, '/createdAt', now, { nullable: true });
	return answer(c, {
		id: c.id(record.id, ID_PREFIX.alert, '/id'),
		kind,
		productId: watched.ok ? watched.value.productId : '',
		variantId: watched.ok ? watched.value.variantId : null,
		userId,
		email,
		phone,
		customerId: c.id(record.customerId, ID_PREFIX.customer, '/customerId', { nullable: true }),
		price,
		targetPrice,
		status: c.oneOf(record.status, /** @type {const} */ (['waiting', 'sent', 'failed']), '/status'),
		dueAt: null,
		...(missing(record.tries) ? {} : { tries: c.whole(record.tries, '/tries', { max: MAX_TRIES }) }),
		...(tokenHash ? { tokenHash } : {}),
		...(createdAt ? { createdAt } : {}),
	});
};

/**
 * A member's wishlist (`wishlists`, by `userId`; E34): at most 200 products, each once.
 * @param {Record<string, unknown>} record
 * @param {ImportRules} rules
 * @returns {ImportCheck}
 */
export const checkImportedWishlist = (record, rules) => {
	const { now } = rules;
	const c = checker();
	c.fields(record, '', ['userId', 'productIds', 'createdAt', 'updatedAt'], 'a wishlist');
	const createdAt = c.time(record.createdAt, '/createdAt', now, { nullable: true });
	return answer(c, {
		userId: c.id(record.userId, 'usr', '/userId'),
		productIds: c.ids(record.productIds, ID_PREFIX.product, '/productIds', MAX_WISHLIST),
		...(createdAt ? { createdAt } : {}),
	});
};

// -------------------------------------------------------------------------------------------------------- finish

/**
 * The keys of the flow's statuses with the role `returned_to_origin` (a customer's RTO count).
 * @param {OrderFlow} flow
 */
export const rtoKeysOf = (flow) =>
	flow.statuses.filter((status) => status.role === 'returned_to_origin').map((status) => status.key);

/**
 * A customer's counts from their orders' sums (`finish`): orders placed, parcels returned to origin, the last order.
 * @param {ReadonlyArray<{ count: number, rto: number, last: Date | null }>} rows
 * @returns {{ orderCount: number, rtoCount: number, lastOrderAt: Date | null }}
 */
export const customerCounts = (rows) => ({
	orderCount: rows.reduce((n, row) => n + row.count, 0),
	rtoCount: rows.reduce((n, row) => n + row.rto, 0),
	lastOrderAt: rows.reduce(
		(/** @type {Date | null} */ last, row) => (row.last && (!last || row.last.getTime() > last.getTime()) ? row.last : last),
		null,
	),
});

/**
 * Whether an order's lines still hold the serial numbers they list: not when it was cancelled, came back or was
 * returned, nor refunded before delivery (each of those puts its serials back in stock).
 * @param {{ role: string, deliveredAt?: Date | null }} order
 */
export const holdsSerials = (order) =>
	!RELEASED_ROLES.includes(/** @type {StatusRole} */ (order.role)) && !(order.role === 'refunded' && !order.deliveredAt);

/**
 * The serial numbers sold through order lines (`finish`): each one a holding order's line lists, unless a claim of that
 * order put it back in stock.
 * @param {ReadonlyArray<{ id: string, role: string, deliveredAt?: Date | null, lines: ReadonlyArray<{ id: string, serials?: string[] }> }>} orders
 * @param {ReadonlyArray<{ orderId: string, restockedAt?: Date | null, lines?: ReadonlyArray<{ serials?: string[], restock?: boolean,
 *   restockedAt?: Date | null }> }>} claims
 * @returns {Array<{ serial: string, orderId: string, lineId: string }>}
 */
export const serialsSoldTo = (orders, claims) => {
	const back = new Set();
	for (const claim of claims)
		for (const line of claim.lines ?? [])
			if (line.restockedAt || (claim.restockedAt && line.restock !== false))
				for (const serial of line.serials ?? []) back.add(`${claim.orderId}|${serial}`);
	return orders
		.filter(holdsSerials)
		.flatMap((order) =>
			order.lines.flatMap((line) =>
				(line.serials ?? [])
					.filter((serial) => !back.has(`${order.id}|${serial}`))
					.map((serial) => ({ serial, orderId: order.id, lineId: line.id })),
			),
		);
};
