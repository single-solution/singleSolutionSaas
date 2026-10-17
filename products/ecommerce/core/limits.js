/**
 * Fixed limits of Ecommerce (settings-ownership step 1). Each of these was a merchant setting once. None is a business
 * choice: a wrong value breaks uploads, search, checkout or the sitemaps, so the product owns them and no form offers
 * them. The value is the old default (a limit that was off or optional has a generous value now). Pure; no I/O.
 * @module
 */

// ---------------------------------------------------------------------------------------------------------- catalog

/** The count top products are ranked by: units sold (delivered orders). */
export const TOP_FIELD = 'sold';
/** The largest product, category, brand, deal or store image that can be uploaded, in bytes (5 MB). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** The largest product video (MP4 or WebM) that can be uploaded, in bytes (64 MB). */
export const VIDEO_MAX_BYTES = 64 * 1024 * 1024;
/** The name of the Atlas Search index on the products collection (the dashboard shows the definition to create). */
export const SEARCH_INDEX = 'ss_ecommerce_products_search';

// --------------------------------------------------------------------------------------------------------- checkout

/** Orders waiting for payment or confirmation one customer may have at once. */
export const OPEN_ORDER_CAP = 3;
/** Orders one customer (a signed-in shopper, or a guest by their contact) may place within the burst window. */
export const ORDER_BURST_LIMIT = 10;
/** The window of {@link ORDER_BURST_LIMIT}, in minutes. */
export const ORDER_BURST_WINDOW_MINUTES = 15;
/** The most lines in a cart. */
export const CART_MAX_LINES = 50;
/** The most pieces of one item in a cart, unless its item type's quantity rule names a most of its own. */
export const CART_MAX_QUANTITY = 99;
/** Products compared at once. */
export const COMPARE_MAX_PRODUCTS = 4;

// ------------------------------------------------------------------------------------------------- search and SEO

/** Products in stock that a landing page made by the merchant needs to be indexed. */
export const LANDING_MIN_PRODUCTS = 3;
/** Products in stock that an automatic landing page needs to exist. */
export const AUTO_LANDING_MIN_PRODUCTS = 2;
/** Variants in stock that a landing page (stored or automatic) needs to be indexed, while automatic landing pages are on. */
export const LANDING_MIN_VARIANTS = 3;
/** Automatic landing pages the sitemaps list at most (the ones with the most products in stock first). */
export const AUTO_LANDING_MAX_PAGES = 2000;
/**
 * Addresses in one sitemap file; above this the sitemap becomes an index of files. An entry with 10 photos takes up to
 * about 3 KB, so a file stays well under the 50 MB search engines read.
 */
export const SITEMAP_FILE_SIZE = 10_000;
/** Best-selling products listed in llms.txt. */
export const LLMS_TXT_PRODUCTS = 50;

// ------------------------------------------------------------------------------------------------ returns and alerts

/** The largest return photo, in MB. */
export const RETURN_PHOTO_MAX_MB = 5;
/** People one staff alert goes to at most (the list first, then the Accounts staff). */
export const STAFF_ALERT_MAX_RECIPIENTS = 100;
