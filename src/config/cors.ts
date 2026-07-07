/**
 * Origini consentite, condivise tra CORS HTTP (Fastify) e WebSocket
 * (Socket.io) — un posto solo per evitare che i due divergano.
 */
export const allowedOrigins: (string | RegExp)[] = [
  /^http:\/\/localhost(:\d+)?$/, // sviluppo locale (Expo web su qualsiasi porta)
  /\.railway\.app$/,             // tutti i sottodomini Railway (dev + prod)
  /\.up\.railway\.app$/,
];

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // server-to-server / curl / app native
  return allowedOrigins.some((o) =>
    typeof o === 'string' ? o === origin : o.test(origin)
  );
}
