/**
 * Where a person goes to change a website's settings: the Portal's Website settings page of the website, at one of its
 * sections. A merchant opens `/websites/<id>/settings`; an Owner or Support admin the same page of that merchant's
 * website, `/admin/merchants/<merchant>/websites/<id>/settings`. Pure, no browser needed.
 * @module
 */

/** The sections of the Website settings page, as the Portal names them (the anchors of the page). */
export const WEBSITE_SECTION_NAMES = Object.freeze({
	business: 'Business',
	brand: 'Brand and look',
	region: 'Region and format',
	pages: 'Domains, pages and legal',
	team: 'Team and alerts',
});

/**
 * The address of the website's settings in the Portal.
 * @param {{ portal: string, admin: boolean, websiteId: string | null, merchantId?: string | null, section?: string }} input
 *   `portal`: the pinned Portal address; `admin`: the viewer is an Owner or Support admin (needs `merchantId`);
 *   `section`: one of the sections (`region`)
 * @returns {string}
 */
export const websiteSettingsUrl = ({ portal, admin, websiteId, merchantId, section }) => {
	const base = String(portal).replace(/\/+$/, '');
	const site = encodeURIComponent(String(websiteId));
	const path =
		admin && merchantId
			? `/admin/merchants/${encodeURIComponent(merchantId)}/websites/${site}/settings`
			: `/websites/${site}/settings`;
	return `${base}${path}${section ? `#${section}` : ''}`;
};
