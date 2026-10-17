/**
 * The website's connections and the links between its products (settings-ownership design 8.3 and 8.4): the names the
 * Portal and the products share, and the pure rules that make a product's database name and storage folder. Browser-safe.
 *
 * - **Connections** are entered once per website in the Portal: one MongoDB database connection and one S3-compatible
 *   storage connection. Each product gets the same connection string with its own database name (`ss_<productId>`) and
 *   keeps its own folder in the bucket (`<prefix><productId>/<websiteId>/`).
 * - **Links** are one-way keys between two products of the website (`ecommerce → payments`); a link carries scopes
 *   (`payments.create`) that the Portal decides from the products' manifests and the callee enforces.
 * @module
 */

/** The connections the Portal holds for a website. */
export const WEBSITE_CONNECTIONS = Object.freeze(/** @type {const} */ (['database', 'storage']));

/** @typedef {typeof WEBSITE_CONNECTIONS[number]} WebsiteConnectionName */

/** What a link scope looks like: dotted lower-case words, `payments.create`, `orders.read.customer`. */
export const LINK_SCOPE_PATTERN = '^[a-z][a-z0-9_]{0,31}(?:\\.[a-z][a-z0-9_]{0,31}){0,3}$';
const SCOPE = new RegExp(LINK_SCOPE_PATTERN);

/** A database name a product may use (MongoDB's rules, narrowed to letters, digits and underscores). */
export const DATABASE_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,62}$';
const DATABASE_NAME = new RegExp(DATABASE_NAME_PATTERN);

/**
 * True for a link scope.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isLinkScope = (value) => typeof value === 'string' && SCOPE.test(value);

/**
 * True for a database name.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isDatabaseName = (value) => typeof value === 'string' && DATABASE_NAME.test(value);

/**
 * A product's own database on the website's MongoDB connection: `ss_<productId>` (`ss_ecommerce`, `ss_chat`). Product ids
 * may hold hyphens; a database name does not.
 * @param {string} productId
 * @returns {string}
 */
export const databaseNameFor = (productId) => `ss_${productId.replace(/-/g, '_')}`;

/**
 * A product's own folder in the website's bucket: `<prefix><productId>/<websiteId>/`. The one rule the Portal shows and
 * the product's storage uses.
 * @param {{ prefix?: string | undefined, productId: string, websiteId: string }} input
 * @returns {string}
 */
export const storageFolderFor = ({ prefix, productId, websiteId }) => `${prefix ?? ''}${productId}/${websiteId}/`;
