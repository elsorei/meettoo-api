/**
 * Generates a human-readable password.
 * Format: Word + digits + special char (e.g., "Studio2026!", "Conto4587#")
 */
const WORDS = [
  'Studio', 'Conto', 'Fisco', 'Lavoro', 'Paghe', 'Admin',
  'Legge', 'Norma', 'Codex', 'Firma', 'Piano', 'Quota',
  'Fondo', 'Reddito', 'Debito', 'Attivo', 'Bilancio', 'Gestione',
];

const SPECIALS = '!@#$%&*?';

export function generatePassword(): string {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const digits = String(1000 + Math.floor(Math.random() * 9000)); // 4 digits
  const special = SPECIALS[Math.floor(Math.random() * SPECIALS.length)];
  return word + digits + special;
}
