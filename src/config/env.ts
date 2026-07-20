import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('30d'),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('MeetToo <noreply@example.com>'),

  APP_URL: z.string().default('http://localhost:3000'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),

  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_FILE_SIZE: z.coerce.number().default(52428800), // 50MB

  // Numero di proxy fidati davanti all'app (LB/ingress). Determina quale hop
  // di X-Forwarded-For diventa request.ip: se troppo alto, il client può
  // spoofare l'header e aggirare il rate limiting. Railway/molti PaaS = 1.
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),

  // ── Funnel invito → installazione (pagina web + universal/app links) ──
  // Link agli store (mostrati nella pagina web dell'evento a chi non ha l'app).
  APP_STORE_URL: z.string().default('https://apps.apple.com/app/idXXXXXXXXXX'),
  PLAY_STORE_URL: z.string().default('https://play.google.com/store/apps/details?id=it.studiorei.meettoo'),
  // Scheme deep-link dell'app (deve combaciare con app.json → expo.scheme).
  APP_SCHEME: z.string().default('meettoo'),
  // iOS Universal Links: "<TEAM_ID>.<bundleIdentifier>" (es. ABCDE12345.it.studiorei.meettoo).
  IOS_APP_ID: z.string().default('TEAMID.it.studiorei.meettoo'),
  // Android App Links: package + SHA-256 del certificato di firma (da `eas credentials`).
  ANDROID_PACKAGE: z.string().default('it.studiorei.meettoo'),
  ANDROID_SHA256: z.string().default('AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'),

  // Pagine legali (privacy/termini) servite dall'API su /privacy e /terms —
  // usate come URL nelle schede store.
  COMPANY_NAME: z.string().default('Studio REI'),
  PRIVACY_CONTACT_EMAIL: z.string().default('privacy@studiorei.it'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env;

export function loadEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  _env = result.data;
  return _env;
}

export function env(): Env {
  if (!_env) return loadEnv();
  return _env;
}
