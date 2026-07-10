"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Globe, Search, Users } from "lucide-react";

import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { platformApi } from "@/lib/api/client";
import type {
  MerchantSummary,
  ProductSummary,
  SiteSummary,
  UserSummary,
} from "@/lib/types";

interface CommandResult {
  key: string;
  label: string;
  description: string;
  href: string;
  kind: "Merchant" | "Site" | "Product";
}

export function CommandSearch({ user }: { user: UserSummary }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [merchants, setMerchants] = useState<MerchantSummary[]>([]);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = (values: Array<string | undefined>) =>
      !normalized ||
      values.some((value) => value?.toLowerCase().includes(normalized));
    const merchantResults: CommandResult[] = merchants
      .filter((merchant) =>
        matches([merchant.name, merchant.slug, merchant.ownerEmail]),
      )
      .map((merchant) => ({
        key: `merchant-${merchant.id}`,
        label: merchant.name,
        description: merchant.ownerEmail ?? merchant.slug,
        href: `/merchants/${merchant.id}`,
        kind: "Merchant",
      }));
    const siteResults: CommandResult[] = sites
      .filter((site) =>
        matches([site.name, site.slug, site.primaryDomain, site.merchantName]),
      )
      .map((site) => ({
        key: `site-${site.id}`,
        label: site.name,
        description:
          site.primaryDomain || site.merchantName || "No domain configured",
        href: `/sites/${site.id}`,
        kind: "Site",
      }));
    const productResults: CommandResult[] = products
      .filter((product) =>
        matches([product.name, product.slug, product.baseUrl]),
      )
      .map((product) => ({
        key: `product-${product.slug}`,
        label: product.name,
        description: product.slug,
        href: `/products/${product.slug}`,
        kind: "Product",
      }));
    return [...merchantResults, ...siteResults, ...productResults].slice(0, 20);
  }, [merchants, products, query, sites]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (user.isPlatformAdmin) {
        const [merchantResponse, siteResponse, productResponse] =
          await Promise.all([
            platformApi.listAllMerchantsAdmin(),
            platformApi.listAllSitesAdmin(),
            platformApi.listAdminProducts(),
          ]);
        setMerchants(merchantResponse.items);
        setSites(siteResponse.items);
        setProducts(productResponse.items);
        return;
      }
      const merchantResponse = await platformApi.listMerchants();
      const siteResponses = await Promise.all(
        merchantResponse.items.map((merchant) =>
          platformApi.listSites(merchant.id),
        ),
      );
      setSites(siteResponses.flatMap((response) => response.items));
    } finally {
      setLoading(false);
    }
  }, [user]);

  const openSearch = useCallback(() => {
    setOpen(true);
    if (merchants.length === 0 && sites.length === 0 && products.length === 0) {
      void load();
    }
  }, [load, merchants.length, products.length, sites.length]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openSearch]);

  const icons = { Merchant: Users, Site: Globe, Product: Boxes };

  return (
    <>
      <button
        type="button"
        onClick={openSearch}
        className="hidden h-9 items-center gap-2 rounded-md border border-line bg-surface-subtle px-3 text-sm text-ink-muted transition-colors hover:border-brand-300 hover:text-ink sm:flex"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        Search
        <kbd className="ml-3 rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-ink-faint">
          ⌘K
        </kbd>
      </button>
      <Modal
        open={open}
        title="Search the platform"
        description="Jump to a merchant, site, or product."
        onClose={() => setOpen(false)}
      >
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, email, domain, or slug..."
          aria-label="Search the platform"
        />
        <div className="mt-4 max-h-96 space-y-1 overflow-y-auto">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-ink-muted">
              Loading searchable records...
            </p>
          ) : null}
          {!loading && results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-muted">
              No matching records.
            </p>
          ) : null}
          {results.map((result) => {
            const Icon = icons[result.kind];
            return (
              <Link
                key={result.key}
                href={result.href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface text-brand-700 shadow-card">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {result.label}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">
                    {result.description}
                  </span>
                </span>
                <span className="text-xs text-ink-faint">{result.kind}</span>
              </Link>
            );
          })}
        </div>
      </Modal>
    </>
  );
}
