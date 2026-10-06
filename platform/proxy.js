// Next.js proxy (formerly middleware): per-request CSP nonce for HTML pages. Logic lives in src/infra/security-headers.js.
// Delivery responses (/w/*, /p/*) set their own policies (cross-origin scripts; sandboxed previews) and are excluded.
// On the dedicated preview origin (PREVIEW_ORIGIN) no console page is served (API routes refuse it in portal.handle).
import { NextResponse } from 'next/server';
import { createNonce, pageCsp } from './src/infra/security-headers.js';

/** @returns {string | null} */
const previewHost = () => {
	try {
		return process.env.PREVIEW_ORIGIN ? new URL(process.env.PREVIEW_ORIGIN).host : null;
	} catch {
		return null;
	}
};

/** @param {import('next/server').NextRequest} request */
export function proxy(request) {
	const preview = previewHost();
	if (preview !== null && request.nextUrl.host === preview)
		return new NextResponse('Not found', {
			status: 404,
			headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
		});
	const nonce = createNonce();
	const local = request.nextUrl.protocol === 'http:';
	const csp = pageCsp({ nonce, dev: process.env.NODE_ENV === 'development', upgradeInsecure: !local });
	const headers = new Headers(request.headers);
	headers.set('x-nonce', nonce);
	headers.set('content-security-policy', csp);
	const response = NextResponse.next({ request: { headers } });
	response.headers.set('content-security-policy', csp);
	return response;
}

export const config = {
	matcher: [
		{
			source: '/((?!api|v1|w/|p/|healthz|readyz|\\.well-known|_next/static|_next/image|favicon.ico).*)',
			missing: [
				{ type: 'header', key: 'next-router-prefetch' },
				{ type: 'header', key: 'purpose', value: 'prefetch' },
			],
		},
	],
};
