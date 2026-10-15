/**
 * Sisters Boutique's settings and lists for every product it uses (PLAN 0.8.10 Migration step 2, "Per-store settings
 * table", owner decisions D4 and D5, the owner's answers of 2026-10-14; draft `audit/settings-table-draft.md`). Each
 * value is SB's effective one: its saved `Setting` row (read at run time: `store.*`, the SEO rows and three
 * `integration.*` rows, never a secret), else SB's code default (`packages/shared/src/storeSettings.ts`, cited by
 * line), else a value only SB's deployment holds, which is entered by hand ({@link BY_HAND}). Every setting of every
 * feature SB has on is written explicitly, also where SB matches the product default, so a later default change never
 * changes SB (RT-15). Feature switches are entered by hand in the Portal ({@link FEATURES}).
 * @module
 */
import { DEFAULT_CHART_ID } from './catalog.js';
import { CURRENCY, ORDER_DIGITS, ORDER_PATTERN, ORDER_PREFIX, PHONE_FORMAT, isObject, text } from './common.js';
import { STATUSES } from './orders.js';
import { MEMBER_ROLE } from './people.js';

/** @typedef {import('../../mapping.js').SettingsPlan} SettingsPlan */
/** @typedef {import('../../read.js').SourceDb} SourceDb */

/**
 * SB's code defaults, used where no `store.<field>` row is saved (`packages/shared/src/storeSettings.ts`:146-204, the
 * line of each in the comment).
 */
export const STORE_DEFAULTS = Object.freeze({
	siteName: "Sister's Outfits", // :147
	siteTagline: '', // :148
	publicSiteUrl: '', // :149 (empty: SB's *_SITE_URL environment value, entered by hand)
	brandLogoLight: '', // :151
	brandLogoDark: '', // :152
	supportPhone: '', // :156
	supportEmail: '', // :158
	whatsappNumber: '', // :159
	storeAddressLine1: '', // :161
	storeAddressLine2: '', // :162
	storeHours: '', // :163
	freeDeliveryThresholdRupees: 50_000, // :171
	courierFlatFeeRupees: 1_500, // :172
	returnPolicyHtml: `<h2>Return &amp; moneyback</h2><p>You may request a full refund within <strong>15 days</strong> of delivery if the item is unused and in the same condition you received it.</p><ul><li>Contact us on WhatsApp with your order number.</li><li>We arrange pickup or in-store drop-off.</li><li>Refunds are processed to your original payment method once the return is verified.</li></ul>`, // :175
	privacyPolicyHtml: `<h2>Privacy</h2><p>We collect your name, phone number, and delivery address to fulfil orders and send updates on WhatsApp.</p><p>We do not sell your data. Order history is kept for warranty and support. You may ask us to delete your account data by contacting support.</p>`, // :176
	loyaltyEarnPercent: 1, // :177
	memberDiscountPercent: 10, // :178
	paymentBankTransferEnabled: true, // :180
	paymentCodEnabled: true, // :182
	codSurchargePercent: 0, // :183
	bankName: '', // :185
	bankAccountTitle: '', // :186
	bankAccountNumber: '', // :187
	bankIban: '', // :188
	paymentBankTransferNote: '', // :190
	paymentCodNote: '', // :192
	globalDeliveryNote: '3 to 5 working days', // :194
	storeNoticeText: '', // :195
	storeNoticeEnabled: false, // :196
	lowStockThreshold: 2, // :198
	metaPixelId: '', // :200
	googleAnalyticsId: '', // :201
	googleTagManagerId: '', // :202
	tiktokPixelId: '', // :203
});

/** @typedef {{ -readonly [K in keyof typeof STORE_DEFAULTS]: (typeof STORE_DEFAULTS)[K] extends number ? number : (typeof STORE_DEFAULTS)[K] extends boolean ? boolean : string }} StoreValues */

/**
 * SB's effective values: `store` (rows over the code defaults), the SEO rows SB reads, the three integration rows
 * (empty: SB's environment value, by hand) and the active staff (their e-mail and role, for the alert recipients).
 * @typedef {object} SourceValues
 * @property {StoreValues} store
 * @property {{ storeName: string, titleTemplate: string, defaultDescription: string, ogImageDefault: string,
 *   storeLogo: string, robotsDisallow: string[] | null, googleSiteVerification: string }} seo
 * @property {{ staffNotifyEmail: string, adminSiteUrl: string, awsS3PublicUrlBase: string }} integration
 * @property {Array<{ email: string, role: string, isSuperAdmin: boolean }>} staff
 */

