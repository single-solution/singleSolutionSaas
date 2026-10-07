/**
 * Collections of the `connectors` module (control-plane records only: ids, statuses, sealed credentials, masked
 * previews — PLAN §1a).
 * @module
 */
import { defineCollection } from '../../infra/db.js';

export const CONNECTORS = 'connectors_connectors';
export const ASSIGNMENTS = 'connectors_assignments';

export const collections = Object.freeze([
	defineCollection({
		module: 'connectors',
		name: CONNECTORS,
		tenant: 'merchant',
		description:
			'Client-owned resources: { _id: connectorId, merchantId, kind, provider, label, websiteIds, status, lastCheckAt, ' +
			'lastCheckReport (no secrets), sealed (envelope, aad merchantId:connectorId), preview (masked), version, ' +
			'createdAt, updatedAt }.',
		indexes: [
			{ keys: { merchantId: 1, createdAt: -1, _id: -1 }, name: 'merchant_created' },
			{ keys: { merchantId: 1, websiteIds: 1, kind: 1 }, name: 'merchant_website_kind' },
		],
	}),
	defineCollection({
		module: 'connectors',
		name: ASSIGNMENTS,
		tenant: 'merchant',
		description:
			'One active connector per (website, kind): { _id: `${websiteId}:${kind}`, merchantId, websiteId, kind, connectorId }. ' +
			'The unique _id makes concurrent assignments of the same kind to a website fail atomically.',
		indexes: [{ keys: { merchantId: 1, connectorId: 1 }, name: 'merchant_connector' }],
	}),
]);
