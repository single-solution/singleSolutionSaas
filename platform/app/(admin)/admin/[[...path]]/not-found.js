import { ButtonLink, EmptyState } from '@ss/ui';
import { AdminFrame } from '../../_lib/frame.js';

// inside the shell, like the views (an unknown path or a view's notFound())
export default function AdminNotFound() {
	return (
		<AdminFrame>
			<EmptyState
				icon="shield"
				title="Page not found"
				description="The admin page does not exist."
				action={
					<ButtonLink href="/admin/merchants" variant="primary">
						Back to merchants
					</ButtonLink>
				}
			/>
		</AdminFrame>
	);
}
