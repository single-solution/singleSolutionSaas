import { connection } from 'next/server';
import { StaffForgotPasswordView } from '../../../../src/console/admin/views/auth.js';

export const metadata = { title: 'Reset your staff password' };

export default async function StaffForgotPasswordPage() {
	await connection();
	return <StaffForgotPasswordView />;
}
