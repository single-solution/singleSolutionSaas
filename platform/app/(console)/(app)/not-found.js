import { ButtonLink, EmptyState } from '@ss/ui';

export default function NotFound() {
	return (
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
	);
}
