import { describe, expect, it } from 'vitest';
import { createOutboundPolicy, isSafeMongoUri, parseMongoUri } from '../src/index.js';

const policy = createOutboundPolicy();
const dev = createOutboundPolicy({ allowHosts: ['127.0.0.1', 'localhost'] });

describe('parseMongoUri', () => {
	it('parses standard and SRV strings', () => {
		const parsed = parseMongoUri(
			'mongodb://app%40x:p%40ss@a.example.com:27017,[2606:4700::1]:27018/shop?tls=true&replicaSet=rs0',
		);
		expect(parsed).toMatchObject({
			ok: true,
			value: {
				scheme: 'mongodb',
				username: 'app@x',
				hasPassword: true,
				hosts: [
					{ host: 'a.example.com', port: 27017 },
					{ host: '[2606:4700::1]', port: 27018 },
				],
				dbName: 'shop',
			},
		});
		expect(parseMongoUri('mongodb+srv://cluster0.example.net/')).toMatchObject({
			ok: true,
			value: { scheme: 'mongodb+srv', username: null, hasPassword: false, dbName: null },
		});
		expect(parseMongoUri('mongodb://u@h.example.com/a%20b')).toMatchObject({
			ok: true,
			value: { username: 'u', hasPassword: false, dbName: 'a b' },
		});
	});

	it.each([
		['mongodb://', 'missing_host'],
		['mongodb://u:p@', 'missing_host'],
		['mongodb://:p@h.example.com/db', 'empty_username'],
		['mongodb://u:p/x@h.example.com/db', 'invalid_host'],
		['mongodb://u:p:x@y@h.example.com/db', 'userinfo_not_encoded'],
		['mongodb://u%zz:p@h.example.com/db', 'userinfo_not_encoded'],
		['mongodb://h.example.com:0/db', 'invalid_port'],
		['mongodb://h.example.com:99999/db', 'invalid_port'],
		['mongodb://h.example.com:abc/db', 'invalid_host'],
		['mongodb+srv://a.example.com,b.example.com/db', 'srv_single_host'],
		['mongodb+srv://a.example.com:27017/db', 'srv_single_host'],
		['mongodb://h.example.com/%zz', 'invalid_db_name'],
		['postgres://h.example.com/db', 'unsupported_scheme'],
		[42, 'invalid_uri'],
	])('rejects %s', (uri, reason) => {
		expect(parseMongoUri(uri)).toEqual({ ok: false, reason });
	});
});

describe('isSafeMongoUri', () => {
	it('accepts public hosts with TLS and safe options', () => {
		expect(isSafeMongoUri('mongodb+srv://u:p@cluster0.example.net/shop', policy)).toMatchObject({
			ok: true,
			tls: true,
			allowlisted: false,
		});
		expect(
			isSafeMongoUri('mongodb://u:p@db.example.com:27017/shop?tls=true&authSource=admin&authMechanism=SCRAM-SHA-256', policy),
		).toMatchObject({ ok: true, tls: true });
		expect(isSafeMongoUri('mongodb://u:p@db.example.com/shop?ssl=true&retryWrites=true&w=majority', policy)).toMatchObject({
			ok: true,
		});
		expect(isSafeMongoUri('mongodb://u:p@[2606:4700::1]:27017/shop?tls=true', policy)).toMatchObject({ ok: true });
	});

	it('requires TLS unless every host is allowlisted', () => {
		expect(isSafeMongoUri('mongodb://u:p@db.example.com/shop', policy)).toEqual({
			ok: false,
			code: 'tls_required',
			reason: 'tls_required',
		});
		expect(isSafeMongoUri('mongodb+srv://u:p@cluster0.example.net/shop?tls=false', policy)).toMatchObject({
			code: 'tls_required',
		});
		expect(isSafeMongoUri('mongodb://localhost:27017/dev', dev)).toMatchObject({ ok: true, tls: false, allowlisted: true });
		expect(isSafeMongoUri('mongodb://localhost:27017,db.example.com/dev', dev)).toMatchObject({ code: 'tls_required' });
	});

	it.each([
		['mongodb+srv://u:p@localhost/shop', 'internal_name'],
		['mongodb://u:p@10.0.0.5/shop?tls=true', 'private_address'],
		['mongodb://u:p@169.254.169.254/shop?tls=true', 'metadata_address'],
		['mongodb://u:p@[::1]:27017/shop?tls=true', 'loopback_address'],
		['mongodb://u:p@[::ffff:127.0.0.1]:27017/shop?tls=true', 'loopback_address'],
		['mongodb://u:p@2130706433/shop?tls=true', 'loopback_address'],
		['mongodb://u:p@0x7f.1/shop?tls=true', 'loopback_address'],
		['mongodb://u:p@0x08080808/shop?tls=true', 'ip_spelling'],
		['mongodb://u:p@db.internal/shop?tls=true', 'internal_name'],
		['mongodb://u:p@a.example.com,10.1.1.1/shop?tls=true', 'private_address'],
	])('refuses internal host %s', (uri, reason) => {
		expect(isSafeMongoUri(uri, policy)).toEqual({ ok: false, code: 'ssrf_blocked', reason });
	});

	it.each([
		['tlsCAFile=/etc/passwd', 'option_tlscafile'],
		['tlsCertificateKeyFile=/x', 'option_tlscertificatekeyfile'],
		['tlsInsecure=true', 'option_tlsinsecure'],
		['tlsAllowInvalidCertificates=true', 'option_tlsallowinvalidcertificates'],
		['tlsAllowInvalidHostnames=true', 'option_tlsallowinvalidhostnames'],
		['proxyHost=10.0.0.1', 'option_proxyhost'],
		['authMechanismProperties=ENVIRONMENT:azure', 'option_authmechanismproperties'],
		['authMechanism=MONGODB-AWS', 'auth_mechanism'],
		['authMechanism=MONGODB-OIDC', 'auth_mechanism'],
		['authMechanism=MONGODB-X509', 'auth_mechanism'],
	])('refuses unsafe option %s', (opt, reason) => {
		expect(isSafeMongoUri(`mongodb+srv://u:p@c.example.net/shop?${opt}`, policy)).toEqual({
			ok: false,
			code: 'unsafe_option',
			reason,
		});
	});

	it('reports malformed strings as bad_url', () => {
		expect(isSafeMongoUri('nope', policy)).toEqual({ ok: false, code: 'bad_url', reason: 'unsupported_scheme' });
		expect(isSafeMongoUri('mongodb://u:p@bad..host/x', policy)).toMatchObject({ ok: false, code: 'bad_url' });
	});
});
