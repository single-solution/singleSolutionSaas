import "server-only";

import { sendEmail } from "@/lib/email/mailer";

const APP_NAME = "Single Solution";

interface RecoveryEmailInput {
  to: string;
  recipientName: string;
  recoveryUrl: string;
  expiresInHours: number;
}

export function sendRecoveryEmail(input: RecoveryEmailInput): Promise<boolean> {
  const firstName = input.recipientName.trim().split(/\s+/)[0] || "there";
  const subject = `Reset your ${APP_NAME} password`;
  const text = [
    `Hi ${firstName},`,
    "",
    "A platform administrator sent you a password recovery link.",
    input.recoveryUrl,
    "",
    `This link expires in ${input.expiresInHours} hours.`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:sans-serif;color:#0f172a;"><p>Hi ${firstName},</p><p>A platform administrator sent you a password recovery link.</p><p><a href="${input.recoveryUrl}">Reset your password</a></p><p style="color:#64748b;font-size:12px;">Expires in ${input.expiresInHours} hours.</p></body></html>`;
  return sendEmail({ to: input.to, subject, text, html });
}
