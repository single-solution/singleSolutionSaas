import "server-only";

import { sendEmail } from "@/lib/email/mailer";

const APP_NAME = "Single Solution";

interface InviteEmailInput {
  to: string;
  recipientName: string;
  merchantName: string;
  inviteUrl: string;
  expiresInDays: number;
}

export function sendInviteEmail(input: InviteEmailInput): Promise<boolean> {
  const firstName = input.recipientName.trim().split(/\s+/)[0] || "there";
  const subject = `You're invited to ${APP_NAME}`;
  const text = buildText(firstName, input);
  const html = buildHtml(firstName, input);
  return sendEmail({ to: input.to, subject, text, html });
}

function buildText(firstName: string, input: InviteEmailInput): string {
  return [
    `Hi ${firstName},`,
    "",
    `You've been invited to manage ${input.merchantName} on ${APP_NAME}.`,
    "Set your password to activate your account:",
    "",
    input.inviteUrl,
    "",
    `This link is single-use and expires in ${input.expiresInDays} days.`,
    "If you weren't expecting this invitation, you can ignore this email.",
  ].join("\n");
}

function buildHtml(firstName: string, input: InviteEmailInput): string {
  const merchant = escapeHtml(input.merchantName);
  const name = escapeHtml(firstName);
  const url = escapeHtml(input.inviteUrl);
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f1f5f9;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:600;">${APP_NAME}</td>
      </tr>
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 12px;font-size:14px;">Hi ${name},</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">You've been invited to manage <strong>${merchant}</strong> on ${APP_NAME}. Set your password to activate your account.</p>
          <p style="margin:0 0 20px;">
            <a href="${url}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px;">Set your password</a>
          </p>
          <p style="margin:0 0 8px;font-size:12px;color:#64748b;">Or paste this link into your browser:</p>
          <p style="margin:0 0 16px;font-size:12px;word-break:break-all;"><a href="${url}" style="color:#2563eb;">${url}</a></p>
          <p style="margin:0;font-size:12px;color:#64748b;">This link is single-use and expires in ${input.expiresInDays} days. If you weren't expecting this invitation, you can ignore this email.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">${APP_NAME} - You received this because an administrator invited you to the platform.</td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
