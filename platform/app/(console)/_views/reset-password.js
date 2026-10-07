import { connection } from 'next/server';
import { ResetPasswordView } from '../../../src/console/views/auth.js';

export const metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage() {
	await connection();
	return <ResetPasswordView />;
}
