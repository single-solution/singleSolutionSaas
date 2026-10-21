import { notFound, redirect } from 'next/navigation';
import { adminRoutes } from '../../../../src/console/admin/paths.js';

export const metadata = { title: 'Merchant' };

/** The parts of a merchant's page that have their own address (Websites is the merchant's address itself). */
const PARTS = ['websites', 'credits', 'details', 'activity'];

/** A part of a merchant's page: `/admin/merchants/:merchantId/:part` redirects to the section on `/admin/merchants/:merchantId`. */
/** @param {{ params: Promise<{ merchantId: string, part: string }> }} props */
export default async function MerchantPartPage({ params }) {
	const { merchantId, part } = await params;
	if (!PARTS.includes(part)) notFound();
	redirect(adminRoutes.merchantPart(merchantId, part));
}
