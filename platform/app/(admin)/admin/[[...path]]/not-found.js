import { ButtonLink, EmptyState } from '@ss/ui';
import { adminRoutes } from '../../../../src/console/admin/paths.js';
import { Link } from '../../../../src/console/link.js';
import { CONSOLE } from '../../../../src/texts/console.js';

// inside the console frame (the layout), like the views: an unknown path or a view's notFound()
export default function AdminNotFound() {
	return (
		<EmptyState
			icon="shield"
			title={CONSOLE.pageNotFound}
			description={CONSOLE.adminPageMissing}
			action={
				<ButtonLink as={Link} href={adminRoutes.merchants()} variant="primary">
					{CONSOLE.backToMerchants}
				</ButtonLink>
			}
		/>
	);
}
