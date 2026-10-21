/**
 * @ss/ui — the consoles' component library (React 19, Tailwind 4 with CSS-variable design tokens). Import the
 * tokens once in the app stylesheet (`@import '@ss/ui/theme.css'`). Interactive components are client components
 * (`'use client'`); layout and display components also render on the server.
 * @module
 */
export { cx } from './cx.js';
export { Icon } from './icons.js';
export { Button, IconButton, ButtonLink, FormBusyContext } from './Button.js';
export { Spinner } from './Spinner.js';
export { useNavigationProgress, RouteProgress, PendingHint, PageTransition, SwapTransition } from './motion.js';
export {
	Input,
	TextArea,
	Select,
	Checkbox,
	CheckboxInput,
	Switch,
	RadioGroup,
	SegmentedControl,
	FieldLayoutContext,
	ROW_LIST,
	CheckboxGroup,
	ChoicePicker,
	FieldGrid,
	SuggestInput,
} from './fields.js';
export { Form, FormError } from './Form.js';
export { ListEditor, EntryGroup, LIST_EDITOR_TEXTS, moveItem } from './ListEditor.js';
export {
	Card,
	Avatar,
	Badge,
	StatusBadge,
	StatusPill,
	Callout,
	EmptyState,
	ErrorState,
	Skeleton,
	SkeletonBlock,
	LockedState,
	DOTS,
	TINTS,
	productLook,
	Stat,
	StatGrid,
	STAT_GRID,
	SoftBreaks,
	Section,
	IconBadge,
	Stepper,
	KeyValueList,
	Masonry,
	TextLink,
	ManagedNote,
} from './display.js';
export { Table } from './Table.js';
export { Dialog, Drawer, ConfirmDialog } from './overlay.js';
export { ActionMenu, AccountMenu, ThemeMenu } from './Menu.js';
export { Toolbar, TOOLBAR_TEXTS } from './Toolbar.js';
export { DataTable, DATA_TABLE_TEXTS, useRowSelection } from './DataTable.js';
export { Pagination, PaginationSkeleton } from './Pagination.js';
export { InnerNav, INNER_NAV_TEXTS } from './InnerNav.js';
export { Row } from './Row.js';
export { NextStep, NEXT_STEP_TEXTS } from './NextStep.js';
export { ListColumn, LIST_COLUMN_TEXTS } from './ListColumn.js';
export { useListSelection } from './list-selection.js';
export { Page, PAGE_TEXTS } from './Page.js';
export { useNarrow } from './page-parts.js';
export { SECTION_JUMPS_FROM } from './page-sections.js';
export {
	InnerNavSkeleton,
	ToolbarSkeleton,
	DataTableSkeleton,
	RowListSkeleton,
	PageSkeleton,
	SettingsCardSkeleton,
	StatGridSkeleton,
	DrawerSkeleton,
	DrawerBodySkeleton,
} from './skeletons.js';
export { METRICS } from './layout-metrics.js';
export { TypedConfirmDialog } from './TypedConfirm.js';
export { PasswordConfirmDialog, PASSWORD_CONFIRM_TEXTS } from './PasswordConfirm.js';
export { TOAST_TEXTS, ToastOnce, ToastProvider, useToast } from './Toast.js';
export { CodeBlock, copyText } from './CodeBlock.js';
export { AppShell, ScrollArea, SwitcherSelect, useShell } from './AppShell.js';
// the frame and its scrolling panes by the names of the design spec (owner 2026-10-17)
export { AppShell as AppFrame, ScrollArea as Pane } from './AppShell.js';
export {
	Grid,
	Col,
	SettingList,
	SettingsCard,
	SettingRow,
	SaveBar,
	PillTabs,
	Disclosure,
	NO_STRETCH,
	CARD_FLOW,
	CardFlow,
	useHashSection,
} from './blocks.js';
export { Paged, PAGED_TEXTS, usePaged } from './paged.js';
export { ThemeScript } from './theme-script.js';
export { ThemeToggle, useThemeChoice } from './theme.js';
export { DisplayLocale, LocalTime, useDisplayLocale, useViewerTimeZone } from './time.js';
export { BarChart, isEmptySeries } from './charts.js';
export { SeoPreview } from './SeoPreview.js';
export {
	NeedsList,
	SetupChecklist,
	Timeline,
	RecentChanges,
	ChangesTable,
	ProductOverview,
	OverviewSkeleton,
	initialsOf,
} from './overview.js';
// plain data, not a client module: a product's `texts.js` also gives its server `app/layout.js` the page title
export { DASHBOARD_TEXTS, dashboardTexts, resealAdvice } from './dashboard-texts.js';
export { SchemaForm } from './SchemaForm.js';
export {
	formatCredits,
	formatCreditsPerHour,
	formatDate,
	formatDateTime,
	formatNumber,
	humanize,
	parseCredits,
	supportContact,
} from './format.js';
export { describeProblem, fieldErrors, problemCode, problemLines } from './problems.js';

/** @typedef {import('./AppShell.js').NavSection} NavSection */
/** @typedef {import('./blocks.js').SectionItem} SectionItem */
/** @typedef {import('./blocks.js').SectionSpec} SectionSpec */
/** @typedef {import('./InnerNav.js').InnerNavItem} InnerNavItem */
/** @typedef {import('./InnerNav.js').InnerNavGroup} InnerNavGroup */
/** @typedef {import('./DataTable.js').RowSelection} RowSelection */
/** @typedef {import('./layout-metrics.js').ColumnKind} ColumnKind */
/** @typedef {import('./overlay.js').DrawerProps} DrawerProps */
/** @typedef {import('./page-sections.js').PageSection} PageSection */
/** @typedef {import('./page-parts.js').PageCrumb} PageCrumb */
/** @typedef {import('./page-parts.js').PageFact} PageFact */
/** @typedef {import('./page-parts.js').PageAction} PageAction */
/** @typedef {import('./page-parts.js').PageActions} PageActions */
/** @typedef {import('./page-parts.js').PageStatus} PageStatus */
/** @typedef {import('./Toolbar.js').ToolbarFilter} ToolbarFilter */
/** @typedef {import('./Toolbar.js').ToolbarSearch} ToolbarSearch */
/** @typedef {import('./Toolbar.js').ToolbarBulk} ToolbarBulk */
/** @typedef {import('./icons.js').IconName} IconName */
/** @typedef {import('./display.js').Kind} Kind */
/** @typedef {import('./Menu.js').MenuItem} MenuItem */
/** @typedef {import('./problems.js').Problem} Problem */
/** @typedef {import('./overview.js').Need} Need */
/** @typedef {import('./overview.js').OverviewTab} OverviewTab */
