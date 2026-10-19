'use client';
/**
 * The Store details view (Settings → Store details): who the store is — name, contacts, address, hours, social links and
 * pictures — is the website's, set once in the Portal (Website settings › Business and Brand and look) for every product.
 * Ecommerce keeps no form for it: this shows what the Portal says, read only, with a link to where it is changed. Your
 * website reads the same facts at `GET /v1/shop/store` and `GET /v1/shop/store/business-json`.
 * @module
 */
import { Card, KeyValueList, ManagedNote, SettingsCardSkeleton } from '@ss/ui';
import { Loaded, fill, useLoad, websiteSettingsUrl } from '@ss/ui/dashboard';
import { TEXTS } from './texts.js';

const S = TEXTS.lists.storeDetails;

/**
 * The store's facts as the Portal holds them, for the list of what the view shows.
 * @param {import('@ss/contracts').WebsiteSettings} website
 */
export const factsOf = ({ business, region }) => {
	const address = [business.address.line1, business.address.city, business.address.country].filter(Boolean).join(', ');
	return [
		{ label: S.name, value: business.name || '—' },
		{ label: S.email, value: business.email || '—' },
		{ label: S.phone, value: business.phone || '—' },
		{ label: S.address, value: address || '—' },
		{ label: S.timeZone, value: region.timeZone || '—' },
	];
};

/**
 * The Store details view.
 * @param {{ websiteId: string, off?: boolean, portal?: string, admin?: boolean, merchantId?: string | null }} props
 *   `portal`: the Portal's address; `admin`: the viewer is an Owner or Support admin
 */
export function StoreDetailsView({ websiteId, off, portal, admin = false, merchantId = null }) {
	const website = useLoad(`/v1/dashboard/websites/${websiteId}/website-settings`);
	const href = portal ? websiteSettingsUrl({ portal, admin, websiteId, merchantId, section: 'business' }) : undefined;
	return (
		<Loaded answer={website.answer} skeleton={<SettingsCardSkeleton rows={5} title={false} />}>
			{(data) => (
				<Card>
					<div className="space-y-4">
						<p className="text-sm text-muted">{off ? TEXTS.settings.off : S.help}</p>
						<ManagedNote title={S.managedTitle} {...(href ? { href } : {})} linkLabel={S.managedOpen}>
							{S.managed}
						</ManagedNote>
						<KeyValueList items={factsOf(data.settings)} />
						<p className="text-sm text-muted">
							{fill(S.siteHelp, { read: '/v1/shop/store', json: '/v1/shop/store/business-json' })}
						</p>
					</div>
				</Card>
			)}
		</Loaded>
	);
}
