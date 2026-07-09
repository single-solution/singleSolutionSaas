"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

import { useToast } from "@/components/providers/ToastProvider";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Spinner } from "@/components/ui/Spinner";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import { validatePassword } from "@/lib/forms/validation";
import type { InvitationInfo } from "@/lib/types";

type LookupState = "loading" | "valid" | "invalid";

export function AcceptInviteForm({ token }: { token: string }) {
  const toast = useToast();
  const [lookup, setLookup] = useState<LookupState>(token ? "loading" : "invalid");
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!token) {
      return;
    }
    let active = true;
    platformApi
      .getInvitation(token)
      .then((response) => {
        if (!active) {
          return;
        }
        setInvitation(response.invitation);
        setLookup("valid");
      })
      .catch(() => {
        if (active) {
          setLookup("invalid");
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  function validateFields() {
    const errors: Record<string, string> = {};
    const passwordError = validatePassword(password);
    if (passwordError) {
      errors.password = passwordError;
    }
    if (confirm !== password) {
      errors.confirm = "Passwords do not match.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    const errors = validateFields();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await platformApi.acceptInvitation(token, password);
      toast.showSuccess("Account ready", "Redirecting to your portal.");
      window.location.assign("/");
    } catch (caughtError) {
      const message =
        caughtError instanceof PlatformApiError ? caughtError.message : "Could not set your password. Try again.";
      setFieldErrors({ password: message });
      setSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-[60vh] items-center bg-surface px-6 py-10 sm:px-10 md:min-h-screen md:px-16">
      <div className="w-full max-w-sm animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
        {lookup === "loading" ? (
          <div className="flex items-center gap-3 text-sm text-ink-muted">
            <Spinner /> Checking your invitation...
          </div>
        ) : lookup === "invalid" ? (
          <Alert tone="danger" title="Invitation not valid">
            This invitation link is invalid or has expired. Ask your administrator to send a new one.
            <div className="mt-3">
              <Link href="/login" className="text-sm font-medium text-brand-600 hover:underline">
                Go to sign in
              </Link>
            </div>
          </Alert>
        ) : (
          <>
            <div className="mb-8">
              <h2 className="text-xl font-semibold text-ink">Set up your account</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {invitation?.merchantName
                  ? `Create a password for ${invitation.email} to manage ${invitation.merchantName}.`
                  : `Create a password for ${invitation?.email}.`}
              </p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit} noValidate>
              <Field label="New password" htmlFor="password" required error={submitted ? fieldErrors.password : undefined}>
                <PasswordInput
                  name="password"
                  autoComplete="new-password"
                  autoFocus
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>

              <Field label="Confirm password" htmlFor="confirm" required error={submitted ? fieldErrors.confirm : undefined}>
                <PasswordInput
                  name="confirm"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              </Field>

              <Button type="submit" className="w-full" size="lg" loading={submitting}>
                Set password and continue
              </Button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}
