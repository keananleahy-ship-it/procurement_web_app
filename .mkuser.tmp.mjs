import { hashPassword } from 'better-auth/crypto'
import pg from 'pg'
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const mode = process.argv[2]
if (mode === 'create') {
  const h = await hashPassword('TempPass!2345')
  await p.query(`insert into "user"(id,name,email,"emailVerified",role) values('v0tmp','v0 Temp','v0tmp@example.com',true,'admin')`)
  await p.query(`insert into account(id,"accountId","providerId","userId",password) values('v0tmpacc','v0tmp','credential','v0tmp',$1)`, [h])
} else {
  await p.query(`delete from session where "userId"='v0tmp'`); await p.query(`delete from account where "userId"='v0tmp'`); await p.query(`delete from "user" where id='v0tmp'`)
}
console.log('done', mode); await p.end()
