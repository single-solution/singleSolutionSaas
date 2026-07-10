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
  const [tokenExpiresBySlug, setTokenExpiresBySlug] = useState<Record<string, string>>({});
  const [creatingTokenSlug, setCreatingTokenSlug] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<ProductAccessTokenCreated | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ productSlug: string; tokenId: string } | null>(null);
  const [pendingRotate, setPendingRotate] = useState<{ productSlug: string; tokenId: string } | null>(null);
  const [pendingUnassignSlug, setPendingUnassignSlug] = useState<string | null>(null);
  const [pendingRestoreSlug, setPendingRestoreSlug] = useState<string | null>(null);
  const [pendingStatusProduct, setPendingStatusProduct] = useState<SubscriptionSummary | null>(null);
  const [revokePreviousOnRotate, setRevokePreviousOnRotate] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [rotating, setRotating] = useState(false);

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
      await loadDetails(
        response.items.filter(
          (product) =>
            product.status === "active" ||
            product.status === "suspended" ||
            product.status === "archived",
        ),
      );
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
      if (planCode === "") {
        setPendingUnassignSlug(productSlug);
        return;
      }
      setSavingPlanSlug(productSlug);
      try {
        await platformApi.setSiteProductPlan(siteId, productSlug, {
          planCode,
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

  const confirmUnassign = useCallback(async () => {
    if (!pendingUnassignSlug) {
      return;
    }
    setSavingPlanSlug(pendingUnassignSlug);
    try {
      await platformApi.setSiteProductPlan(siteId, pendingUnassignSlug, {
        action: "unassign",
      });
      toast.showSuccess("Product unassigned");
      onChanged?.();
      await reload();
      setPendingUnassignSlug(null);
    } catch (caughtError) {
      const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
      toast.showError("Could not unassign product", message);
    } finally {
      setSavingPlanSlug(null);
    }
  }, [siteId, onChanged, pendingUnassignSlug, reload, toast]);

  const restoreProduct = useCallback((productSlug: string) => {
    setPendingRestoreSlug(productSlug);
  }, []);

  const confirmRestore = useCallback(async () => {
    if (!pendingRestoreSlug) {
      return;
    }
    setSavingPlanSlug(pendingRestoreSlug);
    try {
      await platformApi.setSiteProductPlan(siteId, pendingRestoreSlug, {
        action: "restore",
      });
      toast.showSuccess("Product restored");
      onChanged?.();
      await reload();
      setPendingRestoreSlug(null);
    } catch (caughtError) {
      const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
      toast.showError("Could not restore product", message);
    } finally {
      setSavingPlanSlug(null);
    }
  }, [siteId, onChanged, pendingRestoreSlug, reload, toast]);

  const toggleStatus = useCallback(
    async (product: SubscriptionSummary) => {
      if (product.status !== "active" && product.status !== "suspended") {
        return;
      }
      setPendingStatusProduct(product);
    },
    [],
  );

  const confirmStatusToggle = useCallback(async () => {
    const product = pendingStatusProduct;
    if (!product) {
      return;
    }
    const nextStatus = product.status === "active" ? "suspended" : "active";
    setSavingPlanSlug(product.productSlug);
    try {
      await platformApi.setSiteProductPlan(siteId, product.productSlug, { status: nextStatus });
      toast.showSuccess(nextStatus === "active" ? "Product resumed" : "Product suspended");
      onChanged?.();
      await reload();
      setPendingStatusProduct(null);
    } catch {
      toast.showError("Could not update product", "Try again in a moment.");
    } finally {
      setSavingPlanSlug(null);
    }
  }, [siteId, onChanged, pendingStatusProduct, reload, toast]);

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
        const expiresRaw = (tokenExpiresBySlug[productSlug] ?? "").trim();
        const expiresInDays = expiresRaw ? Number(expiresRaw) : undefined;
        const response = await platformApi.createProductToken(
          siteId,
          productSlug,
          name,
          allowedDomains,
          expiresInDays && expiresInDays > 0 ? expiresInDays : undefined,
        );
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
    [siteId, onChanged, tokenDomainsBySlug, tokenExpiresBySlug, tokenNameBySlug, toast],
  );

  const confirmRotate = useCallback(async () => {
    if (!pendingRotate) {
      return;
    }
    setRotating(true);
    try {
      const response = await platformApi.rotateProductToken(
        siteId,
        pendingRotate.productSlug,
        pendingRotate.tokenId,
        { revokePrevious: revokePreviousOnRotate },
      );
      setCreatedToken(response.rotation.newToken);
      toast.showSuccess(
        "Replacement key issued",
        revokePreviousOnRotate
          ? "Copy the new key now. The previous key was revoked."
          : "Copy the new key now. Revoke the previous key when ready.",
      );
      onChanged?.();
      const tokens = await platformApi.listProductTokens(siteId, pendingRotate.productSlug);
      setTokensBySlug((current) => ({ ...current, [pendingRotate.productSlug]: tokens.items }));
      setPendingRotate(null);
      setRevokePreviousOnRotate(true);
    } catch (caughtError) {
      const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
      toast.showError("Could not rotate key", message);
    } finally {
      setRotating(false);
    }
  }, [siteId, onChanged, pendingRotate, revokePreviousOnRotate, toast]);

  const saveOverrides = useCallback(
    async (
      productSlug: string,
      input: {
        scopeOverrides?: string[] | null;
        quotaOverrides?: Array<{ metric: string; limit: number }> | null;
      },
    ) => {
      setSavingPlanSlug(productSlug);
      try {
        await platformApi.setSiteProductPlan(siteId, productSlug, input);
        toast.showSuccess("Overrides saved");
        onChanged?.();
        await reload();
      } catch (caughtError) {
        const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
        toast.showError("Could not save overrides", message);
      } finally {
        setSavingPlanSlug(null);
      }
    },
    [siteId, onChanged, reload, toast],
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
  const setTokenExpires = useCallback(
    (productSlug: string, value: string) => setTokenExpiresBySlug((current) => ({ ...current, [productSlug]: value })),
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
    tokenExpiresBySlug,
    pendingRevoke,
    pendingRotate,
    pendingUnassignSlug,
    pendingRestoreSlug,
    pendingStatusProduct,
    revokePreviousOnRotate,
    revoking,
    rotating,
    changePlan,
    restoreProduct,
    confirmRestore,
    toggleStatus,
    createToken,
    confirmRevoke,
    confirmRotate,
    confirmUnassign,
    confirmStatusToggle,
    copyToken,
    setTokenName,
    setTokenDomains,
    setTokenExpires,
    saveOverrides,
    setCreatedToken,
    requestRevoke: (productSlug: string, tokenId: string) => setPendingRevoke({ productSlug, tokenId }),
    requestRotate: (productSlug: string, tokenId: string) => setPendingRotate({ productSlug, tokenId }),
    cancelRevoke: () => setPendingRevoke(null),
    cancelRotate: () => setPendingRotate(null),
    cancelUnassign: () => setPendingUnassignSlug(null),
    cancelRestore: () => setPendingRestoreSlug(null),
    cancelStatusToggle: () => setPendingStatusProduct(null),
    setRevokePreviousOnRotate,
  };
}