/** The features SB has on, per product (switched by hand in the Portal; `import` as well during the move). */
export const FEATURES = Object.freeze({
	accounts: ['phone_password', 'email_password', 'roles', 'staff_links', 'role_requests', 'approval', 'activity_copies'],
	ecommerce: [
		'catalog',
		'variants',
		'size_charts',
		'checkout',
		'cod',
		'delivery_zones',
		'deals',
		'loyalty',
		'role_pricing',
		'staff_alerts',
		'seo',
		'reports',
		'bulk_actions',
		'feeds',
		'landing_pages',
	],
	notifications: ['email'],
	payments: ['bank_transfer'],
	growth: ['meta_pixel', 'google_tags', 'tiktok_pixel', 'robots_verification', 'notice_bar'],
});

/**
 * Settings the plan writes before the product has them (each refused as "No such setting" until its PLAN item is
 * built): the owner's go of 2026-10-14 for SB. None now (E39, points kept on a return, is the order flow's move
 * option `points`).
 */
export const PENDING = Object.freeze(/** @type {Record<string, string>} */ ({}));

/**
 * Settings whose value only SB's deployment holds when no row is saved: entered by hand in the per-store table
 * (`ss-import send --settings <file>`), from SB's environment.
 */
export const BY_HAND = Object.freeze({
	'ecommerce catalog.mediaBaseUrl': 'integration.awsS3PublicUrlBase, else AWS_S3_PUBLIC_URL_BASE',
	'ecommerce staff_alerts.adminUrl': 'integration.adminSiteUrl, else ADMIN_SITE_URL (+ /orders?order={number})',
	'ecommerce staff_alerts.recipients': 'integration.staffNotifyEmail, else STAFF_NOTIFY_EMAIL (added to the list read)',
	'accounts staff_links.setupPageUrl': 'store.publicSiteUrl, else the storefront *_SITE_URL (+ /account/setup/{code})',
	'growth robots_verification.sitemaps': 'store.publicSiteUrl, else the storefront *_SITE_URL (+ /sitemap.xml)',
});

/** SB's robots defaults: the fallback disallow list and `/api/`, always (`apps/web/src/app/robots.ts`:16-17). */
const ROBOTS_FALLBACK = Object.freeze(['/admin', '/account', '/cart', '/checkout']);
const ROBOTS_ALWAYS = '/api/';

/** Staff roles without the Ecommerce permission `orders.read` (Accounts' ready-made roles). */
const WITHOUT_ORDERS = Object.freeze(['product_manager', 'marketing_manager']);

/** An https address with no trailing slash, or ''. @param {string} value */
const address = (value) => (/^https:\/\/[^\s/]+/i.test(value) ? value.replace(/\/+$/, '') : '');

/**
 * The scheme and host of an https address, or '': photo keys are the whole path of SB's addresses (`mediaKey`), so the
 * base Ecommerce adds them to is the bare host.
 * @param {string} value
 */
const origin = (value) => {
	try {
		return address(value) ? new URL(value).origin : '';
	} catch {
		return '';
	}
};

/**
 * The staff alert recipients (`packages/db/src/staffNotifyContacts.ts`:10-39): SB alerts the staff address (else the
 * support address), the support address and every active staff user; Accounts users whose role reads orders get them
 * through `staffPermission: orders.read`, so the list adds the others (product and marketing managers). At most 20.
 * @param {SourceValues} values
 */
const recipientsOf = ({ store, integration, staff }) =>
	[
		...new Set(
			[
				integration.staffNotifyEmail || store.supportEmail,
				store.supportEmail,
				...staff
					.filter((member) => !member.isSuperAdmin && WITHOUT_ORDERS.includes(member.role))
					.map((member) => member.email),
			]
				.map((email) => email.trim().toLowerCase())
				.filter(Boolean),
		),
	].slice(0, 20);

/**
 * The settings plan from SB's effective values.
 * @param {SourceValues} values
 * @returns {SettingsPlan}
 */
