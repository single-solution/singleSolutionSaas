'use client';
import { Button, Page } from '@ss/ui';
import { CONSOLE } from '../../../src/texts/console.js';

/** A page that crashed: a Page of the console frame with the message and a try-again button. */
/** @param {{ error: Error & { digest?: string }, reset: () => void }} props */
export default function ConsoleError({ error, reset }) {
	return (
		<Page
			crumbs={[{ label: CONSOLE.pageCrashed }]}
			error={{ message: CONSOLE.pageFailed(error.digest), action: <Button onClick={reset}>{CONSOLE.tryAgain}</Button> }}
		/>
	);
}
