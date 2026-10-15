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

/** A phone's screen: the chat window goes full screen there (when set), and the idle nudge may stay away (C14). */
export const PHONE_MEDIA = '(max-width: 480px)';

/**
 * Back-off checking (PLAN 0.8.3 Live updates): code constants; the two intervals are the defaults of the Visitor chat
 * settings `pollFocusedSeconds` and `pollBackgroundSeconds` (C19), which each website may change.
 */
export const CHECKS = Object.freeze({
	/** window open and tab visible (the default of `pollFocusedSeconds`) */
	activeMs: 10_000,
	/** after 5 minutes without activity, checks come this many times less often */
	idleAfterMs: 5 * 60_000,
	idleFactor: 2,
	/** checks stop after 15 minutes without activity */
	stopAfterMs: 15 * 60_000,
	/** while an AI reply is pending after a send */
	replyMs: 3_000,
	replyWindowMs: 45_000,
	/**
	 * window closed: unread on load, on focus (at most once a minute) and every 5 minutes while visible (the default of
	 * `pollBackgroundSeconds`)
	 */
	closedFocusMinMs: 60_000,
	closedEveryMs: 5 * 60_000,
});

/** The human-like typing pace of AI replies in the widget. */
export const PACE = Object.freeze({ msPerChar: 10, maxTypingMs: 2500, readingMsPerChar: 50, maxReadingMs: 1200 });

/** Longest visitor or staff message (characters). */
export const MAX_MESSAGE_LENGTH = 4000;

/** Image types every browser shows; other images (HEIC, HEIF) are files to download. */
const BROWSER_IMAGES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

/**
 * File types visitors may ever send (the merchant's upload types pick among them, C11): images (phone photos in HEIC
 * and HEIF too), PDF, video and audio (voice notes); never SVG, HTML or executables.
 */
export const ATTACHMENT_TYPES = Object.freeze([
	...BROWSER_IMAGES,
	'image/heic',
	'image/heif',
	'application/pdf',
	'video/mp4',
	'video/webm',
	'video/quicktime',
	'audio/mpeg',
	'audio/mp4',
	'audio/x-m4a',
	'audio/aac',
	'audio/ogg',
	'audio/webm',
	'audio/wav',
]);

/** The hard cap of a visitor attachment, whatever the merchant's cap per type (C11: videos too). */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * How an attachment shows (C11): `image` inline (the images browsers show), `video` and `audio` as players, anything
 * else as a file to open or download.
 * @param {string} type
 * @returns {'image' | 'video' | 'audio' | 'file'}
 */
export const attachmentKind = (type) => {
	if (BROWSER_IMAGES.includes(type)) return 'image';
	if (type.startsWith('video/')) return 'video';
	if (type.startsWith('audio/')) return 'audio';
	return 'file';
};

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
	'image/avif': 'avif',
	'image/heic': 'heic',
	'image/heif': 'heif',
	'application/pdf': 'pdf',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'video/quicktime': 'mov',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/x-m4a': 'm4a',
	'audio/aac': 'aac',
	'audio/ogg': 'ogg',
	'audio/webm': 'weba',
	'audio/wav': 'wav',
	'application/msword': 'doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.ms-excel': 'xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'text/plain': 'txt',
});

/**
 * Whether AI replies carry the AI label (PLAN 0.8.3 AI): Show the AI label on and Never disclose off (C1). While it is
 * hidden, Settings show the law warning.
 * @param {Record<string, unknown>} values the AI replies settings
 */
export const aiLabelShown = (values) => values.showAiLabel === true && values.neverDisclose !== true;

/** How long a send with `?wait=1` waits for the AI reply (C10). */
export const WAIT_MS = 20_000;

/** Most messages one page of older messages holds (C8). */
export const PAGE_MAX = 50;
