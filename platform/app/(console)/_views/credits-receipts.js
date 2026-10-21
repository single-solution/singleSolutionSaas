import { redirect } from 'next/navigation';
import { routes } from '../../../src/console/paths.js';

export const metadata = { title: 'Credit receipts' };

/** The old receipts sub-page address redirects to the receipts section on the Credits page. */
export default async function CreditReceiptsPage() {
	redirect(routes.creditsReceipts());
}
