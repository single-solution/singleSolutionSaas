/**
 * Sisters Boutique's people into Accounts (PLAN 0.8.10 Migration step 1, "Per store", SB): the custom role `member`,
 * the members (customers with a password or the member flag) as phone users with their bcrypt hashes (A1) and saved
 * addresses, the staff with their bcrypt hashes and ready-made roles (`isSuperAdmin` → Owner; inactive → blocked), the
 * membership requests (A5) with a user for each invited one, and the old activity entries as copies (K9, IMP-30).
 *
 * SB's setup links cannot move: Accounts' links carry their record id (`products/accounts/core/imports.js`
 * `checkImportedRequest`), so an invited request comes in invited, with its user and expiry, and staff give a new link
 * (owner decision D6: old links may break). Staff and members stay separate users even on one phone (A16); Accounts
 * keeps one user per phone, so a staff phone a member already has is left out of the staff user.
 * @module
 */
import { derivedId, earliest, hexKey, idOrNull, iso, isObject, phoneOf, phoneText, text } from './common.js';

/** @typedef {import('../../mapping.js').MappingStep} MappingStep */
/** @typedef {import('../../mapping.js').MapContext} MapContext */

/** The custom role of SB's premium members (A5, E19: the member discount). */
export const MEMBER_ROLE = 'member';
/** SB's staff roles, kept: Accounts has the same ready-made roles (`apps/admin/src/lib/permissions.ts`). */
const STAFF_ROLES = Object.freeze(['owner', 'business_manager', 'product_manager', 'marketing_manager', 'support_staff']);

/**
 * Lookup tables: a member's user id by the customer's hex, and by the member's phone (E.164).
 */
export const TABLES = Object.freeze({ members: 'members', memberPhones: 'member-phones' });

/**
 * The user id of a membership request's person: the member who has its phone, else the user made for invited
 * requests of that phone (one per phone, never the phone in clear).
 * @param {Record<string, any>} doc a membership request
 * @param {MapContext} ctx
 * @returns {string | null}
 */
const requestUserId = (doc, ctx) => {
	const phone = phoneOf(doc.phoneNumber);
	if (phone === null) return null;
	return ctx.lookup(TABLES.memberPhones, phone) ?? derivedId('usr', `invited:${phone}`);
};

/** A membership request is invited (SB's `expired` is an invited one past its expiry, judged on read by Accounts). */
const INVITED = Object.freeze(['invited', 'expired']);

/**
 * A member's saved addresses as Accounts' profile addresses (A11, A15): the street is the first line; SB's street is
 * optional, so an address without one takes its area (or else its city) as the first line, which Accounts needs;
 * only the first default stays the default.
 * @param {unknown} addresses
 */
const addressesOf = (addresses) => {
	let defaultSeen = false;
	return (Array.isArray(addresses) ? addresses : []).filter(isObject).map((address) => {
		const street = text(address.street);
		const area = text(address.area);
		const line1 = street || area || text(address.city);
		const isDefault = address.isDefault === true && !defaultSeen;
		defaultSeen ||= isDefault;
		const id = hexKey(address._id);
		return {
			...(id ? { id: `adr_${id}` } : {}),
			...(text(address.label) ? { label: text(address.label) } : {}),
			name: text(address.recipientName),
			phone: phoneText(address.phoneNumber),
			line1,
			area: street ? area : '',
			city: text(address.city),
			postalCode: text(address.postalCode),
			default: isDefault,
		};
	});
};

/** @type {ReadonlyArray<MappingStep>} */
export const roleSteps = Object.freeze([
	{
		// one record, whatever SB holds: the role exists in code there; read off SB's own settings rows (never a secret)
		product: 'accounts',
		collection: 'roles',
		source: 'settings',
		prefix: 'role',
		key: ['key'],
		filter: { key: { $regex: '^store\\.' } },
		mergeKey: () => MEMBER_ROLE,
		map: () => ({
			key: MEMBER_ROLE,
			name: 'Member',
			description: 'Premium members invited by staff: the member discount at checkout.',
			permissions: [],
			rank: 800,
			// members sign in with phone + password and stay signed in for 30 days (`apps/web/src/lib/authConfig.ts`:33-48)
			methods: ['phone_password'],
			remember: 'always',
			rememberDays: 30,
			sessionRolling: true,
		}),
	},
]);

