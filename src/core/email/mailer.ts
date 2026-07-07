import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../../config/env';

let transporter: Transporter | null = null;
let smtpConfigured = false;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env();
  if (!SMTP_HOST) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT || 587,
    secure: (SMTP_PORT || 587) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  smtpConfigured = true;
  return transporter;
}

/**
 * Invia un'email. Se SMTP non è configurato (sviluppo) logga il contenuto
 * invece di fallire, così i flussi di verifica/reset restano testabili.
 * Ritorna true se l'email è stata effettivamente inviata via SMTP.
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] SMTP non configurato — email NON inviata\n  To: ${to}\n  Subject: ${subject}\n  Body: ${text}`);
    return false;
  }
  await t.sendMail({ from: env().SMTP_FROM, to, subject, text, html });
  return true;
}

export function isSmtpConfigured(): boolean {
  getTransporter();
  return smtpConfigured;
}

/**
 * Escapa i caratteri HTML pericolosi. Da usare SEMPRE su valori controllati
 * dall'utente (nome profilo, titolo evento, ...) prima di interpolarli nel
 * corpo HTML di un'email: previene HTML/phishing injection nelle email
 * spedite dal dominio legittimo.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
