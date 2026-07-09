"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import { useToast } from "@/components/providers/ToastProvider";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type {
  ProductAccessTokenCreated,
  ProductAccessTokenSummary,
  ProductUsageSummary,
  SubscriptionSummary,
} from "@/lib/types";

/**
 * Owns a site's product control plane: subscriptions, per-product usage and
 * tokens, and every mutation (plan, status, token issue/revoke). Shared by the
 * site detail view so there is one source of truth for this data.
 */
export function useSiteProducts(siteId: string, onChanged?: () => void) {
  const toast = useToast();
  const [products, setProducts] = useState<SubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tokensBySlug, setTokensBySlug] = useState<Record<string, ProductAccessTokenSummary[]>>({});
  const [usageBySlug, setUsageBySlug] = useState<Record<string, ProductUsageSummary>>({});
  const [savingPlanSlug, setSavingPlanSlug] = useState<string | null>(null);
  const [tokenNameBySlug, setTokenNameBySlug] = useState<Record<string, string>>({});
  const [tokenDomainsBySlug, setTokenDomainsBySlug] = useState<Record<string, string>>({});
  const [creatingTokenSlug, setCreatingTokenSlug] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<ProductAccessTokenCreated | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ productSlug: string; tokenId: string } | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadDetails = useCallback(
    async (granted: SubscriptionSummary[]) => {
      const results = await Promise.allSettled(
        granted.flatMap((product) => [
          platformApi.getProductUsage(siteId, product.productSlug),
          platformApi.listProductTokens(siteId, product.productSlug),
        ]),
      );

      const nextUsage: Record<string, ProductUsageSummary> = {};
      const nextTokens: Record<string, ProductAccessTokenSummary[]> = {};
      granted.forEach((product, index) => {
        const usageResult = results[index * 2];
        const tokensResult = results[index * 2 + 1];
        if (usageResult.status === "fulfilled") {
          nextUsage[product.productSlug] = (usageResult.value as { usage: ProductUsageSummary }).usage;
        }
        if (tokensResult.status === "fulfilled") {
          nextTokens[product.productSlug] = (tokensResult.value as { items: ProductAccessTokenSummary[] }).items;
        }
      });
      setUsageBySlug(nextUsage);
      setTokensBySlug(nextTokens);
    },
    [siteId],
  );

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await platformApi.listSiteProducts(siteId);
      setProducts(response.items);
      await loadDetails(response.items.filter((product) => product.planCode));
    } catch {
      setError("Could not load products.");
    } finally {
      setLoading(false);
    }
  }, [siteId, loadDetails]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const changePlan = useCallback(
    async (productSlug: string, planCode: string) => {
      setSavingPlanSlug(productSlug);
      try {
        await platformApi.setSiteProductPlan(siteId, productSlug, {
          planCode: planCode === "" ? null : planCode,
        });
        toast.showSuccess("Plan updated");
        onChanged?.();
        await reload();
      } catch (caughtError) {
        const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
        toast.showError("Could not update plan", message);
      } finally {
        setSavingPlanSlug(null);
      }
    },
    [siteId, onChanged, reload, toast],
  );

  const toggleStatus = useCallback(
    async (product: SubscriptionSummary) => {
      const nextStatus = product.status === "active" ? "suspended" : "active";
      setSavingPlanSlug(product.productSlug);
      try {
        await platformApi.setSiteProductPlan(siteId, product.productSlug, { status: nextStatus });
        toast.showSuccess(nextStatus === "active" ? "Product resumed" : "Product suspended");
        onChanged?.();
        await reload();
      } catch {
        toast.showError("Could not update product", "Try again in a moment.");
      } finally {
        setSavingPlanSlug(null);
      }
    },
    [siteId, onChanged, reload, toast],
  );

  const createToken = useCallback(
    async (event: FormEvent, productSlug: string) => {
      event.preventDefault();
      const name = (tokenNameBySlug[productSlug] ?? "").trim();
      if (!name) {
        toast.showError("Name required", "Give the key a recognizable name.");
        return;
      }
      const allowedDomains = (tokenDomainsBySlug[productSlug] ?? "")
        .split(/[\s,]+/)
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0);
      if (allowedDomains.length === 0) {
        toast.showError("Domain required", "Add at least one domain where the widget is allowed to run.");
        return;
      }
      setCreatingTokenSlug(productSlug);
      try {
        const response = await platformApi.createProductToken(siteId, productSlug, name, allowedDomains);
        setCreatedToken(response.token);
        setTokenNameBySlug((current) => ({ ...current, [productSlug]: "" }));
        setTokenDomainsBySlug((current) => ({ ...current, [productSlug]: "" }));
        toast.showSuccess("Key created", "Copy it now. It will not be shown again.");
        onChanged?.();
        const tokens = await platformApi.listProductTokens(siteId, productSlug);
        setTokensBySlug((current) => ({ ...current, [productSlug]: tokens.items }));
      } catch (caughtError) {
        const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
        toast.showError("Could not create key", message);
      } finally {
        setCreatingTokenSlug(null);
      }
    },
    [siteId, onChanged, tokenDomainsBySlug, tokenNameBySlug, toast],
  );

  const confirmRevoke = useCallback(async () => {
    if (!pendingRevoke) {
      return;
    }
    setRevoking(true);
    try {
      await platformApi.revokeProductToken(siteId, pendingRevoke.productSlug, pendingRevoke.tokenId);
      toast.showSuccess("Key revoked");
      onChanged?.();
      const tokens = await platformApi.listProductTokens(siteId, pendingRevoke.productSlug);
      setTokensBySlug((current) => ({ ...current, [pendingRevoke.productSlug]: tokens.items }));
      setPendingRevoke(null);
    } catch {
      toast.showError("Could not revoke key", "Try again in a moment.");
    } finally {
      setRevoking(false);
    }
  }, [siteId, onChanged, pendingRevoke, toast]);

  const copyToken = useCallback(async () => {
    if (!createdToken) {
      return;
    }
    await navigator.clipboard.writeText(createdToken.plaintextToken);
    toast.showInfo("Copied", "Key copied to clipboard.");
  }, [createdToken, toast]);

  const setTokenName = useCallback(
    (productSlug: string, value: string) => setTokenNameBySlug((current) => ({ ...current, [productSlug]: value })),
    [],
  );
  const setTokenDomains = useCallback(
    (productSlug: string, value: string) => setTokenDomainsBySlug((current) => ({ ...current, [productSlug]: value })),
    [],
  );

  return {
    products,
    usageBySlug,
    tokensBySlug,
    loading,
    error,
    reload,
    savingPlanSlug,
    creatingTokenSlug,
    createdToken,
    tokenNameBySlug,
    tokenDomainsBySlug,
    pendingRevoke,
    revoking,
    changePlan,
    toggleStatus,
    createToken,
    confirmRevoke,
    copyToken,
    setTokenName,
    setTokenDomains,
    setCreatedToken,
    requestRevoke: (productSlug: string, tokenId: string) => setPendingRevoke({ productSlug, tokenId }),
    cancelRevoke: () => setPendingRevoke(null),
  };
}
