
import { existsSync, readFileSync } from 'node:fs'
import { apply } from '../index.js'

const before = existsSync('D:/aiwork/dsh通知/data/queue/inbound-state.json')
const handlers = []
const routes = new Map()
const ctx = {
  on(n, fn) { handlers.push([n, fn]); return () => {} },
  effect(fn) { fn() },
  logger: { info: (m) => console.log('INFO', m), warn: (m) => console.log('WARN', m) },
  get() { return undefined },
  inject(names, cb) { cb({ connection: { fetch: { register(r) { routes.set(r.path, r); return () => {} } } }, agents: { get: () => undefined } }) },
}
apply(ctx, { enabled: true, provider: 'wecom-robot', queueDir: 'D:/aiwork/dsh通知/data/queue', notifyOn: 'every-turn' })
await new Promise((r) => setTimeout(r, 800))
const after = existsSync('D:/aiwork/dsh通知/data/queue/inbound-state.json')
console.log('diag before=', before, 'after=', after)
if (after) console.log(readFileSync('D:/aiwork/dsh通知/data/queue/inbound-state.json', 'utf8'))
process.exit(0)