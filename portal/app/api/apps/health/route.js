import { NextResponse } from 'next/server';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function POST(request) {
	try {
		const { url } = await request.json().catch(() => ({}));
		if (!url) {
			return NextResponse.json({ error: 'URL required' }, { status: 400, headers: CORS_HEADERS });
		}

		const cleanUrl = url.startsWith('http') ? url : `http://${url}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2500);

		const startTime = Date.now();
		let isOnline = false;
		let statusCode = null;

		try {
			const res = await fetch(cleanUrl, {
				method: 'HEAD',
				signal: controller.signal,
				headers: { 'User-Agent': 'SingleSolutionPortalProbe/1.0' },
			});
			clearTimeout(timeoutId);
			statusCode = res.status;
			isOnline = res.status < 500;
		} catch (fetchErr) {
			clearTimeout(timeoutId);
			// Try GET if HEAD fails
			try {
				const resGet = await fetch(cleanUrl, {
					method: 'GET',
					signal: AbortSignal.timeout(1500),
					headers: { 'User-Agent': 'SingleSolutionPortalProbe/1.0' },
				});
				statusCode = resGet.status;
				isOnline = resGet.status < 500;
			} catch {
				isOnline = false;
			}
		}

		const latencyMs = Date.now() - startTime;

		return NextResponse.json(
			{
				url: cleanUrl,
				online: isOnline,
				status: isOnline ? 'operational' : 'unreachable',
				latencyMs,
				statusCode,
				checkedAt: new Date().toISOString(),
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ online: false, status: 'error', error: err.message }, { headers: CORS_HEADERS });
	}
}
