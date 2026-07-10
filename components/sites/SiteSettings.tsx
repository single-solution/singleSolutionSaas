"use client";

import { FormEvent, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";

import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import type { SiteDomainReadiness, SiteSummary } from "@/lib/types";

export function SiteSettings({
  site,
  open,
  onClose,
  onSaved,
}: {
  site: SiteSummary;
  open: boolean;
  onClose: () => void;
  onSaved: (site: SiteSummary) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(site.name);
  const [primaryDomain, setPrimaryDomain] = useState(site.primaryDomain);
  const [readiness, setReadiness] = useState<SiteDomainReadiness | null>(null);
  const [loadingReadiness, setLoadingReadiness] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const dirty =
    name.trim() !== site.name ||
    primaryDomain.trim().toLowerCase() !== site.primaryDomain.toLowerCase();

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(site.name);
    setPrimaryDomain(site.primaryDomain);
    setFormError(null);
    setLoadingReadiness(true);
    void platformApi
      .getSiteDomainReadiness(site.id)
      .then((response) => setReadiness(response.readiness))
      .catch(() => setReadiness(null))
      .finally(() => setLoadingReadiness(false));
  }, [open, site]);

  function requestClose() {
    if (dirty) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError("Site name is required.");
      return;
    }
    setSaving(true);
    try {
      const response = await platformApi.updateSite(site.id, {
        name: name.trim(),
        primaryDomain: primaryDomain.trim(),
      });
      toast.showSuccess("Site updated");
      onSaved(response.site);
      onClose();
    } catch (caughtError) {
      setFormError(
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Could not save site settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    try {
      const result = await platformApi.verifySiteDomain(site.id);
      setReadiness(result.site);
      if (result.verified) {
        toast.showSuccess("Domain verified", result.message);
        const siteResponse = await platformApi.getSite(site.id);
        onSaved(siteResponse.site);
      } else {
        toast.showError("Verification failed", result.message);
      }
    } catch (caughtError) {
      toast.showError(
        "Verification failed",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again in a moment.",
      );
    } finally {
      setVerifying(false);
    }
  }

  async function handleSyncTokens() {
    setSyncing(true);
    try {
      const result = await platformApi.syncSiteTokenDomains(site.id);
      toast.showSuccess(
        "Token domains synced",
        `Updated ${result.updated} active key${result.updated === 1 ? "" : "s"}.`,
      );
      const readinessResponse = await platformApi.getSiteDomainReadiness(site.id);
      setReadiness(readinessResponse.readiness);
    } catch (caughtError) {
      toast.showError(
        "Sync failed",
        caughtError instanceof PlatformApiError
          ? caughtError.message
          : "Try again in a moment.",
      );
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        title="Site settings"
        description="Update the deployment name and primary domain used for product keys."
        onClose={requestClose}
        dirty={dirty}
      >
        {formError ? (
          <Alert tone="danger" title="Could not save" className="mb-4">
            {formError}
          </Alert>
        ) : null}

        <form className="grid gap-4" onSubmit={handleSave} noValidate>
          <Field label="Site name" htmlFor="site-settings-name" required>
            <Input
              id="site-settings-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label="Primary domain"
            htmlFor="site-settings-domain"
            hint="Hostname only. Example: shop.example.com"
            required
          >
            <Input
              id="site-settings-domain"
              value={primaryDomain}
              onChange={(event) => setPrimaryDomain(event.target.value)}
              placeholder="shop.example.com"
            />
          </Field>

          <div className="rounded-lg border border-line bg-surface-subtle/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-ink">Domain readiness</p>
              {site.domainVerificationStatus === "verified" ? (
                <Badge tone="success">
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Verified
                </Badge>
              ) : (
                <Badge tone="neutral">Unverified</Badge>
              )}
            </div>
            {loadingReadiness ? (
              <p className="mt-2 text-sm text-ink-muted">Checking keys...</p>
            ) : readiness ? (
              <div className="mt-3 space-y-2 text-sm text-ink-secondary">
                <p>
                  {readiness.domainReady
                    ? `${readiness.tokenCount} active key${readiness.tokenCount === 1 ? "" : "s"} on this site.`
                    : "Add a primary domain before assigning products."}
                </p>
                {readiness.hasMismatch ? (
                  <Alert tone="warning" title="Domain mismatch">
                    <p className="text-sm">
                      {readiness.mismatchedTokens.length} key
                      {readiness.mismatchedTokens.length === 1 ? "" : "s"} allow
                      domains that do not match{" "}
                      <strong>{readiness.primaryDomain || "this site"}</strong>.
                    </p>
                  </Alert>
                ) : null}
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={verifying}
                disabled={!primaryDomain.trim()}
                onClick={() => void handleVerify()}
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Verify domain
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={syncing}
                disabled={!primaryDomain.trim()}
                onClick={() => void handleSyncTokens()}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Sync key domains
              </Button>
            </div>
          </div>

          {!primaryDomain.trim() ? (
            <Alert tone="warning" title="Domain required for products">
              <p className="flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                Product assignment stays blocked until a valid primary domain is saved.
              </p>
            </Alert>
          ) : null}

          <Button type="submit" loading={saving} className="min-h-11">
            Save settings
          </Button>
        </form>
      </Modal>

      <ConfirmDialog
        open={showDiscardConfirm}
        title="Discard unsaved changes?"
        description="Your edits to this site will be lost."
        confirmLabel="Discard"
        onCancel={() => setShowDiscardConfirm(false)}
        onConfirm={() => {
          setShowDiscardConfirm(false);
          onClose();
        }}
      />
    </>
  );
}
