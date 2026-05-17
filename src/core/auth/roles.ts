export type Role = 'client' | 'operator' | 'admin' | 'owner';

/**
 * Role hierarchy: owner > admin > operator > client
 * Each role inherits permissions of roles below it.
 */
const ROLE_LEVEL: Record<Role, number> = {
  client: 0,
  operator: 1,
  admin: 2,
  owner: 3,
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
