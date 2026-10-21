import { notFound } from 'next/navigation';
import { loadAccount } from '../../../src/console/loaders.js';
import { ACCOUNT_PARTS } from '../../../src/console/paths.js';
import { AccountView } from '../../../src/console/views/account.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Account' };

/** A part of the Account page: `/account/sign-in`, `/account/two-step` or `/account/activity`. */
/** @param {{ params: Promise<{ part: string }> }} props */
export default async function AccountPartPage({ params }) {
	const { part } = await params;
	if (!ACCOUNT_PARTS.includes(part) || part === 'details') notFound();
	const { api, merchantId } = await merchantContext(`/account/${part}`);
	return <AccountView {...await loadAccount(api, merchantId)} part={part} />;
}
