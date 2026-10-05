/**
 * Personal data this product stores (drives the Portal-signed POST /v1/data:export and /v1/data:anonymize), keyed by
 * the shopper's identity subject (`customerId`): orders (contact, address, custom fields, the shopper's notes and
 * proofs metadata), carts (owner, note) and saved addresses. Items, counters, blocks and settings hold none.
 */
export const PRIVACY = Object.freeze({
	collections: [
		{
			name: 'orders',
			subjectField: 'customerId',
			fields: ['customerId', 'customer', 'contact', 'address', 'custom', 'note', 'proofs'],
		},
		{ name: 'carts', subjectField: 'customerId', fields: ['customerId', 'note'] },
		{ name: 'addresses', subjectField: 'customerId', fields: ['customerId', 'address'] },
	],
});