/**
 * Members: customers with a password (they sign in, `apps/web/src/lib/auth.ts`) or the member flag. Their user id is
 * `usr_<the customer's hex>`, so the Ecommerce customer names it without a lookup.
 * @type {MappingStep}
 */
export const memberStep = {
	product: 'accounts',
	collection: 'users',
	source: 'customers',
	prefix: 'usr',
	filter: { $or: [{ passwordHash: { $type: 'string' } }, { isMember: true }] },
	lookups: {
		[TABLES.members]: (_record, doc) => hexKey(doc._id),
		[TABLES.memberPhones]: (_record, doc) => phoneOf(doc.phoneNumber),
	},
	map: (doc, ctx) => {
		const passwordHash = text(doc.passwordHash);
		const member = doc.isMember === true;
		return {
			id: ctx.id('usr', doc._id),
			name: text(doc.name),
			phone: phoneText(doc.phoneNumber),
			// the setup link sent to the member's WhatsApp proved the phone (SA-1)
			phoneVerified: passwordHash !== '',
			role: member ? MEMBER_ROLE : 'customer',
			...(member && iso(doc.memberSince) ? { roleSince: iso(doc.memberSince) } : {}),
			...(passwordHash ? { passwordHash } : {}),
			identity: 'phone',
			addresses: addressesOf(doc.addresses),
			createdAt: iso(doc.createdAt),
		};
	},
	sums: (record) => ({
		...(record.passwordHash ? { 'users.withPassword': 1 } : {}),
		[`users.role.${record.role}`]: 1,
	}),
};

/**
 * Staff: e-mail + password users (bcrypt, A1) with SB's role; the e-mail is verified (staff sign in with it); the
 * phone stays (A16) unless a member has it or it is not a phone number.
 * @type {MappingStep}
 */
export const staffStep = {
	product: 'accounts',
	collection: 'users',
	source: 'users',
	prefix: 'usr',
	map: (doc, ctx) => {
		// a phone Accounts cannot read, or one a member has, is left out (staff sign in with their e-mail)
		const phone = phoneOf(doc.phoneNumber);
		const keepPhone = phone !== null && ctx.lookup(TABLES.memberPhones, phone) === null;
		const role = doc.isSuperAdmin === true ? 'owner' : STAFF_ROLES.includes(doc.role) ? doc.role : 'support_staff';
		return {
			id: ctx.id('usr', doc._id),
			name: text(doc.name),
			email: text(doc.email),
			emailVerified: true,
			...(keepPhone ? { phone } : {}),
			role,
			...(doc.isActive === false
				? { blocked: { at: iso(doc.updatedAt) ?? iso(doc.createdAt), reason: 'Inactive in the old admin.' } }
				: {}),
			passwordHash: text(doc.passwordHash),
			identity: 'email',
			...(iso(doc.lastLoginAt) ? { lastSignInAt: iso(doc.lastLoginAt) } : {}),
			createdAt: iso(doc.createdAt),
		};
	},
	sums: (record) => ({
		'users.staff': 1,
		...(record.passwordHash ? { 'users.withPassword': 1 } : {}),
		[`users.role.${record.role}`]: 1,
	}),
};

/**
 * Membership requests (A5): pending, invited (SB's expired ones too: Accounts judges the expiry), completed (their
 * member's user) and declined. Who invited is the staff user.
 * @type {MappingStep}
 */
export const requestStep = {
	product: 'accounts',
	collection: 'requests',
	source: 'membershiprequests',
	prefix: 'rrq',
	map: (doc, ctx) => {
		const status = INVITED.includes(doc.status) ? 'invited' : doc.status;
		const invited = status === 'invited';
		const completed = status === 'completed';
		const customerHex = hexKey(doc.customerId);
		const userId = completed
			? ((customerHex ? ctx.lookup(TABLES.members, customerHex) : null) ??
				ctx.lookup(TABLES.memberPhones, phoneOf(doc.phoneNumber) ?? ''))
			: invited
				? requestUserId(doc, ctx)
				: null;
		const invitedBy = idOrNull('usr', doc.invitedByUserId);
		return {
			id: ctx.id('rrq', doc._id),
			role: MEMBER_ROLE,
			name: text(doc.name),
			phone: phoneText(doc.phoneNumber),
			note: text(doc.note),
			status,
			...(userId ? { userId } : {}),
			...(status !== 'pending' && invitedBy ? { invitedBy: { kind: 'user', id: invitedBy } } : {}),
			...(status !== 'pending' && iso(doc.invitedAt) ? { invitedAt: iso(doc.invitedAt) } : {}),
			// an invited request without an expiry reads as expired from its invitation (its link is gone, D6)
			...(invited ? { setupExpiresAt: iso(doc.setupTokenExpiresAt) ?? iso(doc.invitedAt) ?? iso(doc.updatedAt) } : {}),
			...(completed && iso(doc.completedAt) ? { completedAt: iso(doc.completedAt) } : {}),
			createdAt: iso(doc.createdAt),
		};
	},
	sums: (record) => /** @type {Record<string, number>} */ (record.status === 'pending' ? { 'requests.pending': 1 } : {}),
};

