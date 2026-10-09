import { AdminFrame } from '../_lib/frame.js';

/**
 * The admin console's frame (menu and top bar) stays on screen across navigations: only the page below it changes,
 * switching to its loading skeleton at once (`[[...path]]/loading.js`).
 * @param {{ children: import('react').ReactNode }} props
 */
export default function AdminLayout({ children }) {
	return <AdminFrame>{children}</AdminFrame>;
}
