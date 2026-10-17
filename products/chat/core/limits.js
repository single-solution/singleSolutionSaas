/**
 * Fixed limits of Chat (settings-ownership step 1). Each of these was a merchant setting once. None is a business
 * choice: a wrong value makes answers worse, hides messages, burns the free plan or opens a risk, so the product owns
 * them and no form offers them. The value is the old default, so nothing changes for anybody. Pure; no I/O.
 * @module
 */

// ------------------------------------------------------------------------------------------------------------- AI

/** The share of the monthly token cap at which the staff are told (the alert goes to the Portal's alert recipients). */
export const AI_COST_ALERT_PERCENT = 80;
/** How freely the AI words its answers (0 sure, 1 free). */
export const AI_TEMPERATURE = 0.4;
/** The most tokens one AI answer takes. */
export const AI_MAX_OUTPUT_TOKENS = 500;
/** AI replies one visitor gets per day (the budget is `ai_caps`). */
export const AI_REPLIES_PER_VISITOR_PER_DAY = 40;
/** AI replies the guests of one network address get per day. */
export const AI_REPLIES_PER_NETWORK_PER_DAY = 60;
/**
 * How many marker words of one language pick it when a message in Latin letters is told apart (a message of up to
 * three words needs only one). The language lock checks an AI answer as a whole, never part by part, and asks for no
 * share of marker words.
 */
export const LANGUAGE_MIN_MARKERS = 2;

/** After this many minutes of waiting for a person, the AI only reassures the visitor who writes again (each handoff waits anew). */
export const REASSURE_AFTER_MINUTES = 5;

// ------------------------------------------------------------------------------------------------ files and guests

/** The file types staff may send in a chat (images and PDFs; a PDF is a download, it never opens in the page). */
export const STAFF_ATTACHMENT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
/** The largest file staff may send, in bytes (10 MB). */
export const STAFF_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Days a guest's device is remembered (its chats stay with it). */
export const GUEST_REMEMBER_DAYS = 90;
/** New guests one network address may start in 15 minutes (a device that sends no guest key starts a new guest); more are refused for a while. Generous, because many shoppers share one mobile network address. */
export const NEW_GUESTS_PER_NETWORK = 100;

// ------------------------------------------------------------------------------------------------------ the shop

/** Orders the context panel shows. */
export const CONTEXT_PANEL_ORDERS = 5;
/** Characters of the store context the AI gets. */
export const SHOP_CONTEXT_MAX_CHARACTERS = 6000;
/** Deals one answer lists. */
export const SHOP_DEALS_COUNT = 10;
/** Orders one "my orders" answer lists. */
export const SHOP_MY_ORDERS_COUNT = 5;
/** Products one search answer lists. */
export const SHOP_SEARCH_MAX_RESULTS = 5;
/** Products one "top products" answer lists. */
export const SHOP_TOP_COUNT = 5;

// ------------------------------------------------------------------------------------------------------- alerts

/** People one staff alert goes to. */
export const STAFF_ALERT_MAX_RECIPIENTS = 20;
/** A visitor who checked the chat less than this many seconds ago is not alerted again. */
export const VISITOR_ALERT_AWAY_SECONDS = 60;

// ----------------------------------------------------------------------------------------------------- the widget

/** Days a visitor's "no thanks" to a proactive message is respected. (The widget's check intervals are `CHECKS` of `widgets.js`.) */
export const PROACTIVE_DISMISS_DAYS = 7;
