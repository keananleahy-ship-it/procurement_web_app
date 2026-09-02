import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const { rows } = await pool.query(
  `select u.id, u.name, u.email, u.role,
          coalesce(json_agg(l.name) filter (where l.name is not null), '[]') as locations
     from "user" u
     left join user_locations ul on ul."userId" = u.id
     left join locations l on l.id = ul."locationId"
    group by u.id, u.name, u.email, u.role
    order by u.role, u.email`,
)
console.table(
  rows.map((r) => ({
    name: r.name,
    email: r.email,
    role: r.role,
    locations: Array.isArray(r.locations) ? r.locations.join(', ') : r.locations,
  })),
)

await pool.end()
