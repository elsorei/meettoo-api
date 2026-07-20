import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { escapeHtml } from '../../core/email/mailer';
import { getLandingEvent, LandingEvent } from './landing.service';

/**
 * Funnel invito → installazione.
 *
 * - GET /e/:id            pagina web dell'evento (anteprima + CTA store +
 *                         "apri nell'app"); è la landing dei link d'invito.
 * - /.well-known/apple-app-site-association  → Universal Links iOS
 * - /.well-known/assetlinks.json             → App Links Android
 *
 * Con universal/app links configurati, un link https://<dominio>/e/<id> apre
 * direttamente l'app se installata; altrimenti mostra questa pagina, che porta
 * allo store giusto. Il deep link nativo resta `meettoo://e/<id>`.
 */
export async function landingRoutes(app: FastifyInstance): Promise<void> {
  // ── iOS Universal Links ──
  // Servito SENZA estensione, content-type application/json. `appID` deve
  // essere <TeamID>.<bundleId>. `paths` limita i link gestiti a /e/*.
  app.get('/.well-known/apple-app-site-association', async (_req, reply) => {
    return reply.type('application/json').send({
      applinks: {
        apps: [],
        details: [{ appID: env().IOS_APP_ID, paths: ['/e/*'] }],
      },
    });
  });

  // ── Android App Links ──
  app.get('/.well-known/assetlinks.json', async (_req, reply) => {
    return reply.type('application/json').send([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: env().ANDROID_PACKAGE,
          sha256_cert_fingerprints: [env().ANDROID_SHA256],
        },
      },
    ]);
  });

  // ── Pagina web dell'evento ──
  app.get('/e/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ev = await getLandingEvent(id);
    return reply.type('text/html; charset=utf-8').send(renderPage(id, ev));
  });

  // ── Privacy policy (URL richiesto dagli store) ──
  app.get('/privacy', async (_req, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderPrivacy());
  });
}

