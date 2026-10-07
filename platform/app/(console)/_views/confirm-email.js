import { connection } from 'next/server';
import { ConfirmEmailView } from '../../../src/console/views/sign-in.js';
import { consoleBranding } from '../_lib/server.js';

export const metadata = { title: 'Confirm your new e-mail' };

export default async function Page() {
	await connection();
	return <ConfirmEmailView branding={await consoleBranding()} />;
}