/**
 * The user of each invited request whose person is not a member yet: invited, the member role, the phone (proved when
 * they set their password through a link staff give again), one per phone.
 * @type {MappingStep}
 */
export const invitedStep = {
	product: 'accounts',
	collection: 'users',
	source: 'membershiprequests',
	prefix: 'usr',
	filter: { status: { $in: [...INVITED] } },
	mergeKey: (doc) => phoneOf(doc.phoneNumber),
	merge: (kept, next) => ({ ...kept, createdAt: earliest(kept.createdAt, next.createdAt) }),
	map: (doc, ctx) => {
		const phone = phoneOf(doc.phoneNumber);
		if (phone === null || ctx.lookup(TABLES.memberPhones, phone)) return null;
		return {
			id: /** @type {string} */ (requestUserId(doc, ctx)),
			name: text(doc.name),
			phone,
			role: MEMBER_ROLE,
			status: 'invited',
			identity: 'phone',
			createdAt: iso(doc.invitedAt) ?? iso(doc.createdAt),
		};
	},
	sums: () => ({ 'users.role.member': 1 }),
};

/** SB's activity resource types: the product that owns them now, and the id prefix of their records. */
const RESOURCES = Object.freeze(
	/** @type {Record<string, { product: string, prefix: string | null }>} */ ({
		product: { product: 'ecommerce', prefix: 'prd' },
		brand: { product: 'ecommerce', prefix: 'brd' },
		category: { product: 'ecommerce', prefix: 'cat' },
		attribute: { product: 'ecommerce', prefix: 'att' },
		order: { product: 'ecommerce', prefix: 'ord' },
		customer: { product: 'ecommerce', prefix: 'cus' },
		loyalty: { product: 'ecommerce', prefix: null },
		inquiry: { product: 'chat', prefix: 'conv' },
		offer: { product: 'ecommerce', prefix: 'deal' },
		sizeChart: { product: 'ecommerce', prefix: 'szc' },
		team: { product: 'accounts', prefix: 'usr' },
		settings: { product: 'ecommerce', prefix: null },
		auth: { product: 'accounts', prefix: null },
	}),
);

/** camelCase → snake_case (`sizeChart` → `size_chart`). @param {string} name */
const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * SB's activity entries (Activity screen) as Accounts copies (K9, IMP-30): the action `<resource type>.<action>`, the
 * target the record's new id (else SB's resource id, else the type), the actor the staff user (else anonymous).
 * @type {MappingStep}
 */
export const copyStep = {
	product: 'accounts',
	collection: 'copies',
	source: 'activityentries',
	prefix: 'act',
	map: (doc, ctx) => {
		const type = text(doc.resourceType);
		const resource = RESOURCES[type] ?? { product: 'ecommerce', prefix: null };
		const resourceId = text(doc.resourceId);
		const target =
			resource.prefix && hexKey(resourceId) ? ctx.id(resource.prefix, resourceId) : resourceId || snake(type) || 'unknown';
		const actorId = idOrNull('usr', doc.actorUserId);
		return {
			id: ctx.id('act', doc._id),
			productId: resource.product,
			actor: {
				kind: actorId ? 'user' : 'anonymous',
				id: actorId ?? 'anonymous',
				...(text(doc.actorName) ? { name: text(doc.actorName) } : {}),
				...(text(doc.actorRole) ? { role: text(doc.actorRole) } : {}),
			},
			action: `${snake(type) || 'activity'}.${text(doc.action) || 'updated'}`,
			target,
			...(text(doc.resourceLabel) ? { label: text(doc.resourceLabel) } : {}),
			...(text(doc.detail) ? { detail: text(doc.detail) } : {}),
			at: iso(doc.createdAt),
		};
	},
};
