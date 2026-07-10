"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Boxes,
  ChevronRight,
  CreditCard,
  Globe,
  Mail,
  ShieldCheck,
  UserRound,
  Wallet,
} from "lucide-react";

import { getMerchantTabHref } from "@/components/layout/portalNavigation";
import { SitesOverview } from "@/components/products/SitesOverview";
import type { SiteOverview } from "@/components/products/useMerchantOverview";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { MerchantOverviewSkeleton } from "@/components/ui/portalSkeletons";
import type { MerchantSummary } from "@/lib/types";

interface MerchantOverviewProps {
  merchantId: string;
  merchant: MerchantSummary;
  sites: SiteOverview[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function MerchantOverview({
  merchantId,
  merchant,
  sites,
  loading,
  error,
  onRetry,
}: MerchantOverviewProps) {
  if (loading) {
    return <MerchantOverviewSkeleton />;
  }

  if (error) {
    return (
      <Alert tone="danger" title="Could not load overview">
        {error}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }

  const activeProducts = sites.reduce(
    (sum, entry) => sum + entry.activeProducts,
    0,
  );
  const verifiedDomains = sites.filter(
    (entry) => entry.site.domainVerificationStatus === "verified",
  ).length;
  const unverifiedSites = sites.filter(
    (entry) =>
      entry.site.primaryDomain &&
      entry.site.domainVerificationStatus !== "verified",
  );
  const attentionItems: Array<{ message: string; href: string }> = [];

  if (merchant.pendingInvite) {
    attentionItems.push({
      message: "Owner invitation is still pending",
      href: getMerchantTabHref(merchantId, "team"),
    });
  }
  if (activeProducts === 0) {
    attentionItems.push({
      message: "No active products across sites",
      href: getMerchantTabHref(merchantId, "sites"),
    });
  }
  if (unverifiedSites.length > 0) {
    attentionItems.push({
      message: `${unverifiedSites.length} ${
        unverifiedSites.length === 1 ? "site has" : "sites have"
      } an unverified domain`,
      href: getMerchantTabHref(merchantId, "sites"),
    });
  }

  const accountStatus = merchant.pendingInvite
    ? "Invite pending"
    : "Account active";

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Sites"
          value={String(sites.length)}
          hint="Deployments"
          icon={Globe}
        />
        <StatCard
          label="Active products"
          value={String(activeProducts)}
          hint="Across all sites"
          icon={Boxes}
        />
        <StatCard
          label="Verified domains"
          value={String(verifiedDomains)}
          hint={
            sites.length > 0
              ? `${sites.length - verifiedDomains} unverified`
              : "No sites yet"
          }
          icon={ShieldCheck}
        />
        <StatCard
          label="Account"
          value={accountStatus}
          hint={merchant.ownerEmail ?? "Owner email unavailable"}
          icon={UserRound}
        />
      </div>

      {attentionItems.length > 0 ? (
        <Card className="border-warning-border bg-warning-soft/40">
          <CardHeader
            title="Needs attention"
            description="Operational items that may block go-live."
          />
          <ul className="space-y-2">
            {attentionItems.map((item) => (
              <li key={item.message}>
                <Link
                  href={item.href}
                  className="flex min-h-11 items-center gap-2 rounded-md px-2 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-subtle"
                >
                  <AlertTriangle
                    className="h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <span className="flex-1">{item.message}</span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-ink-faint"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <SectionHeader
            title="Sites"
            href={getMerchantTabHref(merchantId, "sites")}
            linkLabel="All sites"
          />
          <SitesOverview sites={sites.slice(0, 3)} hrefBase="/sites" />
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Team"
              description="Account owner and membership state."
            />
            <dl className="space-y-3 text-[13px]">
              <div>
                <dt className="text-ink-faint">Owner email</dt>
                <dd className="mt-0.5 flex items-center gap-2 font-medium text-ink">
                  <Mail className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                  {merchant.ownerEmail ?? "Not available"}
                </dd>
              </div>
              <div>
                <dt className="text-ink-faint">Invitation</dt>
                <dd className="mt-0.5 font-medium text-ink">
                  {merchant.pendingInvite ? "Pending acceptance" : "Accepted"}
                </dd>
              </div>
              <div>
                <dt className="text-ink-faint">Created</dt>
                <dd className="mt-0.5 font-medium text-ink">
                  {formatDate(merchant.createdAt)}
                </dd>
              </div>
            </dl>
            <Link
              href={getMerchantTabHref(merchantId, "team")}
              className="mt-4 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-brand-700 hover:text-brand-800"
            >
              Manage team
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Card>

          <Card>
            <CardHeader
              title="Billing"
              description="Subscription footprint without cross-currency totals."
            />
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-lg bg-brand-50 text-brand-700">
                <Wallet className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-xl font-semibold text-ink">
                  {activeProducts}
                </p>
                <p className="text-[13px] text-ink-muted">
                  Active product{activeProducts === 1 ? "" : "s"} billed
                </p>
              </div>
            </div>
            <p className="mt-3 text-[13px] text-ink-muted">
              Open billing for currency-specific monthly totals and line items.
            </p>
            <Link
              href={getMerchantTabHref(merchantId, "billing")}
              className="mt-4 inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-brand-700 hover:text-brand-800"
            >
              <CreditCard className="h-4 w-4" aria-hidden="true" />
              View billing
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  href,
  linkLabel,
}: {
  title: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-[15px] font-semibold tracking-tight text-ink">
        {title}
      </h3>
      <Link
        href={href}
        className="inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-brand-700 hover:text-brand-800"
      >
        {linkLabel}
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
