import { connection } from 'next/server';
import { SetPasswordView } from '../../../src/console/views/sign-in.js';
import { consoleBranding } from '../_lib/server.js';

export const metadata = { title: 'Set your password' };

export default async function Page() {
	await connection();
	return <SetPasswordView branding={await consoleBranding()} />;
}
