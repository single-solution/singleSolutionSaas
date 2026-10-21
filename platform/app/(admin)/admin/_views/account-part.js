import { notFound } from 'next/navigation';
import { loadMyAccount } from '../../../../src/console/admin/loaders.js';
import { MY_ACCOUNT_PARTS } from '../../../../src/console/admin/paths.js';
import { MyAccountView } from '../../../../src/console/admin/views/account.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'My account' };

/** A part of My account: `/admin/account/sign-in`, `/admin/account/two-step` or `/admin/account/activity`. */
/** @param {{ params: Promise<{ part: string }> }} props */
export default async function MyAccountPartPage({ params }) {
	const { part } = await params;
	if (!MY_ACCOUNT_PARTS.includes(part) || part === 'profile') notFound();
	const { api } = await adminContext(`/admin/account/${part}`);
	return <MyAccountView {...await loadMyAccount(api)} part={part} />;
}
