import { notFound, redirect } from 'next/navigation';
import { ACCOUNT_PARTS, routes } from '../../../src/console/paths.js';

export const metadata = { title: 'Account' };

/** A part of the Account page: `/account/sign-in`, `/account/two-step` or `/account/activity` redirects to the section on `/account`. */
/** @param {{ params: Promise<{ part: string }> }} props */
export default async function AccountPartPage({ params }) {
	const { part } = await params;
	if (!ACCOUNT_PARTS.includes(part) || part === 'details') notFound();
	redirect(routes.accountPart(part));
}
