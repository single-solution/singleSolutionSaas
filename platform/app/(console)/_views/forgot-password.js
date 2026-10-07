import { connection } from 'next/server';
import { ForgotPasswordView } from '../../../src/console/views/auth.js';

export const metadata = { title: 'Reset your password' };

export default async function ForgotPasswordPage() {
	await connection();
	return <ForgotPasswordView />;
}
