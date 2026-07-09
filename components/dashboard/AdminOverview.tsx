"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { Boxes, CalendarDays, ChevronRight, Copy, Send, Users, Zap } from "lucide-react";

import { useAuth } from "@/components/AuthProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { ListSkeleton } from "@/components/ui/Skeleton";
import { StatCard } from "@/components/ui/StatCard";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { MerchantSummary, ProductSummary } from "@/lib/types";

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

export function AdminOverview() {
  const { user } = useAuth();
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
      setProducts(productsResult.status === "fulfilled" ? productsResult.value.items : []);
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
      setInviteLink(`${window.location.origin}/accept-invite?token=${result.inviteToken}`);
      if (result.emailSent) {
        toast.showSuccess("Invitation sent", `We emailed ${result.owner.email} a link to set up their account.`);
      } else {
        toast.showInfo("Invite created", `Email not configured yet - copy the link and send it to ${result.owner.email}.`);
      }
      setMerchantName("");
      setOwnerName("");
      setOwnerEmail("");
      await load();
    } catch (caughtError) {
      setFormError(caughtError instanceof PlatformApiError ? caughtError.message : "Could not create merchant.");
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
        toast.showSuccess("Invitation resent", `We emailed ${result.ownerEmail} a fresh link.`);
      } else {
        toast.showInfo("Link copied", `Email not configured yet - paste the link to ${result.ownerEmail}.`);
      }
    } catch (caughtError) {
      toast.showError(
        "Could not resend",
        caughtError instanceof PlatformApiError ? caughtError.message : "Try again.",
      );
    } finally {
      setResendingId(null);
    }
  }

  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] || "admin";
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const newThisMonth = merchants.filter((merchant) => merchant.createdAt.slice(0, 7) === monthPrefix).length;
  const activeProducts = products.filter((product) => product.status === "active").length;

  return (
    <div className="page-stack">
      <div className="animate-fade-in-up">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {greeting()}, {firstName}
        </h1>
        <p className="mt-1 text-[13px] text-ink-muted">Platform overview across every merchant and product.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Merchants" value={String(merchants.length)} hint="Total tenants" icon={Users} accent />
        <StatCard label="Products" value={String(products.length)} hint="In catalog" icon={Boxes} />
        <StatCard label="Active products" value={String(activeProducts)} hint="Available to assign" icon={Zap} />
        <StatCard label="New this month" value={String(newThisMonth)} hint={monthPrefix} icon={CalendarDays} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="shadow-sm border-line bg-surface lg:col-span-2">
          <CardHeader title="Merchants" description={`${merchants.length} total`} />
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
          ) : merchants.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No merchants yet"
              description="Onboard your first merchant with the form on the right."
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-left">
                <thead className="bg-surface-subtle">
                  <tr className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                    <th className="px-3 py-2">Merchant</th>
                    <th className="hidden px-3 py-2 sm:table-cell">Slug</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {merchants.map((merchant) => (
                    <tr key={merchant.id} className="group transition-colors hover:bg-surface-subtle">
                      <td className="px-3 py-2.5">
                        <Link href={`/merchants/${merchant.id}`} className="flex items-center gap-2.5">
                          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-subtle text-ink-secondary ring-1 ring-line">
                            <Users className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-ink group-hover:text-brand-700">{merchant.name}</span>
                            {merchant.pendingInvite ? <Badge tone="brand">Pending</Badge> : null}
                          </span>
                        </Link>
                      </td>
                      <td className="hidden px-3 py-2.5 text-[12.5px] text-ink-muted sm:table-cell">{merchant.slug}</td>
                      <td className="px-3 py-2.5 text-[12.5px] text-ink-muted">{merchant.createdAt.slice(0, 10)}</td>
                      <td className="px-3 py-2.5 text-right">
                        {merchant.pendingInvite ? (
                          <Button
                            variant="outline"
                            size="sm"
                            loading={resendingId === merchant.id}
                            onClick={() => void handleResendInvite(merchant)}
                          >
                            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            Invite
                          </Button>
                        ) : (
                          <Link
                            href={`/merchants/${merchant.id}`}
                            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 opacity-0 transition-opacity group-hover:opacity-100"
                          >
                            Open
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="shadow-sm border-line bg-surface h-fit">
          <CardHeader title="Onboard a merchant" description="Creates the merchant, a default site, and emails an invite." />
          {formError ? (
            <Alert tone="danger" title="Could not create" className="mb-4">
              {formError}
            </Alert>
          ) : null}
          <form className="grid gap-3.5" onSubmit={handleCreate} noValidate>
            <Field label="Merchant name" htmlFor="merchant-name" required>
              <Input
                id="merchant-name"
                value={merchantName}
                onChange={(event) => setMerchantName(event.target.value)}
                placeholder="Acme Store"
              />
            </Field>
            <Field label="Owner name" htmlFor="owner-name" required>
              <Input id="owner-name" value={ownerName} onChange={(event) => setOwnerName(event.target.value)} placeholder="Jane Doe" />
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
              <p className="mb-2">One-time link, valid 7 days. The merchant sets their own password.</p>
              <code className="block break-all rounded-md border border-line bg-surface-subtle px-3 py-2 text-xs text-ink">
                {inviteLink}
              </code>
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={() => void copyToClipboard(inviteLink)}>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  Copy link
                </Button>
              </div>
            </Alert>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
