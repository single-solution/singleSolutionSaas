'use client';
import { Button, ErrorState } from '@ss/ui';

/** @param {{ error: Error & { digest?: string }, reset: () => void }} props */
export default function ConsoleError({ error, reset }) {
	return (
		<ErrorState
			title="Something went wrong"
			message={`This page failed to load. Try again in a moment.${error.digest ? ` (reference ${error.digest})` : ''}`}
			action={<Button onClick={reset}>Try again</Button>}
		/>
	);
}
