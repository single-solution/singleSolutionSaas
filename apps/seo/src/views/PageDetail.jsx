import React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';

export default function PageDetail() {
	const { id } = useParams();

	return (
		<div className="space-y-6 max-w-3xl">
			<PageHeader
				title={`SEO Audit: ${id || '/products/velvet'}`}
				subtitle="Individual URL on-page optimization breakdown"
				actions={
					<Link href="/pages" className="text-xs font-semibold text-zinc-600 hover:text-zinc-900">
						← Back to Index
					</Link>
				}
			/>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<Card title="Meta Tags & OpenGraph">
					<div className="space-y-2 text-xs">
						<div>
							<span className="text-zinc-400 font-bold uppercase text-[10px]">Title</span>
							<p className="font-semibold text-zinc-900">Velvet Embroidered 3-Piece Suit | Sisters Boutique</p>
						</div>
						<div>
							<span className="text-zinc-400 font-bold uppercase text-[10px]">Description</span>
							<p className="text-zinc-600">Shop authentic velvet embroidered suits with fast worldwide shipping.</p>
						</div>
						<div>
							<span className="text-zinc-400 font-bold uppercase text-[10px]">Canonical</span>
							<p className="font-mono text-zinc-500">https://sistersboutique.com/products/velvet-embroidered</p>
						</div>
					</div>
				</Card>

				<Card title="Search Engine Checklist">
					<div className="space-y-2.5 text-xs">
						<div className="flex items-center gap-2 text-emerald-700">
							<CheckCircle2 size={15} />
							<span>Valid JSON-LD Product Schema</span>
						</div>
						<div className="flex items-center gap-2 text-emerald-700">
							<CheckCircle2 size={15} />
							<span>Single H1 Heading Present</span>
						</div>
						<div className="flex items-center gap-2 text-emerald-700">
							<CheckCircle2 size={15} />
							<span>All Images Have Alt Attributes</span>
						</div>
					</div>
				</Card>
			</div>
		</div>
	);
}