export const settingsPlan = (values) => {
	const { store, seo, integration } = values;
	const site = address(store.publicSiteUrl);
	const admin = address(integration.adminSiteUrl);
	const media = origin(integration.awsS3PublicUrlBase);
	const disallow = [...new Set([...(seo.robotsDisallow ?? ROBOTS_FALLBACK), ROBOTS_ALWAYS])];
	// prices are whole rupees ("Rs 12,500", `packages/shared/src/formatters.ts`) and times are the shop's (SF-14, K8)
	const format = { wholeUnits: true, currencyDisplay: 'custom', currencySymbol: 'Rs', locale: 'en', times: 'business' };
	return {
		accounts: {
			format,
			settings: {
				// phone numbers: Pakistan, +92 and the trunk 0 (`packages/shared/src/phone.ts`:21, :56)
				'phone.defaultCallingCode': PHONE_FORMAT.defaultCallingCode,
				'phone.trunkPrefix': PHONE_FORMAT.trunkPrefix,
				// phone codes: the SaaS defaults (SB sends none: Forgot password is its WhatsApp chat); mechanical, to review
				'phone.channel': 'sms',
				'phone.codeLength': 6,
				'phone.codeMinutes': 10,
				'phone.cooldownSeconds': 30,
				'phone.perHour': 6,
				'phone.websitePerHour': 0,
				// addresses: at most 6, name, phone and city needed (`packages/shared/src/customerAddresses.ts`:4, :55-80)
				'profile.maxAddresses': 6,
				'profile.keepOneAddress': false,
				'profile.addressRequired': ['name', 'phone', 'city'],
				// members: invite only (owner 2026-10-14, SA-2); passwords 8–128 with a letter and a digit
				// (`packages/shared/src/validation.ts`:16-18, :83-97); no breach check; owner's lock answer of 2026-10-14
				'phone_password.signUp': false,
				'phone_password.minLength': 8,
				'phone_password.maxLength': 128,
				'phone_password.letterAndDigit': true,
				'phone_password.breachedCheck': false,
				'phone_password.maxAttempts': 20,
				'phone_password.lockMinutes': 1,
				// SaaS default (K-27; SB counts no failures per account): store mapping to review when the owner asks
				'phone_password.forgetHours': 24,
				// forgot password: a WhatsApp chat with the shop (`apps/web/src/app/account/_components/SignIn.tsx`:31)
				'phone_password.selfReset': 'off',
				'phone_password.forgotUrl': store.whatsappNumber
					? `https://wa.me/${store.whatsappNumber}?text=${encodeURIComponent('Salam! I forgot my member password — can you send me a reset link?')}`
					: '',
				// staff: the same password rules; reset links last an hour (`apps/admin/src/app/api/auth/forgot-password/
				// route.ts`:19); 8 tries per network (`packages/shared/src/constants.ts`:214)
				'email_password.minLength': 8,
				'email_password.maxLength': 128,
				'email_password.letterAndDigit': true,
				'email_password.breachedCheck': false,
				'email_password.maxAttempts': 20,
				'email_password.lockMinutes': 1,
				'email_password.forgetHours': 24,
				'email_password.resetMinutes': 60,
				'email_password.resetLimit': 3,
				'email_password.resetHosts': [],
				'passwords.lockMode': 'fixed',
				'passwords.networkLimit': 8,
				'passwords.personalCheck': false,
				// staff-issued codes last 15 minutes (`apps/admin/src/app/api/customers/[id]/access-code/route.ts`:15); setup
				// links 7 days (`apps/admin/src/app/api/membership-requests/[id]/setup-link/route.ts`:16-17)
				'staff_links.codeMinutes': 15,
				'staff_links.setupDays': 7,
				...(site ? { 'staff_links.setupPageUrl': `${site}/account/setup/{code}` } : {}),
				'role_requests.requestableRoles': [MEMBER_ROLE],
				'role_requests.requireNote': false,
				// SB tells a repeat ask that the number already belongs to a member, "already-member"
				// (`apps/web/src/app/api/membership/requests/route.ts`:95-99, `account/_components/RequestMembership.tsx`:56-57):
				// Accounts' detailed answers keep that (its default answers every ask the same)
				'role_requests.revealStatus': true,
				// the member role comes when the setup link is used, not when staff invite
				// (`apps/web/src/app/api/account/setup/route.ts`:68 sets isMember with the password)
				'role_requests.giveRoleAt': 'completion',
				// no sign-up at all (`apps/web/src/lib/auth.ts`:5-15): staff invite
				'approval.mode': 'invite',
				'approval.requiredFields': [],
				'approval.invitePageUrl': '',
				'approval.inviteDays': 7,
			},
		},
		ecommerce: {
			format,
			settings: {
				'catalog.currency': CURRENCY,
				// `apps/web/src/app/[category]/[slug]`, `[category]`; variant links carry the attributes
				// (`packages/shared/src/seo/merchantFeed.ts` `buildVariantPdpPath`)
				'catalog.productUrl': '/{category}/{slug}',
				'catalog.categoryUrl': '/{slug}',
				'catalog.variantQuery': '{attributes}',
				'catalog.retiredUrl': 'none',
				...(media ? { 'catalog.mediaBaseUrl': media } : {}),
				'catalog.mediaPath': '/media',
				'catalog.pageSize': 24, // `apps/web/src/lib/core/queries.ts`:153
				'catalog.lowStock': store.lowStockThreshold,
				'catalog.topBasis': 'delivered', // SaaS default (store mapping to review when the owner asks)
				'catalog.imageMaxBytes': 12_582_912, // `apps/admin/src/lib/uploads/limits.ts`:9-10
				'catalog.showStock': 'always',
				'catalog.lowStockShown': 5,
				'catalog.videoMaxBytes': 67_108_864, // limits.ts:12
				'catalog.search': 'basic',
				'catalog.chatSearch': 'same',
				// the shop search matches the whole phrase in the name (`apps/web/src/lib/core/queries.ts`:363-364)
				'catalog.searchMatch': 'phrase',
				'catalog.searchIndex': 'ss_ecommerce_products_search',
				'size_charts.defaultChartId': DEFAULT_CHART_ID,
				'checkout.numberPattern': ORDER_PATTERN,
				'checkout.numberPrefix': ORDER_PREFIX,
				'checkout.numberSuffix': '',
				'checkout.numberDigits': ORDER_DIGITS,
				// SB sends shoppers no message (owner decision D5, "Store facts corrected after the re-audit")
				'checkout.messageChannels': [],
				'checkout.statusTemplates': 'one',
				'checkout.policyShipping': '',
				'checkout.policyReturns': store.returnPolicyHtml,
				'checkout.policyPrivacy': store.privacyPolicyHtml,
				'checkout.policyTerms': '',
				'checkout.policyWarranty': '',
				'checkout.policyFormat': 'html',
				'checkout.returnsAccepted': 'unknown', // SaaS default (store mapping to review when the owner asks)
				// bank transfer by hand, cash on delivery; no card (D5)
				'checkout.paymentMethods': store.paymentBankTransferEnabled ? ['bank_transfer'] : [],
				'checkout.paymentOrder': ['bank_transfer', 'cod', 'online', 'pickup'], // `apps/web/src/app/checkout/_components/Checkout.tsx`:66
				'checkout.bankTransferVia': 'manual',
				'checkout.noteBankTransfer': store.paymentBankTransferNote || 'Transfer online — send payment screenshot on WhatsApp', // `packages/shared/src/constants.ts`:56
				'checkout.noteCod':
					store.paymentCodNote ||
					(store.codSurchargePercent > 0
						? `+${store.codSurchargePercent}% handling on cash orders`
						: 'Pay when you receive your order'), // constants.ts:63-64
				'checkout.noteOnline': '',
				'checkout.notePickup': '',
				// nothing expires and no open-order cap (no expiry code in SB; `apps/web/src/app/api/orders/route.ts`:107)
				'checkout.paymentWindowMinutes': 0,
				'checkout.confirmationHours': 0,
				'checkout.openOrderCap': 0,
				// the SaaS default (no burst limit; store mapping to review when the owner asks)
				'checkout.placeLimit': 0,
				'checkout.addressRequired': ['line1'],
				// guests order unless the phone is a member's (`apps/web/src/app/api/orders/route.ts`:195-198)
				'checkout.guests': 'unless_password',
				// mechanical defaults (store mapping to review when the owner asks): SB guests order by phone, and every order
				// gives a phone
				'checkout.guestIdentity': 'phone',
				'checkout.phoneRequired': true,
				'checkout.defaultCallingCode': PHONE_FORMAT.defaultCallingCode,
				'checkout.trunkPrefix': PHONE_FORMAT.trunkPrefix,
				'checkout.countries': ['PK'],
				'checkout.customerRecords': 'first_order',
				'checkout.maxLines': 20, // orders/route.ts:102
				'checkout.maxQuantity': 10, // orders/route.ts:105
				'checkout.successUrl': '',
				'checkout.cancelUrl': '',
				// an edit keeps the delivery fee, discount and surcharge placed (`apps/admin/src/app/api/orders/[id]/route.ts`:215)
				'checkout.editPricing': 'keep_placed',
				// a deleted order gives its stock and points back, also once delivered
				'checkout.deleteGivesBack': 'all',
				'checkout.orderUrl': '',
				'checkout.reviewUrl': '',
				'cod.enabled': store.paymentCodEnabled,
				'cod.maxOrderValue': 0,
				'cod.advanceAmount': 0,
				'cod.advancePercent': 0,
				'cod.rtoThreshold': 0,
				'cod.rtoRequireAdvance': false,
				'cod.atPickup': true, // Checkout.tsx:73
				'cod.feePercent': store.codSurchargePercent,
				'cod.feeBase': 'goods_after_discounts', // orders/route.ts:586-587 (D4)
				'cod.paidOnDelivery': true,
				'cod.advanceVia': 'payments',
				'delivery_zones.defaultFee': store.courierFlatFeeRupees * 100,
				'delivery_zones.defaultFreeOver': store.freeDeliveryThresholdRupees * 100,
				// SaaS defaults: no delivery days said (store mapping to review when the owner asks)
				'delivery_zones.handlingDays': [],
				'delivery_zones.transitDays': [],
				'delivery_zones.defaultMethod': 'pickup',
				'delivery_zones.pickupEnabled': true,
				'delivery_zones.pickupName': '',
				'delivery_zones.pickupAddress': [store.storeAddressLine1, store.storeAddressLine2].filter(Boolean).join(', '),
				'delivery_zones.pickupHours': store.storeHours,
				'delivery_zones.deliveryNote': store.globalDeliveryNote,
				'delivery_zones.prepNote': '',
				'delivery_zones.pickupReadyNote': '',
				// D4: SB's totals rules (`packages/shared/src/pricing/offerEvaluator.ts`:222-295, orders/route.ts:566-567)
				'deals.lockMinutes': 0,
				'deals.shopperChoice': false,
				'deals.lineChoice': 'first',
				'deals.cartOffer': 'one_after_items',
				'deals.cartThresholdBase': 'after_item_deals',
				'deals.pointsBlockedBy': 'cart_offer',
				'deals.rounding': 'total_half_up',
				// 1 point = Rs 1, at least 100, at most 20 % (`packages/shared/src/loyalty.ts`:16-22); every order earns on
				// its total when placed, guests too (orders/route.ts:658, orderTransitions.ts:60-105); E39 keep
				'loyalty.earnPercent': store.loyaltyEarnPercent,
				'loyalty.pointValue': 100,
				'loyalty.minRedeem': 100,
				'loyalty.maxPercent': 20,
				'loyalty.expiryDays': 0,
				'loyalty.roles': [],
				'loyalty.guests': 'earn',
				'loyalty.earnBase': 'total',
				'loyalty.earnAt': 'placement',
				'loyalty.capBase': 'order',
				'loyalty.redeemMode': 'maximum',
				'loyalty.expiryUnit': 'days',
				'loyalty.expiryRule': 'at_earn',
				// the SaaS default (E47; store mapping to review when the owner asks)
				'loyalty.memberFlag': 'off',
				// alerts on placement, status changes and cancels (`apps/admin/src/app/api/orders/[id]/route.ts`:336-342); the
				// status changes are each status's staffAlert in the order flow below (E36)
				'staff_alerts.events': ['placed', 'cancelled'],
				'staff_alerts.recipients': recipientsOf(values),
				'staff_alerts.staffPermission': 'orders.read',
				'staff_alerts.phoneChannel': 'whatsapp',
				// SB's staff alerts never showed the shopper's phone
				'staff_alerts.includePhone': false,
				...(admin ? { 'staff_alerts.adminUrl': `${admin}/orders?order={number}` } : {}),
				// SEO (`apps/web/src/lib/seo/seoSettings.ts`:51-62, `packages/shared/src/seo/composeSeoMeta.ts`:224)
				'seo.titleTemplate': (seo.titleTemplate || '{title} | {storeName}')
					.replaceAll('{title}', '{name}')
					.replaceAll('{storeName}', '{business}'),
				'seo.brandName': seo.storeName,
				// the site answer's settings at the SaaS defaults (store mapping to review when the owner asks)
				'seo.alternateName': '',
				'seo.homeTitle': '',
				'seo.homeDescription': '',
				'seo.businessType': 'OnlineStore',
				'seo.socialProfiles': [],
				'seo.productTitle': '{name}',
				'seo.categoryTitle': 'Shop {name}',
				'seo.productDescription': '',
				'seo.categoryDescription': '',
				'seo.variantTitle': '{name} - {options}',
				'seo.pagedListings': 'index',
				'seo.emptyCategories': 'noindex', // SaaS default (store mapping to review when the owner asks)
				'seo.sitemapUrl': '/sitemap.xml',
				'seo.sitemapSize': 10_000,
				'seo.defaultDescription': seo.defaultDescription || store.siteTagline,
				'seo.defaultImage': store.brandLogoLight || store.brandLogoDark || seo.ogImageDefault || seo.storeLogo,
				'seo.indexNowOnSave': false,
				'seo.autoSeo': 'off',
				'seo.faqMarkup': false,
				// the Google feed (`packages/shared/src/seo/merchantFeed.ts`:84-153)
				'feeds.items': 'with_images',
				'feeds.includeOutOfStock': false,
				'feeds.itemTitle': '{brand} {name} ({options})',
				'feeds.itemDescription': 'seo',
				'feeds.descriptionPattern': '{description}', // SaaS default (store mapping to review when the owner asks)
				'feeds.skuAs': 'none',
				'feeds.identifierExists': 'no',
				'feeds.googleCategory': '',
				'feeds.gradeLabel': false,
				'feeds.shipping': true, // SaaS default (store mapping to review when the owner asks)
				// category × brand pages `?brand=` and glossary pages (`packages/shared/src/seo/intentSurface.ts`:33-36,
				// `apps/web/src/app/attributes/[category]/[attribute]`)
				'landing_pages.landingMinProducts': 2,
				'landing_pages.landingUrl': '{categoryUrl}?brand={brand}',
				'landing_pages.attributeUrl': '/attributes/{category}/{slug}',
				'landing_pages.attributeTitle': '{name}',
				'landing_pages.attributeDescription': '',
				'landing_pages.gradeUrl': '',
				'landing_pages.gradeTitle': '{name}', // SaaS default (store mapping to review when the owner asks)
				'landing_pages.gradeDescription': '', // SaaS default (store mapping to review when the owner asks)
				'landing_pages.auto': 'category_brand',
				'landing_pages.autoFacet': '', // SaaS default (store mapping to review when the owner asks)
				'landing_pages.autoMaxPages': 2000, // SaaS default (store mapping to review when the owner asks)
				'landing_pages.autoMinProducts': 2,
				'landing_pages.autoMinInStockVariants': 3,
				'landing_pages.autoCopy': 'formula',
				// SB's formula copy (`packages/shared/src/seo/intentSurface.ts`:180-225)
				'landing_pages.autoTitle': '{brand} {category}',
				'landing_pages.autoDescription':
					'Shop {brand} {category}. From {price}. {products} designs, {variants} in-stock configurations at {storeName}.',
			},
			lists: {
				// SB's moves (`apps/admin/src/app/api/orders/[id]/route.ts`:11-13, :77-123) that the role rules allow, with SB's
				// rules as their options (`packages/db/src/orderTransitions.ts`); SB sends shoppers no message (D5)
				order_flow: {
					statuses: STATUSES.map((status) => ({ ...status, notify: false, staffAlert: status.role !== 'cancelled' })),
					moves: /** @type {Array<[string, string, Record<string, unknown>?]>} */ ([
						// staff confirm a transfer by hand: it counts as paid (OR-7)
						['pending-payment', 'confirmed', { options: { paidOnConfirm: ['bank_transfer'] } }],
						// shoppers cancel before dispatch (`packages/shared/src/orderLifecycle.ts`:2)
						['pending-payment', 'cancelled', { who: ['staff', 'shopper'] }],
						['pending-payment', 'refunded'],
						['awaiting-confirmation', 'confirmed', { options: { paidOnConfirm: ['bank_transfer'] } }],
						['awaiting-confirmation', 'cancelled', { who: ['staff', 'shopper'] }],
						['confirmed', 'pending-payment'],
						// the dispatch video is required when packing (route.ts:106-110)
						['confirmed', 'packed', { options: { video: 'required' } }],
						// a paid order too: cancelled, its refund left due
						['confirmed', 'cancelled', { who: ['staff', 'shopper'], options: { shopperPaid: 'flag' } }],
						['confirmed', 'refunded'],
						['packed', 'pending-payment'],
						['packed', 'confirmed'],
						// no tracking number needed
						['packed', 'dispatched', { options: { tracking: 'optional' } }],
						['packed', 'cancelled'],
						['packed', 'refunded'],
						['dispatched', 'delivered'],
						// a return puts the items back and keeps the points earned (orderTransitions.ts:13)
						['delivered', 'returned', { options: { restock: 'yes', points: 'keep' } }],
						// a refund after delivery puts the items back and takes the points back
						['delivered', 'refunded', { options: { restock: 'yes', points: 'take_back' } }],
						['returned', 'refunded'],
					]).map(([from, to, rest = {}]) => ({ from, to, ...rest })),
					// Payments' confirmation and an ended window as by default; refunds never move an order by themselves
					triggers: { paid: 'confirmed', windowEnd: 'cancelled', refundsCover: '' },
					// cash on delivery starts confirmed (orders/route.ts:676), pay at pickup awaiting confirmation, free orders
					// wait in pending-payment (CK-41)
					starts: { cod: 'confirmed', pickup: 'awaiting-confirmation', free: 'pending-payment' },
				},
				couriers: [],
				delivery_zones: [],
				// the member discount (E19; `apps/web/src/app/checkout/_components/CheckoutPanels.tsx`:466)
				role_prices: [{ role: MEMBER_ROLE, percent: store.memberDiscountPercent, label: 'Member discount' }],
			},
		},
		notifications: {
			format,
			settings: { 'email.replyTo': '', 'email.retryPlan': 'short', 'delivery_log.retentionDays': 0 },
		},
		payments: {
			format,
			settings: { 'manual_payments.proofMaxMb': 5 },
			lists: {
				// Payments' manual payment method bank_transfer (paid first) with SB's one account as label/value rows: SB's
				// account title is the account holder's name; the proof comes on WhatsApp, not as an upload
				manual_methods: [
					{
						key: 'bank_transfer',
						name: 'Bank transfer',
						kind: 'pay_first',
						details: '',
						instructions: '',
						proof: false,
						accounts: [
							{
								label: '',
								currency: '',
								rows: [
									{ label: 'Account holder', value: store.bankAccountTitle },
									{ label: 'Bank', value: store.bankName },
									{ label: 'Account number', value: store.bankAccountNumber },
									{ label: 'IBAN', value: store.bankIban },
								],
							},
						],
					},
				],
			},
		},
		growth: {
			format,
			settings: {
				'meta_pixel.pixelId': store.metaPixelId,
				'google_tags.ga4Id': store.googleAnalyticsId,
				'google_tags.adsId': '',
				'google_tags.adsPurchaseLabel': '',
				'google_tags.gtmId': store.googleTagManagerId,
				'google_tags.ga4ViaGtm': false,
				'tiktok_pixel.pixelId': store.tiktokPixelId,
				// tags load without a consent step (`apps/web/src/app/_components/marketing/MarketingPixels.tsx`:52-89)
				'tags.consentRequired': false,
				'pixels.contentIds': 'product',
				'pixels.searchFromUrl': false,
				'robots_verification.robotsRules': ['User-agent: *', 'Allow: /', ...disallow.map((path) => `Disallow: ${path}`)].join(
					'\n',
				),
				'robots_verification.blockAiCrawlers': false,
				// Growth's robots presets at the SaaS defaults (mechanical; store mapping to review when the owner asks)
				'robots_verification.blockSearchPages': true,
				'robots_verification.blockParameters': 'sort, minPrice, maxPrice, inStock',
				'robots_verification.blockPaths': ['/cart', '/checkout', '/account'],
				...(site ? { 'robots_verification.sitemaps': [`${site}/sitemap.xml`] } : {}),
				'robots_verification.googleVerification': seo.googleSiteVerification,
				'robots_verification.bingVerification': '',
				'robots_verification.metaVerification': '',
				'robots_verification.yandexVerification': '',
				// the notice banner, while SB has it on (`apps/web/src/app/_components/StoreNoticeBanner.tsx`:11)
				'notice_bar.enabled': store.storeNoticeEnabled,
				'notice_bar.text': store.storeNoticeText,
				'notice_bar.linkText': '',
				'notice_bar.linkUrl': '',
				'notice_bar.startsAt': '',
				'notice_bar.endsAt': '',
				'notice_bar.dismissible': true,
				'notice_bar.dismissFor': 'visit',
				'notice_bar.hideOnPages': ['/', '/concepts/**'],
			},
		},
	};
};

