'use client';
import { Button, ErrorState } from '@ss/ui';
import { CONSOLE } from '../../../src/texts/console.js';

/** @param {{ error: Error & { digest?: string }, reset: () => void }} props */
export default function ConsoleError({ error, reset }) {
	return (
		<ErrorState
			title={CONSOLE.pageCrashed}
			message={CONSOLE.pageFailed(error.digest)}
			action={<Button onClick={reset}>{CONSOLE.tryAgain}</Button>}
		/>
	);
}
