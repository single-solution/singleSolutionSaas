import { redirect } from 'next/navigation';

export const metadata = { title: 'Sign in' };

/** Admins sign in on the one sign-in page (PLAN 0.8.2). */
export default function AdminLoginPage() {
	redirect('/login');
}
