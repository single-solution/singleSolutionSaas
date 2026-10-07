import { ButtonLink, EmptyState } from '@ss/ui';
import { ConsoleFrame } from '../_lib/frame.js';

// inside the shell, like the views (an unknown path or a view's notFound())
export default function NotFound() {
	return (
		<ConsoleFrame>
			<EmptyState
				icon="globe"
				title="Page not found"
				description="The page does not exist or you do not have access to it."
				action={
					<ButtonLink href="/websites" variant="primary">
						Back to websites
					</ButtonLink>
				}
			/>
		</ConsoleFrame>
	);
}
