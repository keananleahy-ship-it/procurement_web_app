import {
  pgTable,
  text,
  timestamp,
  boolean,
  serial,
  integer,
  numeric,
  date,
} from 'drizzle-orm/pg-core'

// --- Better Auth required tables -------------------------------------------
// Column names are camelCase to match Better Auth's defaults. Do not rename.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  // App role for the shared workspace: 'viewer' | 'uploader' | 'admin'.
  // New signups default to 'viewer'; the very first user is promoted to admin.
  role: text('role').notNull().default('viewer'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow(),
  updatedAt: timestamp('updatedAt').defaultNow(),
})

// --- App tables ------------------------------------------------------------
// Per-user scoping via `userId`; no FKs on app tables by design.

export const locations = pgTable('locations', {
  id: serial('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  region: text('region'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export const vendors = pgTable('vendors', {
  id: serial('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  contactEmail: text('contactEmail'),
  notes: text('notes'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export const canonicalItems = pgTable('canonical_items', {
  id: serial('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  category: text('category'),
  unit: text('unit'),
  // The base unit used to normalize prices across pack sizes for this item
  // (e.g. 'each', 'litre', 'kg'). Offers are compared per base unit.
  baseUnit: text('baseUnit'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  category: text('category'),
  sku: text('sku'),
  unit: text('unit'),
  // Fuzzy-matching to a canonical item. matchStatus is one of:
  // 'unmatched' | 'suggested' | 'confirmed' | 'rejected'.
  canonicalItemId: integer('canonicalItemId'),
  matchStatus: text('matchStatus').notNull().default('unmatched'),
  matchScore: numeric('matchScore', { precision: 5, scale: 4 }),
  // How the current suggestion was produced: 'fuzzy' | 'ai' | 'manual'.
  matchMethod: text('matchMethod'),
  // Short human-readable explanation for an AI-suggested match.
  matchReason: text('matchReason'),
  // Number of base units contained in one selling unit (e.g. a box of 100 =>
  // 100; a 5 L jug => 5). Used to normalize price per base unit.
  packSize: numeric('packSize', { precision: 12, scale: 4 })
    .notNull()
    .default('1'),
  // The base unit of measure for packSize (e.g. 'each', 'litre', 'kg').
  baseUnit: text('baseUnit'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

export const vendorPrices = pgTable('vendor_prices', {
  id: serial('id').primaryKey(),
  userId: text('userId').notNull(),
  productId: integer('productId').notNull(),
  vendorId: integer('vendorId').notNull(),
  locationId: integer('locationId'),
  unitPrice: numeric('unitPrice', { precision: 12, scale: 2 }).notNull(),
  // Inbound freight expressed PER SELLING UNIT (same basis as unitPrice). Per-
  // order/per-shipment freight is converted to per-unit at import or entry.
  shippingCost: numeric('shippingCost', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  // True when shippingCost is a user-supplied estimate rather than a quoted
  // figure (used to rationalize FOB offers that arrive without freight).
  freightEstimated: boolean('freightEstimated').notNull().default(false),
  // Freight basis for this quote:
  //  'fob'       -> unitPrice is FOB origin; buyer adds shippingCost per unit
  //  'delivered' -> unitPrice is the all-in delivered price; freight included
  //  'both'      -> vendor offers FOB (unitPrice + shippingCost) AND a
  //                 delivered alternative stored in deliveredPrice
  freightTerms: text('freightTerms').notNull().default('fob'),
  deliveredPrice: numeric('deliveredPrice', { precision: 12, scale: 2 }),
  minOrderQty: integer('minOrderQty').notNull().default(1),
  currency: text('currency').notNull().default('USD'),
  // The date this pricing is effective (chosen by the uploader). Falls back to
  // createdAt for rows entered before file imports existed.
  effectiveDate: date('effectiveDate'),
  // Provenance: the file import this price came from, if any.
  importId: integer('importId'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})

// --- File imports ----------------------------------------------------------
// Each upload (XLS or PDF) from a location is staged here, AI-parsed into
// import_rows for review, then committed into vendor_prices.

export const imports = pgTable('imports', {
  id: serial('id').primaryKey(),
  userId: text('userId').notNull(),
  locationId: integer('locationId'),
  fileName: text('fileName').notNull(),
  blobPathname: text('blobPathname').notNull(),
  // 'xls' | 'pdf'
  fileType: text('fileType').notNull(),
  // The date the pricing is effective, chosen by the uploader.
  effectiveDate: date('effectiveDate').notNull(),
  // 'pending' | 'committed' | 'discarded'
  status: text('status').notNull().default('pending'),
  rowCount: integer('rowCount').notNull().default(0),
  note: text('note'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  committedAt: timestamp('committedAt'),
})

// Staging rows parsed from an import, edited/approved before commit.
export const importRows = pgTable('import_rows', {
  id: serial('id').primaryKey(),
  userId: text('userId').notNull(),
  importId: integer('importId').notNull(),
  productName: text('productName').notNull(),
  vendorName: text('vendorName'),
  sku: text('sku'),
  unit: text('unit'),
  category: text('category'),
  unitPrice: numeric('unitPrice', { precision: 12, scale: 2 }),
  // Inbound freight per selling unit (converted from per-order at extraction).
  shippingCost: numeric('shippingCost', { precision: 12, scale: 2 })
    .notNull()
    .default('0'),
  // True when shippingCost is an estimate rather than a quoted figure.
  freightEstimated: boolean('freightEstimated').notNull().default(false),
  freightTerms: text('freightTerms').notNull().default('fob'),
  deliveredPrice: numeric('deliveredPrice', { precision: 12, scale: 2 }),
  minOrderQty: integer('minOrderQty').notNull().default(1),
  currency: text('currency').notNull().default('USD'),
  // Inferred number of base units per selling unit, editable in review.
  packSize: numeric('packSize', { precision: 12, scale: 4 })
    .notNull()
    .default('1'),
  // Inferred base unit of measure (e.g. 'each', 'litre').
  baseUnit: text('baseUnit'),
  include: boolean('include').notNull().default(true),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
})
