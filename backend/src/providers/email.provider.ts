import { Resend } from "resend";
import { config } from "../config/app.config";
import { logger } from "../utils/logger";

let resendClient: Resend | null = null;

// Lazy singleton so a missing RESEND_API_KEY doesn't crash the app at
// import time - only sendEmail's caller ever needs to know.
const getResendClient = (): Resend | null => {
  if (!config.RESEND_API_KEY) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(config.RESEND_API_KEY);
  }
  return resendClient;
};

const sendEmail = async (params: {
  to: string;
  subject: string;
  html: string;
  logContext: Record<string, unknown>;
}): Promise<void> => {
  const { to, subject, html, logContext } = params;
  const client = getResendClient();

  if (!client) {
    // Not configured - don't fail the caller over it (whatever token/state
    // the email was meant to communicate is already valid regardless),
    // just make the miss loud in logs so it's never a silent surprise in
    // an environment that should have sent it.
    logger.warn(
      { to, ...logContext },
      "RESEND_API_KEY not set - would have sent an email"
    );
    return;
  }

  const { error } = await client.emails.send({
    from: config.EMAIL_FROM,
    to,
    subject,
    html,
  });

  if (error) {
    logger.error(
      { to, err: error, ...logContext },
      "Resend failed to send email"
    );
  }
};

export const sendPasswordResetEmail = async (
  to: string,
  resetUrl: string
): Promise<void> => {
  await sendEmail({
    to,
    subject: "Reset your password",
    html: `
      <p>We received a request to reset your password.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a></p>
      <p>If you didn't request this, you can safely ignore this email - your password won't change.</p>
      <p>This link will expire soon and can only be used once.</p>
    `,
    logContext: { type: "password-reset", resetUrl },
  });
};

export const sendVerificationEmail = async (
  to: string,
  verifyUrl: string
): Promise<void> => {
  await sendEmail({
    to,
    subject: "Verify your email address",
    html: `
      <p>Please confirm your email address to finish setting up your account.</p>
      <p><a href="${verifyUrl}">Click here to verify your email</a></p>
      <p>If you didn't create this account, you can safely ignore this email.</p>
    `,
    logContext: { type: "email-verification", verifyUrl },
  });
};
