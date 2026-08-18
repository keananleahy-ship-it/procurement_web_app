import { type NextRequest, NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { volumeImports } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const pathname = request.nextUrl.searchParams.get('pathname')
  if (!pathname) {
    return NextResponse.json({ error: 'Missing pathname' }, { status: 400 })
  }

  // Only allow access to files that belong to one of this user's volume imports.
  const [owned] = await db
    .select({ id: volumeImports.id })
    .from(volumeImports)
    .where(
      and(
        eq(volumeImports.userId, session.user.id),
        eq(volumeImports.blobPathname, pathname),
      ),
    )
  if (!owned) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const result = await get(pathname, {
      access: 'private',
      ifNoneMatch: request.headers.get('if-none-match') ?? undefined,
    })

    if (!result) {
      return new NextResponse('Not found', { status: 404 })
    }

    if (result.statusCode === 304) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: result.blob.etag,
          'Cache-Control': 'private, no-cache',
        },
      })
    }

    return new NextResponse(result.stream, {
      headers: {
        'Content-Type': result.blob.contentType,
        ETag: result.blob.etag,
        'Cache-Control': 'private, no-cache',
      },
    })
  } catch (error) {
    console.error('[v0] Error serving volume file:', error)
    return NextResponse.json({ error: 'Failed to serve file' }, { status: 500 })
  }
}
