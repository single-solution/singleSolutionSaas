import { describe, expect, it } from 'vitest';
import {
	ADDRESS_COUNTRIES,
	PLACE_PARTS,
	addressFields,
	addressFormat,
	addressLines,
	addressProblem,
	countryChoices,
	countryCodeOf,
	countryName,
	isAddressCountry,
	tidyPostcode,
} from '../src/address.js';

/** @param {ReturnType<typeof addressFields>} fields */
const shown = (fields) => fields.map(({ part, label, required }) => `${part}:${label}${required ? '*' : ''}`);

describe('address formats per country (one table for every product)', () => {
	it('orders, names and requires the parts the way each country writes them', () => {
		expect(shown(addressFields('US'))).toEqual(['line1:line1', 'line2:line2', 'city:city', 'region:state*', 'postalCode:zip*']);
		expect(shown(addressFields('jp'))).toEqual([
			'postalCode:postal*',
			'region:prefecture*',
			'city:city',
			'line1:line1',
			'line2:line2',
		]);
		expect(shown(addressFields('AE'))).toEqual(['line1:line1', 'line2:line2', 'city:city', 'region:emirate*']);
		expect(shown(addressFields('IN'))).toEqual([
			'line1:line1',
			'line2:line2',
			'area:area',
			'city:city',
			'postalCode:pin*',
			'region:state*',
		]);
		expect(shown(addressFields('BR')).slice(2, 3)).toEqual(['area:neighborhood']);
		expect(shown(addressFields('GB'))).toEqual(['line1:line1', 'line2:line2', 'city:post_town', 'postalCode:postal*']);
	});

	it('gives every other country (and none) a plain default: street, city, an optional postal code', () => {
		for (const country of ['', 'XX', 'FJ', 'ZM', null])
			expect(shown(addressFields(country)).slice(0, 3)).toEqual(['line1:line1', 'line2:line2', 'city:city']);
		expect(shown(addressFields('ZM'))).toContain('postalCode:postal');
		// no postal code where the country has none
		expect(shown(addressFields('FJ'))).not.toContain('postalCode:postal');
		expect(addressFormat('ZM').country).toBe('ZM');
		expect(addressFormat('XX').country).toBe('');
	});

	it('adds the parts the website requires or asks after the part they usually follow; a postal code only where one exists', () => {
		expect(shown(addressFields('US', { required: ['area', 'line1', 'city'] }))).toEqual([
			'line1:line1*',
			'line2:line2',
			'area:area*',
			'city:city*',
			'region:state*',
			'postalCode:zip*',
		]);
		expect(shown(addressFields('GB', { ask: ['region'] }))).toContain('region:region');
		expect(shown(addressFields('JP', { required: ['area'] })).indexOf('area:area*')).toBe(5);
		expect(shown(addressFields('AE', { required: ['postalCode'] }))).not.toContain('postalCode:postal*');
	});

	it('finds the first part a country refuses: a required one left empty or a postal code of another shape', () => {
		expect(addressProblem({ country: 'US', line1: '1 Main St', city: 'Austin' })).toEqual({
			part: 'region',
			problem: 'required',
		});
		expect(addressProblem({ country: 'US', region: 'TX', postalCode: '7870' })).toEqual({
			part: 'postalCode',
			problem: 'postcode',
		});
		expect(addressProblem({ country: 'US', region: 'TX', postalCode: '78701-1234' })).toBeNull();
		expect(addressProblem({ country: 'GB', postalCode: 'sw1a 1aa' })).toBeNull();
		expect(addressProblem({ country: 'GB', postalCode: 'SW1A1AA' })).toBeNull();
		expect(addressProblem({ country: 'GB', postalCode: '12345' })?.problem).toBe('postcode');
		expect(addressProblem({ country: 'CA', region: 'ON', postalCode: 'K1A 0B1' })).toBeNull();
		// the website's required parts, and the country of an address without one
		expect(addressProblem({}, { required: ['line1'] })).toEqual({ part: 'line1', problem: 'required' });
		expect(addressProblem({ region: 'Tokyo' }, { country: 'JP' })).toEqual({ part: 'postalCode', problem: 'required' });
		// any postal code where the shape is not known, none where the country has none
		expect(addressProblem({ country: 'ZM', postalCode: 'anything 1' })).toBeNull();
		expect(addressProblem({ country: 'AE', region: 'Dubai', postalCode: '' }, { required: ['postalCode'] })).toBeNull();
	});

	it('writes an address the way its country does, leaving out empty parts', () => {
		expect(
			addressLines({ country: 'US', line1: '1 Main St', line2: '', city: 'Austin', region: 'TX', postalCode: '78701' }),
		).toEqual(['1 Main St', 'Austin, TX 78701']);
		expect(addressLines({ country: 'US', line1: '1 Main St', city: 'Austin', postalCode: '78701' })).toEqual([
			'1 Main St',
			'Austin 78701',
		]);
		expect(addressLines({ line1: '5 Rue X', city: 'Paris', postalCode: '75001' }, 'FR')).toEqual(['5 Rue X', '75001 Paris']);
		expect(
			addressLines({ country: 'JP', line1: '1-1 Chiyoda', city: 'Chiyoda-ku', region: 'Tokyo', postalCode: '1000001' }),
		).toEqual(['1000001', 'Tokyo', 'Chiyoda-ku', '1-1 Chiyoda']);
		// a part the country does not use is still shown, never lost
		expect(addressLines({ country: 'GB', line1: '1 High St', area: 'Soho', city: 'London', postalCode: 'w1d 1aa' })).toEqual([
			'1 High St',
			'London',
			'W1D 1AA',
			'Soho',
		]);
	});

	it('lists countries by code and name, and reads a code or an English name', () => {
		expect(ADDRESS_COUNTRIES.length).toBeGreaterThan(240);
		expect(isAddressCountry('GB')).toBe(true);
		expect(isAddressCountry('gb')).toBe(false);
		expect(countryName('GB')).toBe('United Kingdom');
		expect(countryName('Atlantis')).toBe('Atlantis');
		expect(countryCodeOf('gb')).toBe('GB');
		expect(countryCodeOf(' united kingdom ')).toBe('GB');
		expect(countryCodeOf('Côte d’Ivoire')).toBe('CI');
		expect(countryCodeOf('Atlantis')).toBeNull();
		expect(countryCodeOf(42)).toBeNull();
		const choices = countryChoices();
		expect(choices).toHaveLength(ADDRESS_COUNTRIES.length);
		expect(choices[0]?.label.localeCompare(choices[1]?.label ?? '')).toBeLessThan(0);
		expect(tidyPostcode('  sw1a   1aa ')).toBe('SW1A 1AA');
		expect(PLACE_PARTS).toEqual(['line1', 'line2', 'area', 'city', 'region', 'postalCode']);
	});
});
