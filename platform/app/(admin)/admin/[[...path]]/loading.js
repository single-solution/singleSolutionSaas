import { ConsoleLoading } from '../../../../src/console/views/loading.js';

/** Shown at once on every navigation inside the admin console, while the page is on the way (prefetched up to here). */
export default function AdminLoading() {
	return <ConsoleLoading area="admin" />;
}
