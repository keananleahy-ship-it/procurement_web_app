import { querySnowflake } from '@/lib/snowflake'

async function main() {
  const rows = await querySnowflake<Record<string, unknown>>(`
    with items as (
      select VENDOR_ID v, PART_NUMBER pn, max(nullif(trim(VENDOR_PART_NUMBER), '')) vpn,
             sum(COST_EXTENDED) cost, max(INVOICE_DATE) last_inv, min(INVOICE_DATE) first_inv
      from DEVELOPMENT.V_REPORTS.PURCHASE_ORDER_CONSOLIDATED
      where INVOICE_DATE >= dateadd(month, -12, current_date())
        and lower(PBI_PRODUCT_LINE) in ('oil lubricants','grease','antifreeze','def')
      group by 1, 2
    )
    select v,
      count(*) items,
      count_if(vpn is null) blank,
      count_if(vpn = pn) same,
      count_if(vpn is not null and vpn <> pn) differs,
      round(sum(iff(vpn is null, cost, 0))) blank_cost,
      round(sum(cost)) cost
    from items group by 1 order by cost desc limit 30`)
  for (const r of rows) console.log(Object.values(r).join(' | '))

  const ex = await querySnowflake<Record<string, unknown>>(`
    select VENDOR_ID, PART_NUMBER, VENDOR_PART_NUMBER, SHORT_DESCRIPTION, BASE_LEVEL_1, count(*) n
    from DEVELOPMENT.V_REPORTS.PURCHASE_ORDER_CONSOLIDATED
    where INVOICE_DATE >= dateadd(month, -12, current_date())
      and lower(PBI_PRODUCT_LINE) in ('oil lubricants','grease','antifreeze','def')
      and VENDOR_PART_NUMBER is not null and trim(VENDOR_PART_NUMBER) <> '' and VENDOR_PART_NUMBER <> PART_NUMBER
    group by 1,2,3,4,5 order by n desc limit 15`)
  console.log('--- differs examples')
  for (const r of ex) console.log(Object.values(r).join(' | '))

  const bu = await querySnowflake<Record<string, unknown>>(`
    select BASE_LEVEL_1, count(distinct PART_NUMBER) items,
      count(distinct iff(nullif(trim(VENDOR_PART_NUMBER),'') is null, PART_NUMBER, null)) blank
    from DEVELOPMENT.V_REPORTS.PURCHASE_ORDER_CONSOLIDATED
    where INVOICE_DATE >= dateadd(month, -12, current_date())
      and lower(PBI_PRODUCT_LINE) in ('oil lubricants','grease','antifreeze','def')
    group by 1 order by 2 desc`)
  console.log('--- by business unit')
  for (const r of bu) console.log(Object.values(r).join(' | '))
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
