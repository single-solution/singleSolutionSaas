"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/AuthProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { PlatformApiError, platformApi } from "@/lib/api/client";
import { validatePassword } from "@/lib/forms/validation";

export function AccountSettings() {
  const { user, refresh, logout } = useAuth();
  const router = useRouter();
  const toast = useToast();

  const canEditEmail = user?.isPlatformAdmin ?? false;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);

  async function handleSaveName(event: FormEvent) {
    event.preventDefault();
    setNameError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Enter your name.");
      return;
    }
    if (canEditEmail && !email.trim()) {
      setNameError("Enter your email.");
      return;
    }
    setSavingName(true);
    try {
      const result = await platformApi.updateProfile(
        canEditEmail ? { name: trimmed, email: email.trim() } : { name: trimmed },
      );
      if (result.sessionInvalidated) {
        toast.showSuccess("Email updated", result.message ?? "Sign in again on all devices.");
        router.replace("/login");
        router.refresh();
        return;
      }
      await refresh();
      router.refresh();
      toast.showSuccess("Profile updated", "Your details have been changed.");
    } catch (caughtError) {
      const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
      setNameError(message);
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword(event: FormEvent) {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (!currentPassword) {
      errors.currentPassword = "Enter your current password.";
    }
    const newError = validatePassword(newPassword);
    if (newError) {
      errors.newPassword = newError;
    }
    if (confirmPassword !== newPassword) {
      errors.confirmPassword = "Passwords do not match.";
    }
    if (Object.keys(errors).length > 0) {
      setPasswordErrors(errors);
      return;
    }
    setPasswordErrors({});
    setSavingPassword(true);
    try {
      await platformApi.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.showSuccess("Password changed", "Other devices have been signed out.");
    } catch (caughtError) {
      const message = caughtError instanceof PlatformApiError ? caughtError.message : "Try again in a moment.";
      setPasswordErrors({ currentPassword: message });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="shadow-sm border-line bg-surface h-fit">
        <CardHeader title="Profile" description="Your name is shown across the portal." />
        <form className="space-y-4" onSubmit={handleSaveName} noValidate>
          <Field label="Full name" htmlFor="account-name" required error={nameError ?? undefined}>
            <Input id="account-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field
            label="Email"
            htmlFor="account-email"
            required={canEditEmail}
            hint={canEditEmail ? "Used to sign in." : "Contact an administrator to change your email."}
          >
            <Input
              id="account-email"
              type="email"
              autoComplete="off"
              value={canEditEmail ? email : user?.email ?? ""}
              disabled={!canEditEmail}
              readOnly={!canEditEmail}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Button type="submit" loading={savingName}>
            Save changes
          </Button>
        </form>
      </Card>

      <Card className="shadow-sm border-line bg-surface h-fit">
        <CardHeader title="Password" description="Change the password you use to sign in." />
        <form className="space-y-4" onSubmit={handleChangePassword} noValidate>
          <Field label="Current password" htmlFor="current-password" required error={passwordErrors.currentPassword}>
            <PasswordInput
              id="current-password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="New password" htmlFor="new-password" required error={passwordErrors.newPassword}>
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password" required error={passwordErrors.confirmPassword}>
            <PasswordInput
              id="confirm-password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
          <Button type="submit" loading={savingPassword}>
            Update password
          </Button>
        </form>
      </Card>

      <Card className="shadow-sm border-line bg-surface h-fit">
        <CardHeader
          title="Sessions"
          description="Sign out on this browser or invalidate every active portal session."
        />
        <Button
          type="button"
          variant="secondary"
          loading={signingOutEverywhere}
          onClick={async () => {
            setSigningOutEverywhere(true);
            try {
              await logout("all");
              router.replace("/login");
              router.refresh();
            } catch (caughtError) {
              const message =
                caughtError instanceof PlatformApiError
                  ? caughtError.message
                  : "Try again in a moment.";
              toast.showError("Sign out failed", message);
            } finally {
              setSigningOutEverywhere(false);
            }
          }}
        >
          Sign out everywhere
        </Button>
      </Card>
    </div>
  );
}
