import { LoginView } from '../../../src/console/views/auth.js';
import { one, redirectIfSignedIn } from '../_lib/server.js';

export const metadata = { title: 'Sign in' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function LoginPage({ searchParams }) {
	await redirectIfSignedIn();
	const q = await searchParams;
	return <LoginView next={one(q.next) ?? null} expired={one(q.expired) === '1'} reset={one(q.reset) === '1'} />;
}
