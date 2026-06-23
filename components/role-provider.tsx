'use client'

import { createContext, useContext } from 'react'
import { type Role, canEdit, canAdmin } from '@/lib/roles-shared'

const RoleContext = createContext<Role>('viewer')

export function RoleProvider({
  role,
  children,
}: {
  role: Role
  children: React.ReactNode
}) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>
}

export function useRole(): Role {
  return useContext(RoleContext)
}

// Convenience hooks mirroring the server-side capability checks.
export function useCanEdit(): boolean {
  return canEdit(useRole())
}

export function useCanAdmin(): boolean {
  return canAdmin(useRole())
}
