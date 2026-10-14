import { connection } from 'next/server';
import { SharedSetupView } from '../../../src/console/views/setup.js';
import { consoleBranding } from '../_lib/server.js';

export const metadata = { title: 'Shared Setup', robots: { index: false, follow: false } };

/** A website's Setup sheet opened from a share link (public, read-only; the key stays in the address fragment). */
export default async function SharedSetupPage() {
	await connection();
	return <SharedSetupView brand={(await consoleBranding()).name} />;
}
