/**
 * Personal data this product stores (drives the Portal-signed POST /v1/data:export and /v1/data:anonymize). The subject
 * is the customer key (`customerId`: the Graph customer id, else the website's identity subject). Anonymising keeps the
 * claims and their money (the merchant's records of refunds) and removes the contact, the free text and the photos.
 */

export const PRIVACY = Object.freeze({
	collections: [
		{ name: 'purchases', subjectField: 'customerId', fields: ['customer', 'customerKeys'] },
		{ name: 'claims', subjectField: 'customerId', fields: ['details', 'customerKeys', 'photos'] },
		{ name: 'messages', subjectField: 'customerId', fields: ['body'] },
		{ name: 'photos', subjectField: 'customerId', fields: ['key', 'objectKey'] },
	],
});
