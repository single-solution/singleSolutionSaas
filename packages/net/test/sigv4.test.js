import { describe, expect, it } from 'vitest';
import { amzDates, objectUrl, presignV4, signV4, uriEncode } from '../src/index.js';

// AWS S3 documentation example credentials ("Signature Calculations for the Authorization Header" / "Query String")
const S3 = {
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	region: 'us-east-1',
	now: Date.parse('2013-05-24T00:00:00Z'),
};
// AWS Signature Version 4 test suite credentials
const SUITE = {
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
	region: 'us-east-1',
	service: 'service',
	now: Date.parse('2015-08-30T12:36:00Z'),
	contentSha256Header: false,
};
const PREFIX = 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ';

describe('signV4 (AWS reference vectors)', () => {
	it('GET object with a range header', () => {
		const headers = signV4({
			...S3,
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/test.txt',
			headers: { range: 'bytes=0-9' },
		});
		expect(headers.authorization).toBe(
			`${PREFIX}SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
		);
		expect(headers).not.toHaveProperty('host');
		expect(headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(headers['x-amz-date']).toBe('20130524T000000Z');
	});

	it('PUT object with a payload', () => {
		const headers = signV4({
			...S3,
			method: 'PUT',
			url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
			headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
			body: 'Welcome to Amazon S3.',
		});
		expect(headers.authorization).toBe(
			`${PREFIX}SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd`,
		);
		const bytes = signV4({
			...S3,
			method: 'PUT',
			url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
			headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
			body: new TextEncoder().encode('Welcome to Amazon S3.'),
		});
		expect(bytes.authorization).toBe(headers.authorization);
	});

	it('GET bucket lifecycle and list objects (query strings)', () => {
		expect(signV4({ ...S3, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle' }).authorization).toBe(
			`${PREFIX}SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543`,
		);
		expect(
			signV4({ ...S3, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J' }).authorization,
		).toBe(
			`${PREFIX}SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7`,
		);
	});

	it('SigV4 test suite: get-vanilla and get-vanilla-query-order-key-case', () => {
		const base =
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date';
		expect(signV4({ ...SUITE, method: 'GET', url: 'https://example.amazonaws.com/' }).authorization).toBe(
			`${base}, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`,
		);
		expect(
			signV4({ ...SUITE, method: 'get', url: new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1') })
				.authorization,
		).toBe(`${base}, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500`);
	});

	it('signs session tokens, precomputed payload hashes and sorts duplicate query keys by value', () => {
		const signed = signV4({
			...S3,
			sessionToken: 'tok',
			method: 'PUT',
			url: 'https://b.s3.amazonaws.com/k?b=2&a=2&a=1',
			payloadHash: 'UNSIGNED-PAYLOAD',
		});
		expect(signed['x-amz-security-token']).toBe('tok');
		expect(signed['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
		expect(signed.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,');
		const reordered = signV4({
			...S3,
			sessionToken: 'tok',
			method: 'PUT',
			url: 'https://b.s3.amazonaws.com/k?a=1&b=2&a=2',
			payloadHash: 'UNSIGNED-PAYLOAD',
		});
		expect(reordered.authorization).toBe(signed.authorization);
		expect(() => signV4({ ...S3, accessKeyId: '', method: 'GET', url: 'https://b/x' })).toThrow(TypeError);
		expect(signV4({ ...S3, now: undefined, method: 'GET', url: 'https://b.s3.amazonaws.com/' })['x-amz-date']).toMatch(
			/^\d{8}T\d{6}Z$/,
		);
	});
});

describe('presignV4 (AWS reference vector)', () => {
	it('presigns GET object exactly like the AWS documentation example', () => {
		const url = presignV4({ ...S3, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', expiresIn: 86400 });
		expect(url).toBe(
			'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404&X-Amz-SignedHeaders=host',
		);
	});

	it('adds the session token, extra query and signed headers, and validates expiry', () => {
		const url = presignV4({
			...S3,
			region: 'eu-west-1',
			sessionToken: 'tok',
			method: 'PUT',
			url: 'https://b.s3.amazonaws.com/a%20b',
			expiresIn: 60,
			query: { x: "it's" },
			headers: { 'Content-Type': 'image/png' },
		});
		const params = new URL(url).searchParams;
		expect(params.get('X-Amz-Security-Token')).toBe('tok');
		expect(params.get('X-Amz-SignedHeaders')).toBe('content-type;host');
		expect(url).toContain('x=it%27s');
		expect(url.startsWith('https://b.s3.amazonaws.com/a%20b?')).toBe(true);
		const withQuery = presignV4({ ...S3, method: 'GET', url: 'https://b.s3.amazonaws.com/k?versionId=3', expiresIn: 5 });
		expect(new URL(withQuery).searchParams.get('versionId')).toBe('3');
		for (const expiresIn of [0, 604_801, 1.5]) {
			expect(() => presignV4({ ...S3, method: 'GET', url: 'https://b/x', expiresIn })).toThrow(RangeError);
		}
		expect(() => presignV4({ ...S3, region: '', method: 'GET', url: 'https://b/x', expiresIn: 1 })).toThrow(TypeError);
		expect(
			new URL(presignV4({ ...S3, now: undefined, method: 'GET', url: 'https://b/x', expiresIn: 1 })).searchParams.get(
				'X-Amz-Date',
			),
		).toMatch(/Z$/);
	});
});

describe('helpers', () => {
	it('encodes like RFC 3986 and builds object URLs', () => {
		expect(uriEncode("a b/c!'()*~._-", true)).toBe('a%20b/c%21%27%28%29%2A~._-');
		expect(uriEncode('a/b')).toBe('a%2Fb');
		expect(amzDates(Date.parse('2013-05-24T00:00:00.123Z'))).toEqual({ amzDate: '20130524T000000Z', dateStamp: '20130524' });
		expect(amzDates(new Date(0)).dateStamp).toBe('19700101');
		expect(amzDates().amzDate).toMatch(/^\d{8}T\d{6}Z$/);
		expect(objectUrl({ region: 'eu-west-1', bucket: 'b' }, 'p/k.txt')).toBe('https://b.s3.eu-west-1.amazonaws.com/p/k.txt');
		expect(objectUrl({ region: 'eu-west-1', bucket: 'b', forcePathStyle: true }, 'k')).toBe(
			'https://s3.eu-west-1.amazonaws.com/b/k',
		);
		expect(objectUrl({ endpoint: 'https://acc.r2.example.com', region: 'auto', bucket: 'b' }, 'k')).toBe(
			'https://acc.r2.example.com/b/k',
		);
		expect(
			objectUrl({ endpoint: 'https://minio.example.com', region: 'auto', bucket: 'b', forcePathStyle: false }, 'a b'),
		).toBe('https://b.minio.example.com/a%20b');
	});
});
