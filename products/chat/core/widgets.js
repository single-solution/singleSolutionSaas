/**
 * Names the widgets, the API and the docs share (PLAN 0.4.10, 0.8.3): the browser global of `widget.js`
 * (`window.SSChat`), the attribute of the elements the merchant places for admin widgets, the headers a visitor request
 * carries, where the browser keeps the guest key, and the back-off checking constants (fixed code constants, never
 * settings).
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

/** Where the widget keeps the guest key (with its expiry) on the visitor's device. */
export const GUEST_STORAGE_KEY = 'ss-chat-guest';

/** Where the widget keeps proactive memory (shown this session, dismissed until). */
export const PROACTIVE_STORAGE_KEY = 'ss-chat-proactive';

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

/** The human-like typing pace of AI replies in the widget (as in ibrahimMobiles). */
export const PACE = Object.freeze({ msPerChar: 10, maxTypingMs: 2500, readingMsPerChar: 50, maxReadingMs: 1200 });

/** Longest visitor or staff message (characters). */
export const MAX_MESSAGE_LENGTH = 4000;

/** File types attachments may ever have (the setting picks among them); never SVG, HTML or executables. */
export const ATTACHMENT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

/** The hard cap of an attachment, whatever the setting. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The Notifications templates Chat sends (e-mail) and the values each one gets (`business` is always added). */
export const MESSAGE_TEMPLATES = Object.freeze({
	'chat.new_message': Object.freeze(['visitor', 'preview', 'link', 'conversationId', 'business']),
	'chat.needs_you': Object.freeze(['visitor', 'preview', 'link', 'conversationId', 'business']),
	'chat.transcript': Object.freeze(['transcript', 'date', 'business']),
	'chat.cost_alert': Object.freeze(['used', 'cap', 'percent', 'business']),
});
