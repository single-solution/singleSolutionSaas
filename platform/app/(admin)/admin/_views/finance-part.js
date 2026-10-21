import { notFound } from 'next/navigation';
import { FINANCE_PARTS } from '../../../../src/console/admin/paths.js';
import { FinanceScreen } from './finance.js';

export const metadata = { title: 'Credits and billing' };

/** A part of Credits and billing: `/admin/finance/receipts` or `/admin/finance/charges`; any other is a 404. */
/** @param {{ params: Promise<{ part: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function FinancePartPage({ params, searchParams }) {
	const { part } = await params;
	if (!FINANCE_PARTS.includes(/** @type {any} */ (part)) || part === 'attention') notFound();
	return <FinanceScreen part={part} searchParams={searchParams} />;
}
