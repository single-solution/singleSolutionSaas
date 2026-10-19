import { notFound } from 'next/navigation';
import { loadMerchant } from '../../../../src/console/admin/loaders.js';
import { MerchantsView } from '../../../../src/console/admin/views/merchants.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Merchant' };

/** The parts of a merchant's page that have their own address (Websites is the merchant's address itself). */
const PARTS = ['websites', 'credits', 'details', 'activity'];

/** A part of a merchant's page: `/admin/merchants/:merchantId/credits`, `details` or `activity`. */
/** @param {{ params: Promise<{ merchantId: string, part: string }> }} props */
export default async function MerchantPartPage({ params }) {
	const { merchantId, part } = await params;
	if (!PARTS.includes(part)) notFound();
	const { api, admin } = await adminContext(`/admin/merchants/${merchantId}/${part}`);
	return <MerchantsView detail={await loadMerchant(api, merchantId, admin)} section={part} admin={admin} />;
}
