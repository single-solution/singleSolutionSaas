import { connection } from 'next/server';
import { AcceptInviteView } from '../../../../../src/console/views/auth.js';

export const metadata = { title: 'Join your team' };

export default async function AcceptInvitePage() {
	await connection();
	return <AcceptInviteView />;
}