/** The text of a stored image's `detail` address, or ''. @param {unknown} value */
const imageAddress = (value) => (isObject(value) && isObject(value.variants) ? text(value.variants.detail) : '');

/**
 * A stored value as the type of its default (SB's `coerceStoreSettingValue` drops a value of the wrong type).
 * @param {unknown} value @param {unknown} fallback
 */
const coerce = (value, fallback) => {
	if (typeof fallback === 'number') {
		const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
		return typeof number === 'number' && Number.isFinite(number) ? number : fallback;
	}
	if (typeof fallback === 'boolean')
		return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : fallback;
	return typeof value === 'string' ? value.trim() : fallback;
};

/** The SEO and integration rows read (never a secret: no key holding a password, token or access key). */
const SEO_KEYS = Object.freeze([
	'seo.storeName',
	'seo.titleTemplate',
	'seo.defaultDescription',
	'seo.ogImageDefault',
	'seo.robotsDisallow',
	'seo.googleSiteVerification',
	'store.logo',
]);
const INTEGRATION_KEYS = Object.freeze([
	'integration.staffNotifyEmail',
	'integration.adminSiteUrl',
	'integration.awsS3PublicUrlBase',
]);

/**
 * SB's effective values from its database (read only): its `settings` rows over the code defaults, and the active
 * staff's e-mails and roles.
 * @param {SourceDb} db
 * @returns {Promise<SourceValues>}
 */
