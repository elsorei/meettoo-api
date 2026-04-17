# MeetToo API

Backend per **MeetToo** — agenda evoluta multi-utente con sync rubrica e gestione partecipanti.

## Stack
- **Runtime**: Node.js + TypeScript
- **Framework**: Fastify
- **Database**: PostgreSQL
- **Auth**: JWT + OAuth (Google, Apple)

## Moduli estratti da studiorei-agenda
- `agenda` — eventi, ricorrenze, disponibilità, Google Calendar sync
- `auth` — login, JWT, preferenze utente
- `operators` → da rinominare `users` e adattare al modello consumer

## Setup
```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

## TODO (nuova chat)
- [ ] Rinominare `operators` → `users` (modello consumer)
- [ ] Aggiungere `user_contacts` (sync rubrica)
- [ ] Registrazione pubblica (email + Google + Apple)
- [ ] Push notifications (Expo)
- [ ] Multi-device support
- [ ] Monetizzazione / AdMob
