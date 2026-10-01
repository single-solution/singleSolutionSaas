/** Personal data this product stores (drives POST /v1/data:export and /v1/data:anonymize). */
export const PRIVACY = Object.freeze({ collections: [{ name: 'notes', subjectField: 'customerId', fields: ['text'] }] });
