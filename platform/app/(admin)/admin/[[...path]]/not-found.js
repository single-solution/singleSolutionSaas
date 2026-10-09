import { ButtonLink, EmptyState } from '@ss/ui';
import { Link } from '../../../../src/console/link.js';

// inside the console frame (the layout), like the views: an unknown path or a view's notFound()
export default function AdminNotFound() {
	return (
		<EmptyState
			icon="shield"
			title="Page not found"
			description="The admin page does not exist."
			action={
				<ButtonLink as={Link} href="/admin/merchants" variant="primary">
					Back to merchants
				</ButtonLink>
			}
		/>
	);
}
