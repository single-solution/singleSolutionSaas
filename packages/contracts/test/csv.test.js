import { describe, expect, it } from 'vitest';
import { csvCell, csvRecords, parseCsv, toCsv } from '../src/csv.js';

describe('CSV writer', () => {
	it('writes a byte order mark, CRLF records and quoted cells', () => {
		expect(
			toCsv(
				['Name', 'Note'],
				[
					['Zoë', 'a, "b"\nc'],
					['José', null],
				],
			),
		).toBe('\uFEFFName,Note\r\nZoë,"a, ""b""\nc"\r\nJosé,\r\n');
		expect(toCsv(['a', 'b'], [])).toBe('\uFEFFa,b\r\n');
	});

	it('guards text a spreadsheet would run as a formula, never numbers', () => {
		expect(['=1+1', '+1 555', '-x', '@SUM(A1)', '\tx', '\rx'].map((text) => csvCell(text))).toEqual([
			"'=1+1",
			"'+1 555",
			"'-x",
			"'@SUM(A1)",
			"'\tx",
			'"\'\rx"',
		]);
		expect(csvCell("'=x")).toBe("''=x");
		expect(csvCell("'plain")).toBe("'plain");
		expect(csvCell('a=b')).toBe('a=b');
		expect([-12.5, 0, 1250, Number.NaN, Number.POSITIVE_INFINITY].map((number) => csvCell(number))).toEqual([
			'-12.5',
			'0',
			'1250',
			'',
			'',
		]);
		expect([true, false, undefined].map((value) => csvCell(value))).toEqual(['true', 'false', '']);
	});

	it('quotes by the delimiter in use', () => {
		expect(csvCell('a,b', ';')).toBe('a,b');
		expect(csvCell('a;b', ';')).toBe('"a;b"');
		expect(toCsv(['x', 'y'], [['1,5', 2]], { delimiter: ';' })).toBe('\uFEFFx;y\r\n1,5;2\r\n');
	});
});

describe('CSV parser', () => {
	it('reads quoted cells, doubled quotes, line breaks and any record end', () => {
		expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\r\nlines",z\rlast,')).toEqual({
			ok: true,
			rows: [
				['a', 'b'],
				['x, y', 'say "hi"'],
				['two\r\nlines', 'z'],
				['last', ''],
			],
		});
	});

	it('drops the byte order mark and blank lines, and gives back what the writer wrote', () => {
		const rows = [
			['=1+1', "'=x", "''+y", "'plain", '-12', 'Zoë, "quoted"'],
			[' spaced ', '', '\tz', '@', 'a\nb', '+'],
		];
		const parsed = parseCsv(`${toCsv(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], rows)}\r\n   \r\n`);
		expect(parsed).toEqual({ ok: true, rows: [['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], ...rows] });
	});

	it('finds the delimiter of the first line, or takes the one given', () => {
		expect(parseCsv('a;b;c\n1,5;2;3')).toEqual({
			ok: true,
			rows: [
				['a', 'b', 'c'],
				['1,5', '2', '3'],
			],
		});
		expect(parseCsv('a\tb\n1\t2')).toEqual({
			ok: true,
			rows: [
				['a', 'b'],
				['1', '2'],
			],
		});
		expect(parseCsv('single\nvalue')).toEqual({ ok: true, rows: [['single'], ['value']] });
		expect(parseCsv('a;b\n1;2', { delimiter: ',' })).toEqual({ ok: true, rows: [['a;b'], ['1;2']] });
	});

	it('refuses empty files, open quotes and too many rows', () => {
		expect(parseCsv('')).toEqual({ ok: false, code: 'empty' });
		expect(parseCsv('\uFEFF\r\n \n')).toEqual({ ok: false, code: 'empty' });
		expect(parseCsv('a\n"open')).toEqual({ ok: false, code: 'unterminated_quote' });
		expect(parseCsv('h\n1\n2\n3', { maxRows: 2 })).toEqual({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('h\n1\n2\n', { maxRows: 1 })).toEqual({ ok: false, code: 'too_many_rows' });
		expect(parseCsv('h\n1\n2\n', { maxRows: 2 })).toMatchObject({ ok: true });
	});

	it('keys records by the header', () => {
		const parsed = parseCsv(' Name ,EMAIL,,name,__proto__\nAna , ana@example.com ,x,ignored,p\nBo\n');
		if (!parsed.ok) throw new Error('parse failed');
		const { header, records } = csvRecords(parsed.rows);
		expect(header).toEqual(['name', 'email', '', 'name', '__proto__']);
		expect(records).toEqual([
			{ line: 2, values: { name: 'Ana', email: 'ana@example.com', ['__proto__']: 'p' } },
			{ line: 3, values: { name: 'Bo', email: '', ['__proto__']: '' } },
		]);
		expect(Object.getPrototypeOf(records[0]?.values)).toBe(Object.prototype);
		expect(csvRecords([])).toEqual({ header: [], records: [] });
	});
});
