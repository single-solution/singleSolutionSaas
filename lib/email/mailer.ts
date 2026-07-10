import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

import { loadEnvironment } from "@/lib/env";
import { maskEmail } from "@/lib/logging/redact";
import { logger } from "@/lib/logging/logger";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  const env = loadEnvironment();
  if (!env.SMTP_HOST || !env.SMTP_PORT) {
    return null;
  }
  if (cachedTransporter) {
    return cachedTransporter;
  }
  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : env.SMTP_PORT === 465,
    auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return cachedTransporter;
}

export function isEmailConfigured(): boolean {
  const env = loadEnvironment();
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.EMAIL_FROM);
}

/**
 * Best-effort transactional send. Returns whether the message was accepted by the
 * provider; never throws so callers can degrade gracefully (e.g. surface a copyable link).
 */
export async function sendEmail(message: OutboundEmail): Promise<boolean> {
  const env = loadEnvironment();
  const transporter = getTransporter();
  if (!transporter || !env.EMAIL_FROM) {
    return false;
  }
  try {
    await transporter.sendMail({
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return true;
  } catch (error) {
    logger.error("Email send failed", {
      to: maskEmail(message.to),
      error: error instanceof Error ? error.message : "unknown",
    });
    return false;
  }
}
