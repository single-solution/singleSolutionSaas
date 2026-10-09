import { ButtonLink, EmptyState } from '@ss/ui';
import { Link } from '../../../src/console/link.js';

// inside the console frame (the layout), like the views: an unknown path or a view's notFound()
export default function NotFound() {
	return (
		<EmptyState
			icon="globe"
			title="Page not found"
			description="The page does not exist or you do not have access to it."
			action={
				<ButtonLink as={Link} href="/websites" variant="primary">
					Back to websites
				</ButtonLink>
			}
		/>
	);
}
