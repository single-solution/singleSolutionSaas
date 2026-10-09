import { ConsoleFrame } from './_lib/frame.js';

/**
 * The merchant console's frame (menu, top bar, balance and billing banner) stays on screen across navigations: only
 * the page below it changes, switching to its loading skeleton at once (`[...path]/loading.js`). The public account
 * pages (sign-in and the e-mailed links) stay unframed.
 * @param {{ children: import('react').ReactNode }} props
 */
export default function ConsoleLayout({ children }) {
	return <ConsoleFrame>{children}</ConsoleFrame>;
}
