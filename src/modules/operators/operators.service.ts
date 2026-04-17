import { queryOne, queryMany, query, transaction } from '../../shared/db';
import { PoolClient } from 'pg';
import { NotFoundError, ConflictError } from '../../core/errors';
import { hashPassword } from '../../core/auth/password';
import { generatePassword } from '../../core/auth/generate-password';
import { CreateOperatorInput, UpdateOperatorInput } from './operators.schema';
import { randomBytes } from 'crypto';

// ── CREATE ──

export async function createOperator(input: CreateOperatorInput): Promise<any> {
  const username = input.email.toLowerCase().trim();
  const password = input.password || generatePassword();
  const passwordHash = await hashPassword(password);
  const role = input.isAdmin ? 'admin' : 'operator';

  // Check if a soft-deleted operator with this email already exists → reactivate
  const existingOp = await queryOne<{ id: string; user_id: string }>(
    `SELECT o.id, o.user_id FROM operators o
     JOIN users u ON u.id = o.user_id
     WHERE o.email = $1 AND u.is_active = false`,
    [input.email]
  );

  if (existingOp) {
    // Reactivate: update user + operator with new data
    await query(
      `UPDATE users SET is_active = true, password_hash = $1, password_version = 2,
       role = $2, updated_at = NOW() WHERE id = $3`,
      [passwordHash, role, existingOp.user_id]
    );
    await query(
      `UPDATE operators SET first_name = $1, last_name = $2, department = $3,
       is_admin = $4, last_set_password = $5, updated_at = NOW() WHERE id = $6`,
      [input.firstName, input.lastName, input.department || null, input.isAdmin, password, existingOp.id]
    );
    const result = await getOperatorById(existingOp.id);
    return { ...result, generatedPassword: input.password ? undefined : password, username };
  }

  // Check active uniqueness
  const activeOp = await queryOne(`SELECT id FROM operators WHERE email = $1`, [input.email]);
  if (activeOp) throw new ConflictError('An operator with this email already exists');
  const activeUser = await queryOne(`SELECT id FROM users WHERE username = $1`, [username]);
  if (activeUser) throw new ConflictError(`Username "${username}" already exists`);

  const operatorId = await transaction(async (client: PoolClient) => {
    const userResult = await client.query(
      `INSERT INTO users (username, password_hash, password_version, role)
       VALUES ($1, $2, 2, $3) RETURNING id`,
      [username, passwordHash, role]
    );
    const userId = userResult.rows[0].id;

    const opResult = await client.query(
      `INSERT INTO operators (user_id, email, first_name, last_name, department, is_admin, last_set_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, input.email, input.firstName, input.lastName, input.department || null, input.isAdmin, password]
    );

    return opResult.rows[0].id as string;
  });

  const result = await getOperatorById(operatorId);
  return { ...result, generatedPassword: input.password ? undefined : password, username };
}

// ── READ ──

export async function getOperatorById(operatorId: string): Promise<any> {
  const op = await queryOne(
    `SELECT o.*, u.username, u.is_active, u.last_login, u.role as user_role
     FROM operators o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = $1`,
    [operatorId]
  );
  if (!op) throw new NotFoundError('Operator not found');
  return op;
}

// Minimal list for all staff — only name + user_id + photo, no sensitive data
export async function listColleagues(): Promise<any[]> {
  return queryMany(
    `SELECT o.id, o.first_name, o.last_name, o.user_id, o.photo
     FROM operators o
     JOIN users u ON u.id = o.user_id
     WHERE u.is_active = true
     ORDER BY o.first_name, o.last_name`
  );
}

export async function listOperators(
  filters: { search?: string; department?: string; page: number; limit: number }
): Promise<{ operators: any[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.search) {
    conditions.push(`(o.first_name ILIKE $${idx} OR o.last_name ILIKE $${idx} OR o.email ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }

  if (filters.department) {
    conditions.push(`o.department = $${idx}`);
    params.push(filters.department);
    idx++;
  }

  const andCond = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
  const offset = (filters.page - 1) * filters.limit;

  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM operators o JOIN users u ON u.id = o.user_id WHERE u.is_active = true ${andCond}`,
    params
  );
  const total = parseInt(countResult?.count || '0', 10);

  const operators = await queryMany(
    `SELECT o.id, o.email, o.first_name, o.last_name, o.department, o.department_id,
            o.is_admin, o.is_owner, o.created_at, o.last_set_password, o.photo,
            u.username, u.is_active, u.last_login, u.id as user_id
     FROM operators o
     JOIN users u ON u.id = o.user_id
     WHERE u.is_active = true ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
     ORDER BY o.last_name, o.first_name
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, filters.limit, offset]
  );

  return { operators, total };
}

// ── UPDATE ──

export async function updateOperator(operatorId: string, input: UpdateOperatorInput): Promise<any> {
  const existing = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM operators WHERE id = $1`, [operatorId]
  );
  if (!existing) throw new NotFoundError('Operator not found');

  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  const addSet = (col: string, val: any) => {
    if (val !== undefined) { sets.push(`${col} = $${idx}`); params.push(val); idx++; }
  };

  addSet('email', input.email);
  addSet('first_name', input.firstName);
  addSet('last_name', input.lastName);
  addSet('department', input.department);
  addSet('is_admin', input.isAdmin);

  if (sets.length > 0) {
    sets.push('updated_at = NOW()');
    await query(`UPDATE operators SET ${sets.join(', ')} WHERE id = $${idx}`, [...params, operatorId]);
  }

  // Sync role in users table if isAdmin changed
  if (input.isAdmin !== undefined) {
    const newRole = input.isAdmin ? 'admin' : 'operator';
    // Don't downgrade owners
    const currentOp = await queryOne<{ is_owner: boolean }>(`SELECT is_owner FROM operators WHERE id = $1`, [operatorId]);
    if (!currentOp?.is_owner) {
      await query(`UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2`, [newRole, existing.user_id]);
    }
  }

  // Sync username if email changed
  if (input.email) {
    await query(`UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2`, [input.email.toLowerCase(), existing.user_id]);
  }

  return getOperatorById(operatorId);
}

// ── DELETE ──

export async function deleteOperator(operatorId: string, requesterUserId: string): Promise<void> {
  const existing = await queryOne<{ user_id: string; is_owner: boolean }>(
    `SELECT user_id, is_owner FROM operators WHERE id = $1`, [operatorId]
  );
  if (!existing) throw new NotFoundError('Operator not found');
  if (existing.is_owner) throw new ConflictError('Cannot delete the owner');
  if (existing.user_id === requesterUserId) throw new ConflictError('Cannot delete yourself');

  await query(`UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1`, [existing.user_id]);
}

// ── ADMIN MANAGEMENT ──

export async function promoteToAdmin(operatorId: string): Promise<any> {
  const op = await queryOne<{ user_id: string }>(`SELECT user_id FROM operators WHERE id = $1`, [operatorId]);
  if (!op) throw new NotFoundError('Operator not found');

  await query(`UPDATE operators SET is_admin = true, updated_at = NOW() WHERE id = $1`, [operatorId]);
  await query(`UPDATE users SET role = 'admin', updated_at = NOW() WHERE id = $1`, [op.user_id]);
  return getOperatorById(operatorId);
}

export async function demoteFromAdmin(operatorId: string): Promise<any> {
  const op = await queryOne<{ user_id: string; is_owner: boolean }>(
    `SELECT user_id, is_owner FROM operators WHERE id = $1`, [operatorId]
  );
  if (!op) throw new NotFoundError('Operator not found');
  if (op.is_owner) throw new ConflictError('Cannot demote the owner');

  await query(`UPDATE operators SET is_admin = false, updated_at = NOW() WHERE id = $1`, [operatorId]);
  await query(`UPDATE users SET role = 'operator', updated_at = NOW() WHERE id = $1`, [op.user_id]);
  return getOperatorById(operatorId);
}

// ── RESET PASSWORD ──

export async function resetOperatorPassword(operatorId: string): Promise<{ username: string; password: string }> {
  const op = await queryOne<{ user_id: string; username: string }>(
    `SELECT o.user_id, u.username FROM operators o JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
    [operatorId]
  );
  if (!op) throw new NotFoundError('Operator not found');

  const newPassword = generatePassword();
  const hash = await hashPassword(newPassword);

  await query(
    `UPDATE users SET password_hash = $1, password_version = 2, updated_at = NOW() WHERE id = $2`,
    [hash, op.user_id]
  );
  await query(
    `UPDATE operators SET last_set_password = $1 WHERE id = $2`,
    [newPassword, operatorId]
  );

  return { username: op.username, password: newPassword };
}

// ── PHOTO ──

export async function updateOperatorPhoto(operatorId: string, photo: string | null): Promise<any> {
  const existing = await queryOne(`SELECT id FROM operators WHERE id = $1`, [operatorId]);
  if (!existing) throw new NotFoundError('Operator not found');

  await query(`UPDATE operators SET photo = $1, updated_at = NOW() WHERE id = $2`, [photo, operatorId]);
  return getOperatorById(operatorId);
}

export async function setOperatorPassword(operatorId: string, newPassword: string): Promise<{ username: string }> {
  const op = await queryOne<{ user_id: string; username: string }>(
    `SELECT o.user_id, u.username FROM operators o JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
    [operatorId]
  );
  if (!op) throw new NotFoundError('Operator not found');

  const hash = await hashPassword(newPassword);
  await query(
    `UPDATE users SET password_hash = $1, password_version = 2, updated_at = NOW() WHERE id = $2`,
    [hash, op.user_id]
  );
  await query(
    `UPDATE operators SET last_set_password = $1 WHERE id = $2`,
    [newPassword, operatorId]
  );

  return { username: op.username };
}
