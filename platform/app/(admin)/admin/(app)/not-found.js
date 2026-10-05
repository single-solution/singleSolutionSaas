import { ButtonLink, EmptyState } from '@ss/ui';

export default function AdminNotFound() {
	return (
		<EmptyState
			icon="shield"
			title="Page not found"
			description="The admin page does not exist."
			action={
				<ButtonLink href="/admin" variant="primary">
					Back to the dashboard
				</ButtonLink>
			}
		/>
	);
}
