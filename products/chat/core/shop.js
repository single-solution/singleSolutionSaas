/**
 * The Ecommerce endpoints Chat's shop tools, track shipment and product cards will call (PLAN 0.8.3 Shop tools, 0.8.4:
 * written in Chat's docs first; Ecommerce implements exactly these in step 10). Chat calls them with the pasted
 * Ecommerce server token; the tools only read. Nothing here runs before step 10: the features are not in Chat's
 * feature list yet. My orders, account and track shipment forward the visitor's verified Accounts sign-in in the
 * `SS-Sign-In` header; Ecommerce verifies it itself and answers only that user's data, never full street addresses or
 * phone numbers.
 * @module
 */

/** One row per tool: the tool, the feature it will belong to, and the Ecommerce request it makes. */
export const SHOP_ENDPOINTS = Object.freeze([
	{ tool: 'search_catalog', feature: 'shop_search', request: 'GET /v1/chat/products?q=<text>&limit=5' },
	{ tool: 'get_product_details', feature: 'shop_search', request: 'GET /v1/chat/products/<productId>' },
	{ tool: 'quote_product_savings', feature: 'shop_deals', request: 'GET /v1/chat/products/<productId>/quote' },
	{ tool: 'list_active_deals', feature: 'shop_deals', request: 'GET /v1/chat/deals?limit=10' },
	{ tool: 'get_top_products', feature: 'shop_top', request: 'GET /v1/chat/products/top?kind=top|new&limit=5' },
	{ tool: 'get_my_orders', feature: 'shop_my_orders', request: 'GET /v1/chat/me/orders?limit=5 (SS-Sign-In)' },
	{ tool: 'get_my_account', feature: 'shop_my_orders', request: 'GET /v1/chat/me/account (SS-Sign-In)' },
	{ tool: 'track_shipment', feature: 'track_shipment', request: 'GET /v1/chat/me/shipments (SS-Sign-In)' },
]);

/** What each answer carries (product cards use the product fields). */
export const SHOP_ANSWERS = Object.freeze({
	product: 'id, name, price (integer minor units), currency, image (https), url (the product page), inStock',
	quote: 'productId, price, priceAfterDeals, savings, currency, deals: [name]',
	deal: 'id, name, description, endsAt',
	orders: 'items: [{ number, status, total, currency, placedAt }] (the last 5), loyaltyPoints, name',
	account: 'name, loyaltyPoints',
	shipments: 'items: [{ orderNumber, courier, trackingNumber, trackingUrl, status }]',
});
