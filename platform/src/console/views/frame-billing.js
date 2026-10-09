'use client';
/**
 * The merchant console frame is the console's layout, so it stays across navigations; pages that show money hand it
 * their own fresh billing summary (`FrameBilling`), so the balance and the billing banner are never older than the
 * page (PLAN 0.6: opening a page runs the check).
 * @module
 */
import { createContext, useContext, useEffect } from 'react';

/** Set by the frame: replaces the billing summary it shows. */
export const BillingContext = createContext(/** @type {((billing: any) => void) | null} */ (null));

/**
 * Hands a page's billing summary (from its own check) to the frame's balance and banner.
 * @param {{ billing: any }} props
 */
export function FrameBilling({ billing }) {
	const set = useContext(BillingContext);
	useEffect(() => {
		if (set && billing) set(billing);
	}, [set, billing]);
	return null;
}
