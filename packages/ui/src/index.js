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
export { PageHeader, HeaderMeta, HeaderFact } from './header.js';
export { Table } from './Table.js';
export { Dialog, Drawer, ConfirmDialog } from './overlay.js';
export { ActionMenu, AccountMenu, ThemeMenu } from './Menu.js';
export { RowList, ListRow, Toolbar } from './rows.js';
export { TypedConfirmDialog } from './TypedConfirm.js';
export { PasswordConfirmDialog, PASSWORD_CONFIRM_TEXTS } from './PasswordConfirm.js';
export { ToastOnce, ToastProvider, useToast } from './Toast.js';
export { CodeBlock, copyText } from './CodeBlock.js';
export { AppShell, ContextPill, ScrollArea, SwitcherSelect, useShell } from './AppShell.js';
// the frame and its scrolling panes by the names of the design spec (owner 2026-10-17)
export { AppShell as AppFrame, ScrollArea as Pane } from './AppShell.js';
export {
	Grid,
	Col,
	SettingList,
	SettingsCard,
	SettingRow,
	SaveBar,
	SaveRow,
	SectionNav,
	SectionLayout,
	PillTabs,
	LinkTabs,
	ViewTitle,
	Disclosure,
	ItemSwitcher,
	NO_STRETCH,
	CARD_FLOW,
	CardFlow,
	useHashSection,
} from './blocks.js';
export { Paged, PAGED_TEXTS } from './paged.js';
export { ThemeScript } from './theme-script.js';
export { ThemeToggle, useThemeChoice } from './theme.js';
export { DisplayLocale, LocalTime, useDisplayLocale, useViewerTimeZone } from './time.js';
export { BarChart, isEmptySeries } from './charts.js';
export { SeoPreview } from './SeoPreview.js';
export { NeedsList, SetupChecklist, Timeline, RecentChanges, ProductOverview, OverviewSkeleton, initialsOf } from './overview.js';
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
/** @typedef {import('./icons.js').IconName} IconName */
/** @typedef {import('./display.js').Kind} Kind */
/** @typedef {import('./Menu.js').MenuItem} MenuItem */
/** @typedef {import('./problems.js').Problem} Problem */
/** @typedef {import('./overview.js').Need} Need */
/** @typedef {import('./overview.js').OverviewTab} OverviewTab */
