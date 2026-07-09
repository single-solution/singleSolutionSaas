"use client";

import { useCallback, useState } from "react";

export function useFormState() {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const focusFirstError = useCallback((errors: Record<string, string>) => {
    const firstFieldId = Object.keys(errors)[0];
    if (!firstFieldId) {
      return;
    }
    requestAnimationFrame(() => {
      document.getElementById(firstFieldId)?.focus();
    });
  }, []);

  const setErrors = useCallback(
    (errors: Record<string, string>) => {
      setFieldErrors(errors);
      focusFirstError(errors);
    },
    [focusFirstError],
  );

  const clearError = useCallback((fieldId: string) => {
    setFieldErrors((current) => {
      if (!current[fieldId]) {
        return current;
      }
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  }, []);

  const resetErrors = useCallback(() => {
    setFieldErrors({});
  }, []);

  const setFieldError = useCallback((fieldId: string, message?: string) => {
    if (!message) {
      clearError(fieldId);
      return;
    }
    setFieldErrors((current) => ({ ...current, [fieldId]: message }));
  }, [clearError]);

  const syncFieldOnChange = useCallback(
    (fieldId: string, value: string, validate: (nextValue: string) => string | undefined) => {
      setFieldErrors((current) => {
        if (!current[fieldId]) {
          return current;
        }
        const message = validate(value);
        if (!message) {
          const next = { ...current };
          delete next[fieldId];
          return next;
        }
        return { ...current, [fieldId]: message };
      });
    },
    [],
  );

  return {
    fieldErrors,
    setErrors,
    setFieldError,
    clearError,
    resetErrors,
    syncFieldOnChange,
  };
}
