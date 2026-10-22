import { type NextRequest, NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { getCurrentUser, canEdit } from '@/lib/roles'

// Stores a raw purchase-history file in private Blob storage without parsing
// or committing anything. The browser uploads directly to Blob (bypassing the
// 4.5 MB function body limit), so this route only issues the upload token.
const MAX_BYTES = 500 * 1024 * 1024

export async function POST(request: NextRequest) {
  const body = (await request.json()) as HandleUploadBody

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const current = await getCurrentUser()
        if (!current || !canEdit(current.role)) {
          throw new Error('Only uploaders and admins can upload files.')
        }
        if (!pathname.startsWith('raw-volumes/')) {
          throw new Error('Invalid upload path.')
        }
        return {
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_BYTES,
          tokenPayload: JSON.stringify({ userId: current.id }),
        }
      },
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 400 },
    )
  }
}
