import { connection } from 'next/server';
import { ForgotPasswordView } from '../../../src/console/views/sign-in.js';
import { consoleBranding } from '../_lib/server.js';

export const metadata = { title: 'Forgot password' };

export default async function Page() {
	await connection();
	return <ForgotPasswordView branding={await consoleBranding()} />;
}
