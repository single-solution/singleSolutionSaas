import { notFound, redirect } from 'next/navigation';
import { MY_ACCOUNT_PARTS, adminRoutes } from '../../../../src/console/admin/paths.js';

export const metadata = { title: 'My account' };

/** A part of My account: `/admin/account/sign-in`, `/admin/account/two-step` or `/admin/account/activity` redirects to the section on `/admin/account`. */
/** @param {{ params: Promise<{ part: string }> }} props */
export default async function MyAccountPartPage({ params }) {
	const { part } = await params;
	if (!MY_ACCOUNT_PARTS.includes(part) || part === 'profile') notFound();
	redirect(adminRoutes.accountPart(part));
}
