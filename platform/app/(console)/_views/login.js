import { SignInView } from '../../../src/console/views/sign-in.js';
import { consoleBranding, firstAdminAvailable, one, redirectIfSignedIn } from '../_lib/server.js';

export const metadata = { title: 'Sign in' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function LoginPage({ searchParams }) {
	await redirectIfSignedIn();
	const q = await searchParams;
	const notice = one(q.expired) === '1' ? 'expired' : one(q.notice);
	return (
		<SignInView
			branding={await consoleBranding()}
			firstAdmin={await firstAdminAvailable()}
			next={one(q.next) ?? null}
			notice={notice === 'expired' || notice === 'reset' || notice === 'email' ? notice : null}
		/>
	);
}
