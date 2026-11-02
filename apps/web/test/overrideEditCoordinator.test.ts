import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createOverrideEditCoordinator, type OverrideEdit } from '../src/utils/overrideEditCoordinator.ts'

type Mode = 'INHERIT' | 'FORCE_INCLUDE' | 'FORCE_EXCLUDE'
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
  let now = 0, timerId = 0
  let edits: Record<string, OverrideEdit<Mode>> = {}
  const timers = new Map<number, { at: number; callback: () => void }>()
  const stored = new Map<string, Mode>()
  const counts = { mutations: 0, previews: 0, fullSourceBuilds: 0, catalogReads: 0, inventoryReads: 0, pricingReads: 0, generationCalls: 0, refreshFailures: 0 }
  let writeFailure = false, readFailure = false
  const preview = async () => {
    counts.previews++; counts.fullSourceBuilds++; counts.catalogReads++; counts.inventoryReads++; counts.pricingReads++
    if (readFailure) throw new Error('preview unavailable')
    return true
  }
  const write = async (id: string, mode: Mode) => {
    counts.mutations++
    if (writeFailure) throw new Error('Save failed')
    if (mode === 'INHERIT') stored.delete(id)
    else stored.set(id, mode)
  }
  const coordinator = createOverrideEditCoordinator<Mode>({
    write, refresh: preview, changed: next => { edits = next },
    refreshFailed: () => { counts.refreshFailures++ },
    schedule: (callback, delay) => { const id=++timerId; timers.set(id,{at:now+delay,callback}); return id },
    cancel: id => { timers.delete(id) }, now: () => now,
  })
  return { coordinator, counts, stored, timers, edits: () => edits, write, preview,
    failWrites: (value: boolean) => { writeFailure=value }, failReads: (value: boolean) => { readFailure=value },
    advance: async (ms: number) => {
      now+=ms
      for (const [id,timer] of [...timers]) if(timer.at<=now) { timers.delete(id); timer.callback() }
      await settle()
    },
  }
}
for (const mode of ['FORCE_INCLUDE','FORCE_EXCLUDE','INHERIT'] as const) {
  test(`single ${mode}: immediate save, one settled preview`, async () => {
    const f=fixture(); const promise=f.coordinator.save('A',mode)
    assert.equal(f.counts.mutations,1); assert.equal(f.edits().A.status,'saving')
    await promise; assert.equal(f.edits().A.status,'saved'); assert.equal(f.counts.previews,0)
    await f.advance(2000); assert.equal(f.counts.previews,1); assert.deepEqual(f.edits(),{})
    assert.equal(f.counts.generationCalls,0)
  })
}
test('exact A exclude, B exclude, C include, D global-rule inheritance workflow: 4 builds -> 1', async () => {
  const actions: Array<[string,Mode]>=[['A','FORCE_EXCLUDE'],['B','FORCE_EXCLUDE'],['C','FORCE_INCLUDE'],['D','INHERIT']]
  const before=fixture(), after=fixture()
  before.stored.set('D','FORCE_EXCLUDE'); after.stored.set('D','FORCE_EXCLUDE')
  for(const [id,value] of actions) {
    await before.write(id,value); await before.preview()
    await after.coordinator.save(id,value); await after.advance(300)
  }
  await after.advance(2000)
  assert.deepEqual([...after.stored],[...before.stored])
  assert.equal(before.counts.mutations,4); assert.equal(after.counts.mutations,4)
  for(const key of ['previews','fullSourceBuilds','catalogReads','inventoryReads','pricingReads'] as const) {
    assert.equal(before.counts[key],4); assert.equal(after.counts[key],1)
  }
  assert.equal(after.counts.generationCalls,0); assert.equal(before.counts.generationCalls,0)
})
test('repeat same product after confirmed save retains final choice', async () => {
  const f=fixture()
  await f.coordinator.save('A','FORCE_EXCLUDE'); await f.coordinator.save('A','FORCE_INCLUDE')
  await f.advance(2000)
  assert.equal(f.stored.get('A'),'FORCE_INCLUDE'); assert.equal(f.counts.previews,1)
})
test('failed save retains choice and retry does not replay other successful edits', async () => {
  const f=fixture()
  await f.coordinator.save('A','FORCE_EXCLUDE')
  f.failWrites(true); await f.coordinator.save('B','FORCE_INCLUDE')
  await f.advance(2000)
  assert.deepEqual(f.edits().B,{value:'FORCE_INCLUDE',status:'failed',error:'Save failed'})
  assert.equal(f.edits().A,undefined)
  f.failWrites(false); await f.coordinator.save('B',f.edits().B.value); await f.advance(2000)
  assert.equal(f.counts.mutations,3); assert.deepEqual(f.edits(),{})
})
test('preview failure does not retry writes or create an automatic read loop', async () => {
  const f=fixture(); f.failReads(true)
  await f.coordinator.save('A','FORCE_EXCLUDE'); await f.advance(2000); await f.advance(60000)
  assert.equal(f.counts.previews,1); assert.equal(f.counts.mutations,1)
  assert.equal(f.edits().A.status,'saved'); assert.equal(f.counts.refreshFailures,1)
  f.failReads(false); await f.preview(); f.coordinator.acceptPreview(f.coordinator.revision)
  assert.deepEqual(f.edits(),{})
})
test('continuous edits are bounded by five seconds when writes are settled', async () => {
  const f=fixture()
  for(let i=0;i<5;i++){ await f.coordinator.save(String(i),'FORCE_EXCLUDE'); await f.advance(1000) }
  assert.equal(f.counts.previews,1)
})
test('25 edits in five bursts use five full previews instead of 25', async () => {
  const f=fixture()
  for(let burst=0;burst<5;burst++) {
    for(let i=0;i<5;i++) {
      await f.coordinator.save(`${burst}-${i}`,i===4?'INHERIT':'FORCE_EXCLUDE')
      await f.advance(250)
    }
    await f.advance(2000)
  }
  assert.equal(f.counts.mutations,25)
  assert.equal(f.counts.previews,5)
  assert.equal(f.counts.fullSourceBuilds,5)
  assert.equal(f.counts.catalogReads,5)
  assert.equal(f.counts.inventoryReads,5)
  assert.equal(f.counts.pricingReads,5)
})
test('a manual authoritative preview consumes pending automatic refresh', async () => {
  const f=fixture(); await f.coordinator.save('A','FORCE_INCLUDE')
  await f.preview(); assert.equal(f.coordinator.acceptPreview(f.coordinator.revision),true)
  await f.advance(10000); assert.equal(f.counts.previews,1)
})
test('unmount cancels only reads; all mutation requests were already started', async () => {
  const f=fixture(); await f.coordinator.save('A','FORCE_EXCLUDE')
  f.coordinator.dispose(); await f.advance(10000)
  assert.equal(f.counts.mutations,1); assert.equal(f.stored.get('A'),'FORCE_EXCLUDE'); assert.equal(f.counts.previews,0)
})
test('pending writes block preview; same-product concurrent save is rejected', async () => {
  let finish!: () => void, mutations=0, previews=0
  const callbacks: Array<()=>void>=[]
  const c=createOverrideEditCoordinator<Mode>({
    write:()=>{mutations++;return new Promise<void>(resolve=>{finish=resolve})}, refresh:async()=>{previews++;return true}, changed:()=>{},refreshFailed:()=>{},
    schedule:cb=>{callbacks.push(cb);return 1},cancel:()=>{},now:()=>0,
  })
  const pending=c.save('A','FORCE_EXCLUDE'); await c.save('A','FORCE_INCLUDE')
  assert.equal(mutations,1); assert.equal(callbacks.length,0)
  assert.equal(c.acceptPreview(c.revision),false)
  finish(); await pending; callbacks[0](); await settle(); assert.equal(previews,1)
})
test('page changes use the latest loader; stale read cannot clear a newer edit', async () => {
  const f=fixture(); const oldRevision=f.coordinator.revision
  await f.coordinator.save('A','FORCE_EXCLUDE')
  assert.equal(f.coordinator.acceptPreview(oldRevision),false)
  assert.equal(f.edits().A.status,'saved')
  const source=readFileSync(new URL('../src/pages/ArukeresoProductsPage.tsx',import.meta.url),'utf8')
  assert.match(source,/refresh: \(\) => loadProductsRef.current\(\)/)
  assert.match(source,/readRevision === \(editCoordinator.current\?\.revision/)
  assert.match(source,/if \(!isCurrent\(\)\) return false/)
  assert.doesNotMatch(source,/feed\/generate/)
})
test('edit during preview rejects old completion and performs one final read', async () => {
  let callback=()=>{}, reads=0, finish!: (applied:boolean)=>void
  let edits: Record<string,OverrideEdit<Mode>>={}
  const c=createOverrideEditCoordinator<Mode>({
    write:async()=>{}, refresh:()=>{reads++;return new Promise<boolean>(resolve=>{finish=resolve})}, changed:next=>{edits=next},refreshFailed:()=>assert.fail('Stale response must not show failure'),
    schedule:cb=>{callback=cb;return 1},cancel:()=>{},now:()=>0,
  })
  await c.save('A','FORCE_EXCLUDE'); callback()
  assert.equal(reads,1)
  const oldRevision=c.revision
  await c.save('B','FORCE_INCLUDE')
  assert.equal(c.acceptPreview(oldRevision),false)
  finish(false);await settle()
  assert.equal(edits.A.status,'saved');assert.equal(edits.B.status,'saved')
  callback();assert.equal(reads,2)
  finish(true);await settle();assert.deepEqual(edits,{})
})
