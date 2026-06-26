import 'server-only'
import { Resend } from 'resend'

// Lazily construct the Resend client so the app still boots when the API key
// is absent (e.g. local dev). Callers should treat email as best-effort.
let client: Resend | null = null
function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  if (!client) client = new Resend(key)
  return client
}

// The verified sender. Falls back to Resend's shared onboarding domain, which
// works without domain verification but can only deliver to the account owner —
// set FEEDBACK_EMAIL_FROM to a verified address for production delivery.
function fromAddress(): string {
  return process.env.FEEDBACK_EMAIL_FROM || 'Procurement App <onboarding@resend.dev>'
}

export type SendEmailInput = {
  to: string[]
  subject: string
  html: string
  text: string
  replyTo?: string
}

// Best-effort transactional email. Returns a result object instead of throwing
// so that a mail failure never blocks the underlying user action.
export async function sendEmail(
  input: SendEmailInput,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const resend = getClient()
  if (!resend) {
    console.log('[v0] sendEmail skipped — RESEND_API_KEY not set')
    return { ok: false, skipped: true }
  }
  const recipients = input.to.filter(Boolean)
  if (recipients.length === 0) {
    return { ok: false, skipped: true }
  }
  try {
    const { error } = await resend.emails.send({
      from: fromAddress(),
      to: recipients,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo,
    })
    if (error) {
      console.log('[v0] sendEmail error:', error.message)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown email error'
    console.log('[v0] sendEmail threw:', message)
    return { ok: false, error: message }
  }
}
