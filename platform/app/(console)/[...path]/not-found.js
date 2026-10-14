import { ButtonLink, EmptyState } from '@ss/ui';
import { Link } from '../../../src/console/link.js';
import { routes } from '../../../src/console/paths.js';
import { CONSOLE } from '../../../src/texts/console.js';

// inside the console frame (the layout), like the views: an unknown path or a view's notFound()
export default function NotFound() {
	return (
		<EmptyState
			icon="globe"
			title={CONSOLE.pageNotFound}
			description={CONSOLE.pageMissing}
			action={
				<ButtonLink as={Link} href={routes.websites()} variant="primary">
					{CONSOLE.backToWebsites}
				</ButtonLink>
			}
		/>
	);
}
