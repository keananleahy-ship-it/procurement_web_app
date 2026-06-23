// Client-safe role types and pure helpers (no server-only imports).

export type Role = 'viewer' | 'uploader' | 'admin'

export const ROLES: Role[] = ['viewer', 'uploader', 'admin']

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  uploader: 'Uploader',
  admin: 'Admin',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Read-only access to all data.',
  uploader: 'Can upload imports, edit prices, and confirm matches.',
  admin: 'Full access, including managing users and roles.',
}

export function normalizeRole(value: string | null | undefined): Role {
  return value === 'admin' || value === 'uploader' ? value : 'viewer'
}

// Uploader inherits viewer; admin inherits everything.
export function canEdit(role: Role): boolean {
  return role === 'uploader' || role === 'admin'
}

export function canAdmin(role: Role): boolean {
  return role === 'admin'
}
