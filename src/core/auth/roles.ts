export type Role = 'client' | 'user' | 'operator' | 'admin' | 'owner';

/**
 * Role hierarchy: owner > admin > operator > user > client
 * Each role inherits permissions of roles below it.
 *
 * 'user' è l'account consumer (registrazione pubblica): può usare la propria
 * agenda ma NON eredita i privilegi di staff ('operator'), che restano
 * riservati agli account interni.
 */
const ROLE_LEVEL: Record<Role, number> = {
  client: 0,
  user: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

/**
 * Check if a user's role meets the minimum required role.
 */
export function hasMinimumRole(userRole: Role, requiredRole: Role): boolean {
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[requiredRole];
}

/**
 * Check if a user's role is one of the allowed roles.
 */
export function hasRole(userRole: Role, allowedRoles: Role[]): boolean {
  return allowedRoles.includes(userRole);
}

/**
 * Check if user is at least an operator (staff member).
 */
export function isStaff(role: Role): boolean {
  return hasMinimumRole(role, 'operator');
}
