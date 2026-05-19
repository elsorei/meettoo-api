/**
 * Normalizzazione numeri di telefono in formato E.164.
 *
 * Usato in tre punti per garantire che i numeri salvati e confrontati siano
 * coerenti: registrazione, aggiornamento profilo e match della rubrica.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Regione di default quando il numero non ha prefisso internazionale. */
const DEFAULT_REGION = 'IT';

/**
 * Converte un numero "grezzo" (qualsiasi formato) in E.164 (es. "+393331234567").
 * Restituisce `null` se il numero non è interpretabile o non è valido.
 */
export function normalizePhone(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_REGION);
  if (!parsed || !parsed.isValid()) return null;

  return parsed.number; // formato E.164
}
