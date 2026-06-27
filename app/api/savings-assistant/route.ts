import { streamText, convertToModelMessages, tool, stepCountIs } from 'ai'
import type { UIMessage } from 'ai'
import { z } from 'zod'
import {
  getProductComparisons,
  getLocationComparisons,
} from '@/app/actions/comparisons'
import { requireUser } from '@/lib/roles'

// Allow generous time for multi-step tool reasoning.
export const maxDuration = 60

// Shape the rich ProductComparison objects into a compact, token-friendly
// payload the model can reason over: per-group vendor price matrix + volumes.
async function buildSavingsData(query?: string) {
  const [comparisons, locations] = await Promise.all([
    getProductComparisons(),
    getLocationComparisons(),
  ])

  const q = query?.trim().toLowerCase()
  const filtered = q
    ? comparisons.filter((c) => c.displayName.toLowerCase().includes(q))
    : comparisons

  const round = (n: number) => Math.round(n * 100) / 100

  const groups = filtered.map((c) => {
    // Only offers that are actually comparable (right unit, freight-complete)
    // carry a meaningful per-unit price for switching math.
    const vendors = c.offers
      .filter((o) => o.comparable)
      .map((o) => ({
        vendor: o.vendorName,
        pricePerBaseUnit: round(o.comparablePricePerBaseUnit),
        // flags a price that was unit-converted (e.g. gear oil lb -> gal)
        converted: o.unitConverted,
      }))
      .sort((a, b) => a.pricePerBaseUnit - b.pricePerBaseUnit)

    return {
      product: c.displayName,
      baseUnit: c.baseUnit ?? 'unit',
      vendorCount: c.vendorCount,
      annualVolume: round(c.annualVolume),
      volumeByLocation: c.volumeByLocation.map((v) => ({
        location: v.locationName,
        annualVolume: round(v.annualVolume),
      })),
      vendors,
      bestVendor: vendors[0]?.vendor ?? null,
      bestPricePerBaseUnit: vendors[0]?.pricePerBaseUnit ?? null,
      highestPricePerBaseUnit:
        vendors[vendors.length - 1]?.pricePerBaseUnit ?? null,
      potentialSavingsPerBaseUnit: round(c.potentialSavings),
      realizableAnnualSavings: round(c.realizableSavings),
    }
  })

  return {
    currency: 'USD',
    locations: locations.map((l) => ({
      location: l.locationName,
      annualVolume: round(l.annualVolume),
      annualizedSavings: round(l.realizableSavings),
    })),
    groupCount: groups.length,
    groups,
  }
}

const SYSTEM = `You are the Sourcing Savings Assistant for a procurement comparison app.
You help users quantify savings opportunities across vendors, products, and locations.

DATA & TOOLS
- Always call the getSavingsData tool to ground every answer in real data. Never invent numbers.
- Pass a short "query" keyword (e.g. "hydraulic", "gear oil", "grease") to focus on relevant products; omit it for portfolio-wide questions.
- Each group gives you: the product, its base unit, total annual purchase volume, volume per location, and a vendor price matrix (price per base unit, lowest first). Prices are landed cost per base unit and already normalized for pack size and units.

HOW TO REASON ABOUT SAVINGS
- Annual cost at a given vendor for a group = that vendor's pricePerBaseUnit x the group's annualVolume (or the per-location volume for location-specific questions).
- The app does NOT track which vendor is currently being purchased from. So when asked "how much could we save by switching to vendor X":
  1. Compute the annual cost if ALL of that product's volume were bought from vendor X (only for groups where X actually has a comparable price).
  2. Compare it to the cheapest alternative vendor in each group (the baseline a rational buyer would otherwise pick).
  3. If vendor X is already the cheapest, say so — switching to X SAVES money versus higher-priced vendors; quantify versus the next-best and versus the highest-priced option as a range.
  4. ALWAYS state your baseline assumption in one sentence so the user can correct it.
- For "biggest opportunities" questions, rank by realizableAnnualSavings.
- If a vendor doesn't supply a product (not in its vendor list), say so rather than guessing.

OUTPUT STYLE
- Lead with the headline dollar figure. Format currency as $1,234 (USD, no cents unless < $100).
- Show a brief per-product or per-location breakdown as a markdown table or bullets.
- Show the key arithmetic compactly (price delta x volume) so the number is auditable.
- Be concise and decision-oriented. Note caveats (e.g. converted units, missing volume data) only when they affect the answer.`

export async function POST(req: Request) {
  // Gate on auth — the data is the workspace's pricing, not public.
  await requireUser()

  const { messages }: { messages: UIMessage[] } = await req.json()

  const result = streamText({
    model: 'anthropic/claude-haiku-4.5',
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(6),
    tools: {
      getSavingsData: tool({
        description:
          'Get live savings/comparison data: per-product vendor price matrix, annual purchase volume (total and per location), best/highest prices, and annualized savings. Call this before answering any question about savings, vendors, prices, or volumes.',
        inputSchema: z.object({
          query: z
            .string()
            .nullable()
            .describe(
              'Optional keyword to filter products by name (e.g. "hydraulic", "gear oil", "grease"). Use null for portfolio-wide questions.',
            ),
        }),
        execute: async ({ query }) =>
          buildSavingsData(query ?? undefined),
      }),
    },
  })

  return result.toUIMessageStreamResponse()
}
