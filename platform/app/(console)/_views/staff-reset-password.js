import { connection } from 'next/server';
import { StaffResetPasswordView } from '../../../src/console/admin/views/auth.js';

export const metadata = { title: 'Set your staff password', robots: { index: false, follow: false } };

// Target of the staff setup and reset e-mails (identity link path `/staff/reset-password#token=…`).
export default async function StaffResetPasswordPage() {
	await connection();
	return <StaffResetPasswordView />;
}
