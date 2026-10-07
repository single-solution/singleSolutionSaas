import { connection } from 'next/server';
import { ResetPasswordView } from '../../../src/console/views/sign-in.js';
import { consoleBranding } from '../_lib/server.js';

export const metadata = { title: 'Choose a new password' };

export default async function Page() {
	await connection();
	return <ResetPasswordView branding={await consoleBranding()} />;
}
