import { SignupView } from '../../../src/console/views/auth.js';
import { redirectIfSignedIn } from '../_lib/server.js';

export const metadata = { title: 'Create your account' };

export default async function SignupPage() {
	await redirectIfSignedIn();
	return <SignupView />;
}
