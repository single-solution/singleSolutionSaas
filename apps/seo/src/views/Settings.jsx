'use client';

import React, { useState } from 'react';
import { Save, CheckCircle2, Copy, Check, Code, Sparkles, Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { Select } from '@saas/ui/selects/Select';
import { useAppContext } from '../context/AppContext';

export default function Settings() {
	const { activeStore } = useAppContext() || {};
	const [saved, setSaved] = useState(false);
	const [copied, setCopied] = useState(false);

	const [schemaType, setSchemaType] = useState('Product');
	const [storeName, setStoreName] = useState(activeStore?.name || 'Sisters Boutique');
	const [productName, setProductName] = useState('Pure Velvet Embroidered Kurti');
	const [productPrice, setProductPrice] = useState('49.99');
	const [currency, setCurrency] = useState('USD');
	const [sku, setSku] = useState('SB-VELVET-01');

	const generatedSchema = {
		'@context': 'https://schema.org/',
		'@type': schemaType,
		...(schemaType === 'Product'
			? {
					name: productName,
					sku: sku,
					brand: { '@type': 'Brand', name: storeName },
					offers: {
						'@type': 'Offer',
						priceCurrency: currency,
						price: productPrice,
						availability: 'https://schema.org/InStock',
						itemCondition: 'https://schema.org/NewCondition',
					},
					aggregateRating: {
						'@type': 'AggregateRating',
						ratingValue: '4.9',
						reviewCount: '48',
					},
				}
			: schemaType === 'Organization'
				? {
						name: storeName,
						url: activeStore?.domain ? `https://${activeStore.domain}` : 'https://yourstore.com',
						logo: 'https://yourstore.com/logo.png',
						contactPoint: {
							'@type': 'ContactPoint',
							telephone: '+92-300-1234567',
							contactType: 'customer service',
						},
					}
				: {
						mainEntity: [
							{
								'@type': 'Question',
								name: 'What is your shipping policy?',
								acceptedAnswer: {
									'@type': 'Answer',
									text: 'We deliver in 2-4 business days with nationwide Cash on Delivery.',
								},
							},
						],
					}),
	};

	const schemaSnippet = `<script type="application/ld+json">\n${JSON.stringify(generatedSchema, null, 2)}\n</script>`;

	const handleCopy = () => {
		navigator.clipboard.writeText(schemaSnippet);
		setCopied(true);
		setTimeout(() => setCopied(false), 2500);
	};

	return (
		<div className="space-y-6 max-w-4xl pb-12">
			<PageHeader
				title="JSON-LD Structured Data Studio"
				subtitle="Generate Google-compliant Rich Snippet schemas for Products, FAQs, and Storefront Organizations"
			/>

			{saved && (
				<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 animate-fade-in">
					<CheckCircle2 size={16} />
					<span className="font-semibold">Structured data configuration saved and active!</span>
				</div>
			)}

			<Card title="Schema Markup Generator">
				<div className="space-y-4">
					<div>
						<Label>Select Structured Data Type</Label>
						<Select value={schemaType} onChange={(e) => setSchemaType(e.target.value)}>
							<option value="Product">Product Rich Snippet (Price, SKU, Rating)</option>
							<option value="Organization">Storefront Brand & Organization (Logo, Contact)</option>
							<option value="FAQPage">FAQ Rich Snippet (Search Expandable Answers)</option>
						</Select>
					</div>

					{schemaType === 'Product' && (
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<div>
								<Label>Sample Product Name</Label>
								<Input value={productName} onChange={(e) => setProductName(e.target.value)} />
							</div>
							<div>
								<Label>SKU / Barcode</Label>
								<Input value={sku} onChange={(e) => setSku(e.target.value)} />
							</div>
							<div>
								<Label>Product Price</Label>
								<Input value={productPrice} onChange={(e) => setProductPrice(e.target.value)} />
							</div>
							<div>
								<Label>Currency Code</Label>
								<Input value={currency} onChange={(e) => setCurrency(e.target.value)} />
							</div>
						</div>
					)}

					<div className="pt-2 space-y-2">
						<div className="flex items-center justify-between">
							<Label>Generated JSON-LD Tag</Label>
							<button
								type="button"
								onClick={handleCopy}
								className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-all">
								{copied ? <Check size={13} /> : <Copy size={13} />}
								<span>{copied ? 'Copied Tag' : 'Copy JSON-LD'}</span>
							</button>
						</div>
						<pre className="p-4 rounded-xl bg-slate-900 text-slate-200 font-mono text-[11px] overflow-x-auto leading-relaxed border border-slate-800">
							{schemaSnippet}
						</pre>
					</div>

					<div className="pt-3 flex justify-end">
						<Button
							onClick={() => {
								setSaved(true);
								setTimeout(() => setSaved(false), 3000);
							}}>
							<Save size={13} />
							<span>Save Schema Template</span>
						</Button>
					</div>
				</div>
			</Card>
		</div>
	);
}
