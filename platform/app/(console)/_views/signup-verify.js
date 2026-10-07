import { connection } from 'next/server';
import { VerifyEmailView } from '../../../src/console/views/auth.js';

export const metadata = { title: 'Verify your e-mail' };

export default async function VerifyPage() {
	await connection();
	return <VerifyEmailView />;
}
