import type { ComponentType } from "react";
import {
  Activity,
  Boxes,
  CreditCard,
  Globe,
  History,
  LayoutDashboard,
  Settings,
  Shield,
  Users,
} from "lucide-react";

export interface PortalNavigationItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export interface MerchantContextLink {
  tabId: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export const merchantHeaderNavigation: PortalNavigationItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/sites", label: "Sites", icon: Globe },
];

export const merchantWorkspaceNavigation: PortalNavigationItem[] = [
  ...merchantHeaderNavigation,
  { href: "/settings", label: "Settings", icon: Settings },
];

export const adminHeaderNavigation: PortalNavigationItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/merchants", label: "Merchants", icon: Users },
  { href: "/sites", label: "Sites", icon: Globe },
  { href: "/products", label: "Products", icon: Boxes },
];

export const adminWorkspaceNavigation: PortalNavigationItem[] = [
  ...adminHeaderNavigation,
];

export const merchantContextLinks: MerchantContextLink[] = [
  { tabId: "overview", label: "Overview", icon: LayoutDashboard },
  { tabId: "sites", label: "Sites and products", icon: Globe },
  { tabId: "billing", label: "Billing", icon: CreditCard },
  { tabId: "team", label: "Team", icon: Users },
  { tabId: "history", label: "Subscription history", icon: History },
  { tabId: "offboarding", label: "Offboarding", icon: Shield },
  { tabId: "activity", label: "Activity log", icon: Activity },
];

/** Return the primary header navigation allowed for the signed-in role. */
export function getHeaderNavigation(
  isPlatformAdmin: boolean,
): PortalNavigationItem[] {
  return isPlatformAdmin
    ? adminHeaderNavigation
    : merchantHeaderNavigation;
}

/** Return categorized workspace shortcuts allowed for the signed-in role. */
export function getWorkspaceNavigation(
  isPlatformAdmin: boolean,
): PortalNavigationItem[] {
  return isPlatformAdmin
    ? adminWorkspaceNavigation
    : merchantWorkspaceNavigation;
}

/** Build a URL-backed merchant detail tab link. */
export function getMerchantTabHref(
  merchantId: string,
  tabId: string,
): string {
  const merchantHref = `/merchants/${merchantId}`;

  return tabId === "overview"
    ? merchantHref
    : `${merchantHref}?tab=${tabId}`;
}
