'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Package,
  Store,
  MapPin,
  Tags,
  LogOut,
  GitCompareArrows,
  Layers,
  ListChecks,
  Upload,
  Users,
  PiggyBank,
  LineChart,
  Map as MapIcon,
  MessageSquareWarning,
} from 'lucide-react'
import { type Role, ROLE_LABELS } from '@/lib/roles-shared'

const nav = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/savings', label: 'Savings', icon: PiggyBank },
  { href: '/compare', label: 'Compare Products', icon: GitCompareArrows },
  { href: '/by-location', label: 'By Location', icon: MapIcon },
  { href: '/trends', label: 'Price Trends', icon: LineChart },
  { href: '/matching', label: 'Match Verification', icon: ListChecks },
  { href: '/canonical', label: 'Canonical Items', icon: Layers },
  { href: '/imports', label: 'Data Imports', icon: Upload },
  { href: '/prices', label: 'Price Entries', icon: Tags },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/vendors', label: 'Vendors', icon: Store },
  { href: '/locations', label: 'Locations', icon: MapPin },
]

export function AppSidebar({
  userName,
  role,
  openFeedbackCount = 0,
}: {
  userName: string
  role: Role
  openFeedbackCount?: number
}) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    await authClient.signOut()
    router.push('/sign-in')
    router.refresh()
  }

  return (
    <aside className="flex h-svh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex flex-col gap-2 px-5 py-5">
        <div className="flex items-center justify-center rounded-md bg-white px-3 py-2.5">
          <Image
            src="/brand/ace-solutions-logo.jpg"
            alt="ACE Solutions"
            width={1300}
            height={422}
            priority
            className="h-7 w-auto"
          />
        </div>
        <span className="px-0.5 text-xs font-medium text-sidebar-foreground/60">
          Procurement · Vendor Pricing
        </span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
        {nav.map((item) => {
          const active =
            item.href === '/'
              ? pathname === '/'
              : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          )
        })}
        {role === 'admin' && (
          <>
            <Link
              href="/admin/feedback"
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                pathname.startsWith('/admin/feedback')
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              <MessageSquareWarning className="size-4" />
              <span className="flex-1">Feedback</span>
              {openFeedbackCount > 0 && (
                <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums">
                  {openFeedbackCount}
                </span>
              )}
            </Link>
            <Link
              href="/admin"
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                pathname === '/admin'
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
              )}
            >
              <Users className="size-4" />
              User Management
            </Link>
          </>
        )}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 rounded-md px-3 py-2">
          <div className="flex size-8 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
            {userName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{userName}</p>
            <p className="truncate text-xs text-sidebar-foreground/60">
              {ROLE_LABELS[role]}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            className="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
