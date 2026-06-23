import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const k = process.env.OPENAI_API_KEY
  return NextResponse.json({
    openaiKey: k ? `set (prefix ${k.slice(0, 7)}, len ${k.length})` : 'NOT set',
  })
}
