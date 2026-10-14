/**
 * Names the widgets, the API and the docs share (PLAN 0.4.10, 0.8.3): the browser global of `widget.js`
 * (`window.SSChat`), the attribute of the elements the merchant places for admin widgets, the headers a visitor request
 * carries, where the browser keeps the guest key, the event a product card's Add to cart dispatches, and the back-off
 * checking constants (fixed code constants, never settings).
 * @module
 */

/** The browser global `widget.js` sets: `window.SSChat`. */
export const WIDGET_GLOBAL = 'SSChat';

/** Admin widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-chat';

/** The feature each widget belongs to (manifest.json `widgets`). */
export const WIDGET_FEATURES = Object.freeze({
	chat: 'visitor_chat',
	inbox: 'inbox',
	knowledge_editor: 'knowledge_editor',
	reports: 'reports',
});

/** A visitor's Accounts sign-in (the kit's CORS headers allow it). */
export const SIGN_IN_HEADER = 'ss-sign-in';

/** A guest's device key (the kit's CORS headers allow it). */
export const GUEST_HEADER = 'ss-guest';

/** What a guest key may be: 16–128 characters of `A–Z a–z 0–9 - _`, so a store's own guest cookie works once imported (C7). */
export const GUEST_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** Where the widget keeps the guest key (with its expiry) on the visitor's device. */
export const GUEST_STORAGE_KEY = 'ss-chat-guest';

/** Where the widget keeps proactive memory (shown this session, dismissed until). */
export const PROACTIVE_STORAGE_KEY = 'ss-chat-proactive';

/**
 * The window event a product card's Add to cart dispatches (cancelable), with `detail: { productId, variantId,
 * quantity }`. Ecommerce's widget on the page listens and calls `preventDefault()` once it added the item to the cart;
 * when nobody does, the card opens the product page instead.
 */
export const ADD_TO_CART_EVENT = 'ss-ecommerce:add-to-cart';

/** Page kinds `SSChat.setPage({ kind })` accepts. */
export const PAGE_KINDS = Object.freeze(/** @type {const} */ (['product', 'category', 'deals', 'cart', 'other']));

/** Back-off checking (PLAN 0.8.3 Live updates): code constants, the same for every website. */
export const CHECKS = Object.freeze({
	/** window open and tab visible */
	activeMs: 10_000,
	/** after 5 minutes without activity */
	idleAfterMs: 5 * 60_000,
	idleMs: 20_000,
	/** checks stop after 15 minutes without activity */
	stopAfterMs: 15 * 60_000,
	/** while an AI reply is pending after a send */
	replyMs: 3_000,
	replyWindowMs: 45_000,
	/** window closed: unread on load, on focus (at most once a minute) and every 5 minutes while visible */
	closedFocusMinMs: 60_000,
	closedEveryMs: 5 * 60_000,
});

/** The human-like typing pace of AI replies in the widget. */
export const PACE = Object.freeze({ msPerChar: 10, maxTypingMs: 2500, readingMsPerChar: 50, maxReadingMs: 1200 });

/** Longest visitor or staff message (characters). */
export const MAX_MESSAGE_LENGTH = 4000;

/** File types attachments may ever have (the setting picks among them); never SVG, HTML or executables. */
export const ATTACHMENT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

/** The hard cap of a visitor attachment, whatever the setting. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** File types staff may also send (C12): Word, Excel and plain text, offered as downloads only. */
const STAFF_ONLY_TYPES = Object.freeze([
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'text/plain',
]);

/** Every file type staff may ever send (the setting picks among them). */
export const STAFF_TYPES = Object.freeze([...ATTACHMENT_TYPES, ...STAFF_ONLY_TYPES]);

/** The hard cap of a staff attachment, whatever the setting (C12). */
export const MAX_STAFF_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** The file name extension of each attachment type. */
export const EXTENSIONS = Object.freeze({
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'application/pdf': 'pdf',
	'application/msword': 'doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.ms-excel': 'xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'text/plain': 'txt',
});

/** How long a send with `?wait=1` waits for the AI reply (C10). */
export const WAIT_MS = 20_000;

/** Most messages one page of older messages holds (C8). */
export const PAGE_MAX = 50;

/**
 * The Notifications templates Chat sends and the values each one gets (`business` is always added). Staff alerts go
 * by email, WhatsApp or SMS through the kit's staff alerts (K6), `preview` cut to 140 characters on one line and
 * `message` up to 500 with its line breaks, `phone` only with the staff alert setting `includePhone` (CH-9); the
 * transcript by email; the reply alert (C6) by the first of the setting "Channels, in order" that the visitor has an
 * address for and Notifications takes.
 */
export const MESSAGE_TEMPLATES = Object.freeze({
	'chat.staff_new_message': Object.freeze([
		'visitor',
		'name',
		'phone',
		'preview',
		'message',
		'link',
		'conversationId',
		'business',
	]),
	'chat.staff_needs_you': Object.freeze([
		'visitor',
		'name',
		'phone',
		'preview',
		'message',
		'link',
		'conversationId',
		'business',
	]),
	'chat.staff_cost_alert': Object.freeze(['used', 'cap', 'percent', 'business']),
	'chat.transcript': Object.freeze(['transcript', 'date', 'business']),
	'chat.staff_reply': Object.freeze(['name', 'staff', 'preview', 'link', 'business']),
});
