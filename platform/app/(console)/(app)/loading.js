import { Skeleton } from '@ss/ui';

export default function Loading() {
	return (
		<div className="space-y-6" aria-busy="true">
			<div className="h-7 w-48 animate-pulse rounded-lg bg-surface-2" />
			<div className="grid gap-4 sm:grid-cols-3">
				{[0, 1, 2].map((i) => (
					<div key={i} className="rounded-card border border-line bg-surface p-5">
						<Skeleton lines={2} />
					</div>
				))}
			</div>
			<div className="rounded-card border border-line bg-surface p-5">
				<Skeleton lines={5} label="Loading the page" />
			</div>
		</div>
	);
}
