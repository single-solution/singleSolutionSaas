import { redirect } from 'next/navigation';

// The console lives under /websites (signed-out visitors are sent on to /login by the console layout).
export default function Home() {
	redirect('/websites');
}
