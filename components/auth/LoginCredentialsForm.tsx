"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/AuthProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { useFormState } from "@/lib/forms/useFormState";
import { validateEmail, validatePassword } from "@/lib/forms/validation";
import { PlatformApiError } from "@/lib/api/client";

export function LoginCredentialsForm({ demoUrl }: { demoUrl?: string | null }) {
  const router = useRouter();
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { fieldErrors, setErrors, syncFieldOnChange } = useFormState();

  function validateCredentialFields() {
    const errors: Record<string, string> = {};
    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);
    if (emailError) {
      errors.email = emailError;
    }
    if (passwordError) {
      errors.password =
        passwordError === "Enter your password."
          ? passwordError
          : "Invalid email or password.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    const errors = validateCredentialFields();
    if (Object.keys(errors).length > 0) {
      setErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      await login(email, password);
      toast.showSuccess("Signed in", "Redirecting to your portal.");
      router.replace("/");
      router.refresh();
    } catch (caughtError) {
      if (
        caughtError instanceof PlatformApiError &&
        caughtError.status === 429
      ) {
        setErrors({
          password:
            "Too many sign-in attempts. Wait a few minutes and try again.",
        });
        return;
      }
      setErrors({ password: "Invalid email or password." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-[60vh] items-center bg-surface px-6 py-10 sm:px-10 md:min-h-screen md:px-16">
      <div
        className="w-full max-w-sm animate-fade-in-up"
        style={{ animationDelay: "0.1s" }}
      >
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-ink">Sign in</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Use the account your administrator created for you.
          </p>
        </div>

        <form className="space-y-5" onSubmit={handleSubmit} noValidate>
          <Field
            label="Email"
            htmlFor="email"
            required
            error={submitted ? fieldErrors.email : undefined}
          >
            <Input
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => {
                const nextEmail = event.target.value;
                setEmail(nextEmail);
                if (submitted) {
                  syncFieldOnChange("email", nextEmail, validateEmail);
                }
              }}
            />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            required
            error={submitted ? fieldErrors.password : undefined}
          >
            <PasswordInput
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                const nextPassword = event.target.value;
                setPassword(nextPassword);
                if (submitted && fieldErrors.password) {
                  syncFieldOnChange("password", nextPassword, (value) =>
                    validatePassword(value)
                      ? "Invalid email or password."
                      : undefined,
                  );
                }
              }}
            />
          </Field>

          <Button
            type="submit"
            className="w-full"
            size="lg"
            loading={submitting}
          >
            Sign in
          </Button>
        </form>

        {demoUrl ? (
          <p className="mt-6 text-center text-sm text-ink-muted">
            Just exploring?{" "}
            <a
              href={demoUrl}
              className="font-semibold text-brand-700 underline-offset-2 hover:underline"
            >
              Try live demo
            </a>{" "}
            without signing in.
          </p>
        ) : null}
      </div>
    </section>
  );
}
