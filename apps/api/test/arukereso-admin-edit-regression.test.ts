import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateFeedEligibility, resolveFeedEligibilitySettings, parseCatalogFeedSourceRow, toCatalogFeedOutputRow, serializeCatalogFeedCsv } from '../src/arukereso.ts'
import { createOverrideEditCoordinator } from '../../web/src/utils/overrideEditCoordinator.ts'

type Mode = 'INHERIT' | 'FORCE_INCLUDE' | 'FORCE_EXCLUDE'
const settings = resolveFeedEligibilitySettings(JSON.stringify({ useMinIndex:true,maxMinIndexBps:11000,useMedianIndex:false,useAverageIndex:false,useStockRule:true,allowNoCompetitor:false })).settings
const pricingRow = {priceIndexBps:10000,medianIndexBps:10000,averageIndexBps:10000,dataStatus:'HAS_COMPETITOR',observedAt:new Date('2026-11-02T06:00:00Z')}
const evaluate = (override: Mode, stockQuantity=5, index=10000, price=1299000) => evaluateFeedEligibility({
  override,stockQuantity,pricingRow:{...pricingRow,priceIndexBps:index},settings,now:new Date('2026-11-02T07:00:00Z'),catalogPriceMinor:price,
})
test('manual precedence, global pricing rules, stock rule and invalid price guard remain intact', () => {
  assert.equal(evaluate('FORCE_EXCLUDE').included,false)
  assert.equal(evaluate('FORCE_INCLUDE',0,20000).included,true)
  assert.equal(evaluate('INHERIT',5,20000).reasonCode,'FEED_BLOCKED_MIN_INDEX')
  assert.equal(evaluate('INHERIT',0).reasonCode,'FEED_BLOCKED_OUT_OF_STOCK')
  assert.equal(evaluate('FORCE_INCLUDE',5,10000,0).reasonCode,'FEED_BLOCKED_INVALID_CATALOG_PRICE')
})
test('same saved overrides produce identical final preview/count/filter/pages and serialized feed', async () => {
  const actions: Array<[string,Mode]>=[['A','FORCE_EXCLUDE'],['B','FORCE_EXCLUDE'],['C','FORCE_INCLUDE'],['D','INHERIT']]
  const before=new Map<string,Mode>([['D','FORCE_EXCLUDE']])
  const after=new Map(before)
  const write=(map:Map<string,Mode>,id:string,mode:Mode)=>{if(mode==='INHERIT')map.delete(id);else map.set(id,mode)}
  let callback=()=>{},builds=0
  const c=createOverrideEditCoordinator<Mode>({
    write:async(id,mode)=>write(after,id,mode),refresh:async()=>{builds++;return true},changed:()=>{},refreshFailed:()=>assert.fail('Unexpected failure'),
    schedule:cb=>{callback=cb;return 1},cancel:()=>{},now:()=>0,
  })
  for(const [id,mode] of actions){write(before,id,mode);await c.save(id,mode)}
  callback();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(builds,1)
  const model=(map:Map<string,Mode>)=>['A','B','C','D'].map((id,index)=>{
    const result=evaluate(map.get(id)??'INHERIT',index===2?0:5,index===3?20000:10000)
    const source=parseCatalogFeedSourceRow(JSON.stringify({
      Identifier:`id-${id}`,EanCode:'1234567890123',Manufacturer:'Kärcher',Name:`Product ${id}`,Description:'Text',Category:'Category',
      ProductUrl:`https://example.test/${id}`,ImageUrl:'https://example.test/image.jpg',ImageUrl2:'',Price:'12 990 Ft',NetPrice:'10 228,35 Ft',DeliveryCost:'1 490 Ft',DeliveryTime:'8 munkanap',
    }),id)
    const output=toCatalogFeedOutputRow({source,sku:id,result} as never)
    return {id,result,output}
  })
  const expected=model(before),actual=model(after)
  assert.deepEqual(actual,expected)
  for(const included of [true,false]) {
    const x=actual.filter(r=>r.result.included===included),y=expected.filter(r=>r.result.included===included)
    assert.equal(x.length,y.length)
    for(let offset=0;offset<4;offset+=2)assert.deepEqual(x.slice(offset,offset+2),y.slice(offset,offset+2))
  }
  assert.equal(serializeCatalogFeedCsv(actual.map(r=>r.output)),serializeCatalogFeedCsv(expected.map(r=>r.output)))
  for(const row of actual)assert.equal(row.output.Price,'12 990 Ft')
})
