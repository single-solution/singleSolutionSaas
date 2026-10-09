import { ConsoleLoading } from '../../../src/console/views/loading.js';

/** Shown at once on every navigation inside the merchant console, while the page is on the way (prefetched up to here). */
export default function Loading() {
	return <ConsoleLoading area="merchant" />;
}
