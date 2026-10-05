/**
 * Personal data this product stores, all of it in the merchant's own database (drives the Portal-signed
 * POST /v1/data:export and /v1/data:anonymize through app-kit's declarative privacy handlers): orders hold the
 * customer's contact and addresses, messages hold recipients and texts, risk profiles hold hashed contact keys and a masked label. The data
 * subject is the customer id (`customerId`); anonymisation clears every personal field and keeps the order's money,
 * lines and statuses for the merchant's books.
 */

export const PRIVACY = Object.freeze({
	collections: [
		{
			name: 'orders',
			subjectField: 'customerId',
			fields: [
				'customer',
				'shipping',
				'billing',
				'customerEmail',
				'customerPhone',
				'customerSubject',
				'customerKeys',
				'notes',
			],
		},
		{ name: 'messages', subjectField: 'customerId', fields: ['to', 'text', 'subject'] },
		{ name: 'risk_profiles', subjectField: 'customerId', fields: ['reason', 'display'] },
	],
});
