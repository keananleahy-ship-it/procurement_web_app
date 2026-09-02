// Client-safe role types and pure helpers (no server-only imports).

export type Role = 'viewer' | 'champion' | 'uploader' | 'admin'

export const ROLES: Role[] = ['viewer', 'champion', 'uploader', 'admin']

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  champion: 'Site Champion',
  uploader: 'Uploader',
  admin: 'Admin',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Read-only access to all data.',
  champion: 'Validates catalog data for their assigned site(s) only.',
  uploader: 'Can upload imports, edit prices, and confirm matches.',
  admin: 'Full access, including managing users and roles.',
}

export function normalizeRole(value: string | null | undefined): Role {
  return value === 'admin' || value === 'uploader' || value === 'champion'
    ? value
    : 'viewer'
}

// Uploader inherits viewer; admin inherits everything. NOTE: champion is
// deliberately NOT a general editor — it grants edit rights only inside the
// Catalog Validation function (see canValidateCatalog), scoped to the
// champion's assigned location(s). Keeping it out of canEdit prevents a
// champion from mutating prices, products, matches, etc. elsewhere.
export function canEdit(role: Role): boolean {
  return role === 'uploader' || role === 'admin'
}

export function canAdmin(role: Role): boolean {
  return role === 'admin'
}

// Capability for the Catalog Validation function: correcting attributes,
// signing off records, and running the AI-suggest pass. Champions qualify
// (scoped per-location by assertLocationAccess), as do uploaders and admins.
export function canValidateCatalog(role: Role): boolean {
  return role === 'champion' || role === 'uploader' || role === 'admin'
}

// True for roles that are confined to the Catalog Validation function and
// must be redirected away from the rest of the app. Only site champions.
export function isValidationOnly(role: Role): boolean {
  return role === 'champion'
}
