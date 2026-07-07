import { query, queryOne, queryMany } from '../../shared/db';
import { Role, hasMinimumRole, isStaff } from '../../core/auth/roles';
import { ForbiddenError, NotFoundError } from '../../core/errors';

export type ShareResource = 'agenda' | 'todo';
export type ShareLevel    = 'ghost' | 'white' | 'write';

/**
 * Determina il livello di accesso effettivo che `granteeUserId` (con `granteeRole`)
 * ha sulle risorse di tipo `resource` di proprietà di `grantorUserId`.
 *
 * Regole:
 *   - Lo stesso utente sui propri dati → 'write' (proprietario)
 *   - admin/owner sugli operator → SEMPRE 'white' (vedono tutto, no edit by default)
 *   - operator → 'ghost' di default; override possibile via share_permissions
 *
 * 'write' tra pari operator esiste SOLO se concesso esplicitamente.
 */
export async function getEffectiveLevel(
  grantorUserId: string,
  granteeUserId: string,
  granteeRole: Role,
  resource: ShareResource,
): Promise<ShareLevel> {
  if (grantorUserId === granteeUserId) return 'write';
  if (hasMinimumRole(granteeRole, 'admin')) return 'white';

  const row = await queryOne<{ level: ShareLevel }>(
    `SELECT level FROM share_permissions
     WHERE grantor_user_id = $1 AND grantee_user_id = $2 AND resource_type = $3`,
    [grantorUserId, granteeUserId, resource]
  );
  return row?.level ?? 'ghost';
}

/**
 * Versione batch: per un grantee che vuole vedere più calendari/todo, calcola
 * il livello effettivo per ogni grantor in un solo round-trip.
 */
export async function getEffectiveLevelsForGrantors(
  grantorUserIds: string[],
  granteeUserId: string,
  granteeRole: Role,
  resource: ShareResource,
): Promise<Map<string, ShareLevel>> {
  const out = new Map<string, ShareLevel>();
  if (grantorUserIds.length === 0) return out;
  for (const id of grantorUserIds) {
    if (id === granteeUserId) { out.set(id, 'write'); continue; }
    if (hasMinimumRole(granteeRole, 'admin')) { out.set(id, 'white'); continue; }
    out.set(id, 'ghost'); // default, sovrascritto dalla query
  }
  if (hasMinimumRole(granteeRole, 'admin')) return out;
  // Per operator, solleva i ghost a quanto risulta in tabella
  const rows = await queryMany<{ grantor_user_id: string; level: ShareLevel }>(
    `SELECT grantor_user_id, level FROM share_permissions
     WHERE resource_type = $1 AND grantee_user_id = $2 AND grantor_user_id = ANY($3)`,
    [resource, granteeUserId, grantorUserIds]
  );
  for (const r of rows) out.set(r.grantor_user_id, r.level);
  return out;
}

/**
 * Verifica che il richiedente possa vedere il free/busy (disponibilità,
 * busy slots, calendario in modalità ghost) degli utenti indicati.
 *
 * Regole consumer:
 *   - se stesso → sempre ok
 *   - staff (operator/admin/owner) → ok su tutti (comportamento gestionale)
 *   - 'user'/'client' → serve un permesso esplicito in share_permissions
 *     (qualsiasi livello: anche 'ghost' abilita il free/busy) concesso da
 *     CIASCUNO degli utenti richiesti. Altrimenti 403.
 */
export async function assertCanViewFreeBusy(
  targetUserIds: string[],
  requesterId: string,
  requesterRole: Role,
): Promise<void> {
  const others = [...new Set(targetUserIds)].filter((id) => id && id !== requesterId);
  if (others.length === 0) return;
  if (isStaff(requesterRole)) return;

  const rows = await queryMany<{ grantor_user_id: string }>(
    `SELECT grantor_user_id FROM share_permissions
     WHERE resource_type = 'agenda' AND grantee_user_id = $1 AND grantor_user_id = ANY($2)`,
    [requesterId, others]
  );
  const granted = new Set(rows.map((r) => r.grantor_user_id));
  if (others.some((id) => !granted.has(id))) {
    throw new ForbiddenError('Non hai il permesso di vedere la disponibilità di questi utenti');
  }
}

// ── CRUD permessi ─────────────────────────────────────────────────

/** Tutti i permessi che `userId` ha concesso. */
export async function listGrantedByUser(userId: string): Promise<any[]> {
  return queryMany(
    `SELECT sp.id, sp.resource_type, sp.level, sp.created_at,
            sp.grantee_user_id,
            COALESCE(o.first_name || ' ' || o.last_name, u.username) as grantee_name,
            u.username as grantee_username
     FROM share_permissions sp
     JOIN users u ON u.id = sp.grantee_user_id
     LEFT JOIN operators o ON o.user_id = sp.grantee_user_id
     WHERE sp.grantor_user_id = $1
     ORDER BY sp.resource_type, grantee_name`,
    [userId]
  );
}

/** Tutti i permessi che `userId` ha ricevuto. */
export async function listReceivedByUser(userId: string): Promise<any[]> {
  return queryMany(
    `SELECT sp.id, sp.resource_type, sp.level, sp.created_at,
            sp.grantor_user_id,
            COALESCE(o.first_name || ' ' || o.last_name, u.username) as grantor_name,
            u.username as grantor_username
     FROM share_permissions sp
     JOIN users u ON u.id = sp.grantor_user_id
     LEFT JOIN operators o ON o.user_id = sp.grantor_user_id
     WHERE sp.grantee_user_id = $1
     ORDER BY sp.resource_type, grantor_name`,
    [userId]
  );
}

/** Concede o aggiorna un permesso. Solo il `grantor` può creare/modificare. */
export async function grantPermission(
  grantorUserId: string,
  granteeUserId: string,
  resource: ShareResource,
  level: ShareLevel,
): Promise<any> {
  if (grantorUserId === granteeUserId) {
    throw new ForbiddenError('Non puoi concedere accesso a te stesso');
  }
  // Verifica esistenza grantee
  const grantee = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND is_active = true`, [granteeUserId]
  );
  if (!grantee) throw new NotFoundError('Utente destinatario non trovato');

  return queryOne(
    `INSERT INTO share_permissions (resource_type, grantor_user_id, grantee_user_id, level)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (resource_type, grantor_user_id, grantee_user_id)
     DO UPDATE SET level = EXCLUDED.level, updated_at = NOW()
     RETURNING *`,
    [resource, grantorUserId, granteeUserId, level]
  );
}

/** Revoca un permesso. Solo chi l'ha concesso può revocarlo. */
export async function revokePermission(permId: string, requesterId: string): Promise<void> {
  const row = await queryOne<{ grantor_user_id: string }>(
    `SELECT grantor_user_id FROM share_permissions WHERE id = $1`, [permId]
  );
  if (!row) throw new NotFoundError('Permesso non trovato');
  if (row.grantor_user_id !== requesterId) {
    throw new ForbiddenError('Solo chi ha concesso il permesso può revocarlo');
  }
  await query(`DELETE FROM share_permissions WHERE id = $1`, [permId]);
}
