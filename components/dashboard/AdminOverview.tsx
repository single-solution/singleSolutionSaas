"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import {
  Boxes,
  CalendarDays,
  ChevronRight,
  Copy,
  Grid3X3,
  List,
  Globe,
  Mail,
  Search,
  Send,
  UserPlus,
  Users,
  Zap,
} from "lucide-react";

import { useAuth } from "@/components/AuthProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { formatCurrency } from "@/components/products/currency";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { MerchantSummary, ProductSummary } from "@/lib/types";

interface AdminOverviewProps {
  mode?: "dashboard" | "directory";
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 18) {
    return "Good afternoon";
  }
  return "Good evening";
}

export function AdminOverview({ mode = "directory" }: AdminOverviewProps) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [merchants, setMerchants] = useState<MerchantSummary[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [merchantName, setMerchantName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [showOnboard, setShowOnboard] = useState(false);
  const search = searchParams.get("search") ?? "";
  const view = searchParams.get("view") === "table" ? "table" : "grid";

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const [merchantsResult, productsResult] = await Promise.allSettled([
        platformApi.listAllMerchantsAdmin(),
        platformApi.listAdminProducts(),
      ]);
      if (merchantsResult.status === "fulfilled") {
        setMerchants(merchantsResult.value.items);
      } else {
        setError("Could not load merchants.");
      }
      setProducts(
        productsResult.status === "fulfilled" ? productsResult.value.items : [],
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!merchantName.trim() || !ownerName.trim() || !ownerEmail.trim()) {
      setFormError("Merchant name, owner name, and email are required.");
      return;
    }
    setCreating(true);
    try {
      const result = await platformApi.createMerchant({
        merchantName: merchantName.trim(),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
      });
      setInviteLink(
        `${window.location.origin}/accept-invite?token=${result.inviteToken}`,
      );
      if (result.emailSent) {
        toast.showSuccess(
          "Invitation sent",
          `We emailed ${result.owner.email} a link to set up their account.`,
        );
      } else {
        toast.showInfo(
          "Invite created",
          `Email not configured yet - copy the link and send it to ${result.owner.email}.`,
        );
      }
      setMerchantName("");
      setOwnerName("");
      setOwnerEmail("");
      await load();
    } catch (caughtError) {
      setFormError(
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Could not create merchant.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function copyToClipboard(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      toast.showSuccess("Copied", "Invite link copied to clipboard.");
    } catch {
      toast.showError("Copy failed", "Copy the link manually.");
    }
  }

  async function handleResendInvite(merchant: MerchantSummary) {
    setResendingId(merchant.id);
    try {
      const result = await platformApi.resendMerchantInvite(merchant.id);
      const link = `${window.location.origin}/accept-invite?token=${result.inviteToken}`;
      setInviteLink(link);
      await copyToClipboard(link);
      if (result.emailSent) {
        toast.showSuccess(
          "Invitation resent",
          `We emailed ${result.ownerEmail} a fresh link.`,
        );
      } else {
        toast.showInfo(
          "Link copied",
          `Email not configured yet - paste the link to ${result.ownerEmail}.`,
        );
      }
    } catch (caughtError) {
      toast.showError(
        "Could not resend",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again.",
      );
    } finally {
      setResendingId(null);
    }
  }

  function updateQuery(key: "search" | "view", value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || (key === "view" && value === "grid")) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    router.replace(`${pathname}${next.size ? `?${next.toString()}` : ""}`, {
      scroll: false,
    });
  }

  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] || "admin";
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const newThisMonth = merchants.filter(
    (merchant) => merchant.createdAt.slice(0, 7) === monthPrefix,
  ).length;
  const activeProducts = products.filter(
    (product) => product.status === "active",
  ).length;
  const normalizedSearch = search.trim().toLowerCase();
  const matchingMerchants = merchants.filter(
    (merchant) =>
      !normalizedSearch ||
      [merchant.name, merchant.slug, merchant.ownerEmail].some((value) =>
        value?.toLowerCase().includes(normalizedSearch),
      ),
  );
  const displayedMerchants =
    mode === "dashboard"
      ? matchingMerchants
          .filter((merchant) => merchant.pendingInvite)
          .slice(0, 4)
      : matchingMerchants;
  const isDashboard = mode === "dashboard";

  return (
    <div className="page-stack">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between animate-fade-in-up">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {isDashboard ? `${greeting()}, ${firstName}` : "Merchants"}
          </h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            {isDashboard
              ? "Operational health and onboarding attention across the platform."
              : "Search, onboard, and manage merchant accounts."}
          </p>
        </div>
        <Button onClick={() => setShowOnboard((current) => !current)}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {showOnboard ? "Close" : "Onboard merchant"}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Merchants"
          value={String(merchants.length)}
          hint="Total tenants"
          icon={Users}
          accent
        />
        <StatCard
          label="Products"
          value={String(products.length)}
          hint="In catalog"
          icon={Boxes}
        />
        <StatCard
          label="Active products"
          value={String(activeProducts)}
          hint="Available to assign"
          icon={Zap}
        />
        <StatCard
          label="New this month"
          value={String(newThisMonth)}
          hint={monthPrefix}
          icon={CalendarDays}
        />
      </div>

      {!isDashboard ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-subtle/50 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(event) => updateQuery("search", event.target.value)}
              className="pl-9"
              aria-label="Search merchants"
              placeholder="Search by merchant, owner email, or slug..."
            />
          </div>
          <div
            className="flex rounded-md border border-line bg-surface p-0.5"
            aria-label="Merchant view"
            role="group"
          >
            <Button
              variant={view === "grid" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => updateQuery("view", "grid")}
              aria-label="Grid view"
            >
              <Grid3X3 className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              variant={view === "table" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => updateQuery("view", "table")}
              aria-label="Table view"
            >
              <List className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <span className="text-sm text-ink-muted">
            {displayedMerchants.length} results
          </span>
        </div>
      ) : null}

      <Modal
        open={showOnboard}
        title="Onboard a merchant"
        description="Creates the merchant, a default site, and emails an invite."
        onClose={() => setShowOnboard(false)}
      >
        {formError ? (
          <Alert tone="danger" title="Could not create" className="mb-4">
            {formError}
          </Alert>
        ) : null}
        <form className="grid gap-4" onSubmit={handleCreate} noValidate>
          <Field label="Merchant name" htmlFor="merchant-name" required>
            <Input
              id="merchant-name"
              value={merchantName}
              onChange={(event) => setMerchantName(event.target.value)}
              placeholder="Acme Store"
            />
          </Field>
          <Field label="Owner name" htmlFor="owner-name" required>
            <Input
              id="owner-name"
              value={ownerName}
              onChange={(event) => setOwnerName(event.target.value)}
              placeholder="Jane Doe"
            />
          </Field>
          <Field label="Owner email" htmlFor="owner-email" required>
            <Input
              id="owner-email"
              type="email"
              value={ownerEmail}
              autoComplete="off"
              onChange={(event) => setOwnerEmail(event.target.value)}
              placeholder="jane@acme.com"
            />
          </Field>
          <Button type="submit" loading={creating}>
            <Send className="h-4 w-4" aria-hidden="true" />
            Send invite
          </Button>
        </form>

        {inviteLink ? (
          <Alert tone="success" title="Invite link ready" className="mt-4">
            <p className="mb-2">
              One-time link, valid 7 days. The merchant sets their own password.
            </p>
            <code className="block break-all rounded-md border border-line bg-surface-subtle px-3 py-2 text-xs text-ink">
              {inviteLink}
            </code>
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyToClipboard(inviteLink)}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                Copy link
              </Button>
            </div>
          </Alert>
        ) : null}
      </Modal>

      {error ? (
        <Alert tone="danger" title="Load failed">
          {error}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Alert>
      ) : null}

      {loading ? (
        <ListSkeleton />
      ) : displayedMerchants.length === 0 ? (
        <EmptyState
          icon={Users}
          title={
            isDashboard ? "No onboarding needs attention" : "No merchants yet"
          }
          description={
            isDashboard
              ? "All merchant invitations have been accepted."
              : "Onboard your first merchant to get started."
          }
        />
      ) : !isDashboard && view === "table" ? (
        <DataTable
          caption="Platform merchants"
          rows={displayedMerchants}
          getRowKey={(merchant) => merchant.id}
          columns={[
            {
              key: "merchant",
              header: "Merchant",
              render: (merchant) => (
                <Link
                  href={`/merchants/${merchant.id}`}
                  className="font-medium text-ink hover:text-brand-700"
                >
                  {merchant.name}
                </Link>
              ),
            },
            {
              key: "owner",
              header: "Owner",
              render: (merchant) => merchant.ownerEmail ?? "No owner",
            },
            {
              key: "sites",
              header: "Sites",
              align: "right",
              render: (merchant) => merchant.siteCount ?? 0,
            },
            {
              key: "products",
              header: "Products",
              align: "right",
              render: (merchant) => merchant.productCount ?? 0,
            },
            {
              key: "mrr",
              header: "MRR",
              align: "right",
              render: (merchant) =>
                merchant.monthlySpend && merchant.currency
                  ? formatCurrency(merchant.monthlySpend, merchant.currency)
                  : "—",
            },
            {
              key: "status",
              header: "Status",
              align: "center",
              render: (merchant) => (
                <Badge tone={merchant.pendingInvite ? "brand" : "success"}>
                  {merchant.pendingInvite ? "Pending" : "Active"}
                </Badge>
              ),
            },
          ]}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {displayedMerchants.map((merchant, index) => (
            <div
              key={merchant.id}
              style={{ animationDelay: `${index * 0.04}s` }}
              className="flex animate-fade-in-up flex-col rounded-xl border border-line bg-surface p-5 shadow-sm transition-all hover:border-brand-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/merchants/${merchant.id}`}
                  className="group flex min-w-0 items-center gap-3"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
                    <Users className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold tracking-tight text-ink group-hover:text-brand-700">
                      {merchant.name}
                    </h3>
                    <p className="truncate text-[13px] text-ink-muted">
                      {merchant.slug}
                    </p>
                  </div>
                </Link>
                <Badge tone={merchant.pendingInvite ? "brand" : "success"}>
                  {merchant.pendingInvite ? "Pending" : "Active"}
                </Badge>
              </div>

              {merchant.ownerEmail ? (
                <p className="mt-3 flex items-center gap-1.5 truncate text-[13px] text-ink-secondary">
                  <Mail
                    className="h-3.5 w-3.5 shrink-0 text-ink-faint"
                    aria-hidden="true"
                  />
                  <span className="truncate">{merchant.ownerEmail}</span>
                </p>
              ) : null}

              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4 text-center">
                <div>
                  <p className="flex items-center justify-center gap-1 text-sm font-semibold text-ink">
                    <Globe
                      className="h-3.5 w-3.5 text-ink-faint"
                      aria-hidden="true"
                    />
                    {merchant.siteCount ?? 0}
                  </p>
                  <p className="mt-0.5 text-[11px] uppercase tracking-wide text-ink-faint">
                    Sites
                  </p>
                </div>
                <div>
                  <p className="flex items-center justify-center gap-1 text-sm font-semibold text-ink">
                    <Boxes
                      className="h-3.5 w-3.5 text-ink-faint"
                      aria-hidden="true"
                    />
                    {merchant.productCount ?? 0}
                  </p>
                  <p className="mt-0.5 text-[11px] uppercase tracking-wide text-ink-faint">
                    Products
                  </p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink">
                    {merchant.monthlySpend && merchant.currency
                      ? formatCurrency(merchant.monthlySpend, merchant.currency)
                      : "-"}
                  </p>
                  <p className="mt-0.5 text-[11px] uppercase tracking-wide text-ink-faint">
                    /mo
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
                <span className="text-[12px] text-ink-faint">
                  Created {merchant.createdAt.slice(0, 10)}
                </span>
                {merchant.pendingInvite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={resendingId === merchant.id}
                    onClick={() => void handleResendInvite(merchant)}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Resend
                  </Button>
                ) : null}
                <Link
                  href={`/merchants/${merchant.id}`}
                  className="ml-auto inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:text-brand-800"
                >
                  Manage
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
      {isDashboard ? (
        <div className="flex justify-end">
          <Link
            href="/merchants"
            className="text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            View all merchants
          </Link>
        </div>
      ) : null}
    </div>
  );
}
