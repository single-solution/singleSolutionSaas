'use client';
/**
 * What the console frame ({@link AppShell}) tells the pages inside it: whether the sidebar is folded to its icon rail,
 * the router link component of the app (so a page's breadcrumbs navigate without a reload) and how to open the
 * navigation sheet on phones (a page's header holds the menu button there). Outside a frame all of it is empty.
 * @module
 */
import { createContext, useContext } from 'react';

/**
 * @typedef {object} ShellState
 * @property {boolean} rail true while the sidebar is folded to icons
 * @property {import('react').ElementType} [linkAs] the app's router link component
 * @property {() => void} [openNav] opens the navigation sheet (phones)
 */

/** @type {import('react').Context<ShellState>} */
export const ShellContext = createContext(/** @type {ShellState} */ ({ rail: false }));

/** @returns {ShellState} the frame state: whether the sidebar is folded, the router link, how to open the menu */
export const useShell = () => useContext(ShellContext);
