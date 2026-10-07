// Next.js proxy (formerly middleware): per-request CSP nonce for HTML pages. Logic lives in src/infra/security-headers.js.
// Delivery responses (/w/*) set their own policies (cross-origin scripts) and are excluded.
import { NextResponse } from 'next/server';
import { createNonce, pageCsp } from './src/infra/security-headers.js';

/** @param {import('next/server').NextRequest} request */
export function proxy(request) {
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
			source: '/((?!api|v1|w/|branding/|\\.well-known|_next/static|_next/image|favicon.ico).*)',
			missing: [
				{ type: 'header', key: 'next-router-prefetch' },
				{ type: 'header', key: 'purpose', value: 'prefetch' },
			],
		},
	],
};
