import { NextResponse } from 'next/server';

const SESSION_SECRET = process.env.PORTAL_SESSION_SECRET || 'singlesolution_master_session_secret_v3_99418';
const COOKIE_NAME = 'portal_session';

async function verifyEdgeSession(token) {
	if (!token || typeof token !== 'string') return null;
	const parts = token.split('.');
	if (parts.length !== 2) return null;

	const [encodedData, signature] = parts;

	try {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey('raw', encoder.encode(SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign',
		]);

		const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedData));
		const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');

		if (signature !== expectedSignature) return null;

		// Decode payload
		const jsonString = atob(encodedData.replace(/-/g, '+').replace(/_/g, '/'));
		const payload = JSON.parse(jsonString);

		if (payload.exp && Date.now() > payload.exp) return null;
		return payload;
	} catch {
		return null;
	}
}

export async function middleware(request) {
	const { pathname } = request.nextUrl;

	// Public routes
	const isPublicAuthRoute = pathname === '/login' || pathname === '/setup';
	const token = request.cookies.get(COOKIE_NAME)?.value;
	const session = await verifyEdgeSession(token);
	const isLoggedIn = Boolean(session);

	// Root path handling
	if (pathname === '/') {
		if (!isLoggedIn) {
			return NextResponse.redirect(new URL('/login', request.url));
		}
		const redirectPath = session?.role === 'merchant' ? '/merchant/home' : '/admin';
		return NextResponse.redirect(new URL(redirectPath, request.url));
	}

	// If already logged in and visiting login or setup -> redirect to dashboard
	if (isPublicAuthRoute) {
		if (isLoggedIn) {
			const redirectPath = session?.role === 'merchant' ? '/merchant/home' : '/admin';
			return NextResponse.redirect(new URL(redirectPath, request.url));
		}
		return NextResponse.next();
	}

	// Protected routes: /admin and /merchant
	if (pathname.startsWith('/admin') || pathname.startsWith('/merchant')) {
		if (!isLoggedIn) {
			const loginUrl = new URL('/login', request.url);
			loginUrl.searchParams.set('callbackUrl', pathname);
			return NextResponse.redirect(loginUrl);
		}

		// Role enforcement
		if (pathname.startsWith('/admin') && session.role !== 'admin' && session.role !== 'owner') {
			return NextResponse.redirect(new URL('/merchant/home', request.url));
		}
	}

	return NextResponse.next();
}

export const config = {
	matcher: [
		/*
		 * Match all request paths except:
		 * - api (API routes)
		 * - _next/static (static files)
		 * - _next/image (image optimization files)
		 * - favicon.ico (favicon file)
		 * - static assets (png, jpg, jpeg, svg, gif, webp, etc.)
		 */
		'/((?!api|_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf)).*)',
	],
};
