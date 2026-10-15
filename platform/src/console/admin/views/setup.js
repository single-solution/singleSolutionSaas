'use client';
/**
 * The Setup page of a website in the Admin Console: the shared Setup view, where Owner and Support switch recommended
 * features on.
 * @module
 */
import { SetupView } from '../../views/setup.js';

/**
 * @param {import('../../views/setup.js').SetupPageProps} props
 */
export function AdminSetupView({ merchantId, websiteId, ...props }) {
	return <SetupView {...props} manage={{ merchantId, websiteId }} canSwitch />;
}
