'use client';
/**
 * The Setup page of a website in the Admin Console: the shared Setup view with the admin API client, where Owner and
 * Support switch recommended features on.
 * @module
 */
import { SetupView } from '../../views/setup.js';
import { adminFetch } from '../client.js';

/**
 * @param {import('../../views/setup.js').SetupPageProps} props
 */
export function AdminSetupView({ merchantId, websiteId, ...props }) {
	return <SetupView {...props} manage={{ fetcher: adminFetch, merchantId, websiteId }} canSwitch />;
}
