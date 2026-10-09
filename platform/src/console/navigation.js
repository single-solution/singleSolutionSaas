'use client';
/**
 * Client-side navigation of the consoles in a transition (searches, filters, going to a new or after a removed item):
 * the page stays on screen and usable while the next one loads, the progress bar shows, and `pending` drives the
 * spinner of the button that started it. A full page load is never needed to move inside a console.
 * @module
 */
import { useRouter } from 'next/navigation.js';
import { useTransition } from 'react';
import { FormBusyContext, useNavigationProgress } from '@ss/ui';

/** @returns {{ pending: boolean, go: (href: string) => void }} */
export const useNavigation = () => {
	const router = useRouter();
	const [pending, start] = useTransition();
	useNavigationProgress(pending);
	return { pending, go: (href) => start(() => router.push(href)) };
};

/**
 * A filter form (GET): submitting opens this page with the form's filled fields as its query, without a page load;
 * its submit button shows the spinner until the filtered page is there.
 * @param {{ label?: string, className?: string, children: import('react').ReactNode }} props
 */
export function FilterForm({ label, className, children }) {
	const nav = useNavigation();
	return (
		<form
			method="get"
			aria-label={label}
			aria-busy={nav.pending || undefined}
			className={className}
			onSubmit={(event) => {
				event.preventDefault();
				const query = new URLSearchParams();
				for (const [name, value] of new FormData(event.currentTarget))
					if (typeof value === 'string' && value !== '') query.set(name, value);
				const search = query.toString();
				nav.go(`${window.location.pathname}${search ? `?${search}` : ''}`);
			}}>
			<FormBusyContext.Provider value={nav.pending}>{children}</FormBusyContext.Provider>
		</form>
	);
}
