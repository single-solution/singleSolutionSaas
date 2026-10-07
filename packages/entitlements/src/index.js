/**
 * @ss/entitlements — pure commerce core: catalog normalisation, entitlement resolution,
 * quotas, hourly settlement and spend caps. No I/O; time is always a parameter.
 * Money is integer millicredits (1 credit = 1000 millicredits). See README.md.
 */

export {
	MILLICREDITS_PER_CREDIT,
	assertMillicredits,
	chargeFor,
	isMillicredits,
	normaliseRate,
	rateFromCredits,
	reduceRate,
	toCredits,
	toMillicredits,
} from './units.js';
export { HOUR_MS, ceilHour, floorHour, isoHour, isoInstant, toMs } from './time.js';
export { deepEqual, sha256Hex, stableStringify } from './hash.js';
export {
	FEATURE_KINDS,
	PERIOD_UNITS,
	RATE_WINDOWS,
	currentPriceBook,
	findPriceBook,
	isCountKind,
	isNumericFeature,
	isValidFeatureValue,
	normaliseFeatureKey,
	normaliseProduct,
	planDefaults,
	withinPlanMax,
} from './catalog.js';
export { AUTHORITY, LAYERS, contentHash, pickEffective, resolveEntitlement } from './resolve.js';
export { SOURCE_NAMES, toDocument } from './document.js';
export { overageCharge, periodBounds, quotaAllows, quotaState, wallToInstant, zoneOffset } from './quotas.js';
export {
	balanceAfter,
	burnRate,
	hourlyCharge,
	hoursRemaining,
	nextCursor,
	planMeteredSettlement,
	planSettlement,
	priceBookResolver,
	projectedMonth,
} from './settlement.js';
export { spendCapDecision, spendCapState } from './spend.js';
