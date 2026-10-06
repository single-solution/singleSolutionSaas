// Next.js proxy: while the environment is misconfigured (e.g. MONGODB_URI missing in production) every request,
// pages included, answers 503 with { status: 'misconfigured', problems } instead of a blank 500.
export { proxy } from '@ss/app-kit/proxy';
