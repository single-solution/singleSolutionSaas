'use client';
/**
 * `<SeoPreview>` — the search result and share card preview of a page (R7 #105) in a React dashboard: the same part
 * the widgets draw (`@ss/ui/seo-preview`), redrawn as its props change. Its styles go into the document once.
 * @module
 */
import { useEffect, useRef } from 'react';
import { SEO_PREVIEW_CSS, seoPreview } from './seo-preview.js';

/** @param {Document} doc */
const addStyles = (doc) => {
	if (doc.head.querySelector('style[data-ss-seo-preview]')) return;
	const style = doc.createElement('style');
	style.setAttribute('data-ss-seo-preview', '');
	style.textContent = SEO_PREVIEW_CSS;
	doc.head.append(style);
};

/**
 * @param {import('./seo-preview.js').SeoPreviewInput & {
 *   texts?: Partial<Record<keyof typeof import('./seo-preview.js').SEO_PREVIEW_TEXTS, string>>, className?: string }} props
 */
export function SeoPreview({ title, description, url, siteName, image, texts, className }) {
	const box = useRef(/** @type {HTMLDivElement | null} */ (null));
	const view = useRef(
		/** @type {{ words: string, update: (input: import('./seo-preview.js').SeoPreviewInput) => void } | null} */ (null),
	);
	const words = JSON.stringify(texts ?? {});
	useEffect(() => {
		const holder = box.current;
		if (!holder) return;
		const input = { title, description, url, siteName, image };
		if (view.current?.words === words) {
			view.current.update(input);
			return;
		}
		addStyles(holder.ownerDocument);
		const made = seoPreview(holder.ownerDocument, input, { texts: JSON.parse(words) });
		holder.replaceChildren(made.node);
		view.current = { words, update: made.update };
	}, [title, description, url, siteName, image, words]);
	return <div ref={box} className={className} />;
}
