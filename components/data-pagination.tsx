'use client'

import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export function DataPagination({
  page,
  pageSize,
  total,
  onPageChange,
  label = 'items',
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  label?: string
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (total === 0) return null

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
      <p className="text-sm text-muted-foreground tabular-nums">
        Showing {from}–{to} of {total} {label}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-4" />
          Previous
        </Button>
        <span className="text-sm text-muted-foreground tabular-nums">
          Page {page} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