function renderPrivacy(): string {
  const company = escapeHtml(env().COMPANY_NAME);
  const email = escapeHtml(env().PRIVACY_CONTACT_EMAIL);
  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Informativa sulla Privacy — MeetToo</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 720px; margin: 0 auto; padding: 32px 20px; color: #11131A; line-height: 1.6; }
  h1 { font-size: 28px; } h2 { font-size: 19px; margin-top: 28px; color: #5A4AF4; }
  a { color: #5A4AF4; } .muted { color: #5A6072; font-size: 14px; }
  code { background: #F4F5FB; padding: 2px 6px; border-radius: 4px; }
</style></head><body>
<h1>Informativa sulla Privacy — MeetToo</h1>
<p class="muted">MeetToo, sviluppata da ${company}, è un'agenda sociale per creare eventi e invitare persone.</p>

<h2>Dati che raccogliamo</h2>
<ul>
  <li><strong>Account</strong>: email, nome e, se lo fornisci, numero di telefono.</li>
  <li><strong>Contenuti</strong>: eventi (titolo, data, ora, luogo, descrizione) e lista invitati.</li>
  <li><strong>Inviti</strong>: l'email di chi inviti, per recapitare l'invito. Se la persona non ha un
      account, l'email resta in attesa che si registri o che l'evento sia eliminato.</li>
  <li><strong>Dati tecnici</strong>: token di sessione e, se abiliti le notifiche, un identificativo
      del dispositivo per le notifiche push.</li>
</ul>
<p>Non raccogliamo geolocalizzazione precisa in background e non vendiamo i tuoi dati a terzi.</p>

<h2>Perché li usiamo</h2>
<ul>
  <li>Erogare il servizio (autenticazione, eventi, inviti, RSVP).</li>
  <li>Email di servizio: verifica indirizzo, reset password, notifiche su eventi e inviti.</li>
  <li>Sicurezza e prevenzione degli abusi.</li>
</ul>

<h2>Conservazione e cancellazione</h2>
<p>Puoi cancellare l'account in qualsiasi momento da <em>Profilo → Cancella account</em>. Alla
cancellazione rimuoviamo o anonimizziamo i dati personali (email, nome, telefono, foto), rimuoviamo
partecipazioni e inviti e revochiamo tutte le sessioni.</p>

<h2>Condivisione con terze parti</h2>
<p>Usiamo fornitori di infrastruttura (hosting, database, invio email, notifiche push) che trattano i
dati solo per nostro conto.</p>

<h2>I tuoi diritti (GDPR)</h2>
<p>Hai diritto di accesso, rettifica, cancellazione, limitazione e portabilità. Per esercitarli scrivi a
<a href="mailto:${email}">${email}</a>.</p>

<h2>Minori</h2>
<p>MeetToo non è destinata a minori di 16 anni.</p>

<h2>Contatti</h2>
<p>Titolare del trattamento: <strong>${company}</strong>. Richieste privacy:
<a href="mailto:${email}">${email}</a>.</p>
</body></html>`;
}

function formatWhen(ev: LandingEvent): string {
  try {
    // event_date = 'YYYY-MM-DD'; costruiamo la data a mezzogiorno per evitare
    // slittamenti di fuso. start_time da Postgres è 'HH:MM:SS' → prendo HH:MM.
    const d = new Date(`${ev.event_date}T12:00:00`);
    if (Number.isNaN(d.getTime())) return ev.event_date;
    const day = d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    const time = ev.start_time ? ` · ${ev.start_time.slice(0, 5)}` : '';
    return day + time;
  } catch {
    return ev.event_date;
  }
}

function renderPage(id: string, ev: LandingEvent | null): string {
  const scheme = env().APP_SCHEME;
  const deepLink = `${scheme}://e/${encodeURIComponent(id)}`;
  const appStore = env().APP_STORE_URL;
  const playStore = env().PLAY_STORE_URL;

  const title = ev ? escapeHtml(ev.title) : 'Sei invitato su MeetToo';
  const when = ev ? escapeHtml(formatWhen(ev)) : '';
  const where = ev?.location_name ? escapeHtml(ev.location_name) : '';
  const host = ev ? escapeHtml(ev.host_name) : '';
  const count = ev && ev.guest_count > 0 ? `${ev.guest_count} invitati` : '';

  const notFound = !ev
    ? `<p class="muted">Questo invito non è più disponibile. Scarica MeetToo per creare e ricevere inviti.</p>`
    : '';

  const details = ev
    ? `
      <h1>${title}</h1>
      <p class="meta">${when}</p>
      ${where ? `<p class="meta">📍 ${where}</p>` : ''}
      ${host ? `<p class="meta">Organizzato da ${host}</p>` : ''}
      ${count ? `<p class="meta">${count}</p>` : ''}
      <p class="lead">Rispondi all'invito su MeetToo.</p>`
    : `<h1>MeetToo</h1>${notFound}`;

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — MeetToo</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${when}${where ? ' · ' + where : ''} — su MeetToo">
<meta name="apple-itunes-app" content="app-argument=${deepLink}">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(160deg, #0B1020 0%, #161235 55%, #241A4D 100%);
    color: #fff; padding: 24px;
  }
  .card {
    width: 100%; max-width: 440px; text-align: center;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px; padding: 40px 28px;
    backdrop-filter: blur(8px);
  }
  .logo { display: inline-flex; gap: 6px; align-items: center; margin-bottom: 20px; }
  .logo .ring { width: 22px; height: 22px; border-radius: 50%; border: 3px solid; }
  .logo .r1 { border-color: #B7AEFF; margin-right: -10px; }
  .logo .r2 { border-color: #fff; }
  .brand { font-weight: 700; letter-spacing: 0.5px; color: #B7AEFF; }
  h1 { font-size: 26px; margin: 8px 0 16px; line-height: 1.2; }
  .meta { color: rgba(255,255,255,0.72); font-size: 15px; margin: 4px 0; }
  .lead { color: rgba(255,255,255,0.9); font-size: 16px; margin: 20px 0 8px; }
  .muted { color: rgba(255,255,255,0.6); font-size: 15px; line-height: 1.5; }
  .btn {
    display: block; width: 100%; padding: 15px; margin-top: 12px; border-radius: 14px;
    font-size: 16px; font-weight: 600; text-decoration: none; border: 0; cursor: pointer;
  }
  .btn-primary { background: #5A4AF4; color: #fff; }
  .btn-store { background: #fff; color: #11131A; }
  .stores { margin-top: 20px; }
  .hint { color: rgba(255,255,255,0.45); font-size: 12px; margin-top: 18px; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo"><span class="ring r1"></span><span class="ring r2"></span><span class="brand">meettoo</span></div>
    ${details}
    <div class="stores">
      <a class="btn btn-primary" href="${deepLink}" id="openApp">Apri nell'app</a>
      <a class="btn btn-store" href="${appStore}">Scarica su App Store</a>
      <a class="btn btn-store" href="${playStore}">Scarica su Google Play</a>
    </div>
    <p class="hint">Se hai già MeetToo, "Apri nell'app" ti porta dritto all'invito.</p>
  </div>
  <script>
    // Tentativo di apertura automatica dell'app se installata; se non si apre
    // (l'utente resta sulla pagina) restano visibili i pulsanti store.
    (function () {
      var dl = ${JSON.stringify(deepLink)};
      var t = setTimeout(function () {}, 1200);
      window.addEventListener('pagehide', function () { clearTimeout(t); });
      // Non forziamo il redirect: lasciamo il tap esplicito su "Apri nell'app"
      // per evitare falsi negativi su iOS. Il pulsante fa già il deep link.
    })();
  </script>
</body>
</html>`;
}
