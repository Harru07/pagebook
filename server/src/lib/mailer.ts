import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function sendVerificationEmail(email: string, name: string, token: string) {
  const url = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;

  // Dev mode: no SMTP credentials, so print the link instead of emailing it.
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[dev] Verification link for ${email}: ${url}`);
    return;
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: "Verify your email - Leaf&Ink",
    html: `<h2>Welcome to Leaf&amp;Ink, ${escapeHtml(name)}!</h2>
           <p>Click below to verify your email and activate your account:</p>
           <p><a href="${url}">Verify email</a></p>`,
  });
}