export const readValues = async (db) => {
	/** @type {Map<string, unknown>} */
	const rows = new Map();
	const keys = [...Object.keys(STORE_DEFAULTS).map((field) => `store.${field}`), ...SEO_KEYS, ...INTEGRATION_KEYS];
	for await (const doc of db.collection('settings').find({ key: { $in: keys } })) rows.set(String(doc.key), doc.value);
	const store = /** @type {StoreValues} */ (
		Object.fromEntries(
			Object.entries(STORE_DEFAULTS).map(([field, fallback]) => [field, coerce(rows.get(`store.${field}`), fallback)]),
		)
	);
	/** @param {string} key */
	const textRow = (key) => coerce(rows.get(key), '');
	const disallow = rows.get('seo.robotsDisallow');
	/** @type {SourceValues['staff']} */
	const staff = [];
	for await (const doc of db
		.collection('users')
		.find({ isActive: { $ne: false } }, { projection: { email: 1, role: 1, isSuperAdmin: 1 } }))
		staff.push({ email: text(doc.email), role: text(doc.role), isSuperAdmin: doc.isSuperAdmin === true });
	return {
		store,
		seo: {
			storeName: String(textRow('seo.storeName')),
			titleTemplate: String(textRow('seo.titleTemplate')),
			defaultDescription: String(textRow('seo.defaultDescription')),
			ogImageDefault: imageAddress(rows.get('seo.ogImageDefault')),
			storeLogo: imageAddress(rows.get('store.logo')),
			// SB falls back when the row is missing or not a list (`apps/web/src/app/robots.ts`:26-35)
			robotsDisallow: Array.isArray(disallow)
				? disallow.filter((entry) => typeof entry === 'string' && entry.length > 0)
				: null,
			googleSiteVerification: String(textRow('seo.googleSiteVerification')),
		},
		integration: {
			staffNotifyEmail: String(textRow('integration.staffNotifyEmail')),
			adminSiteUrl: String(textRow('integration.adminSiteUrl')),
			awsS3PublicUrlBase: String(textRow('integration.awsS3PublicUrlBase')),
		},
		staff,
	};
};

/**
 * The mapping's `settings`: SB's settings plan from its database.
 * @param {SourceDb} db
 * @returns {Promise<SettingsPlan>}
 */
export const readSettings = async (db) => settingsPlan(await readValues(db));
