import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, PREFIX } from '../src/assistant-stream.mjs'

function harness(header = { id: 's1' }) {
  const listeners = new Map()
  const lines = []
  const ctx = { on: (name, handler) => { listeners.set(name, handler) } }
  apply(ctx, { readTurnId: () => 'r1', write: line => lines.push(line) })
  const agent = { session: { id: header.id, header } }
  return {
    frame: frame => listeners.get('agent/assistant-stream')({ agent, frame }),
    event: event => listeners.get('session/event')(agent.session, event),
    packets: () => lines.map(line => {
      assert.ok(line.startsWith(PREFIX))
      assert.ok(line.endsWith('\n'))
      assert.equal(line.slice(0, -1).includes('\n'), false)
      return JSON.parse(line.slice(PREFIX.length))
    }),
  }
}

const start = { type: 'start', attemptId: 's1:1', revision: 1, turn: 1, step: 1 }
const chunk = (index, payload) => ({ type: 'chunk', attemptId: 's1:1', revision: index + 2, index, chunk: payload })
const committed = content => ({ type: 'assistant/message', seq: 9, data: { turn: 1, step: 1, message: { id: 'm1', content } } })

test('deltas arrive before commit with session, attempt and dense wire sequence', () => {
  const h = harness()
  h.frame(start)
  h.frame(chunk(0, { type: 'reasoning-delta', index: 0, text: '中文\n思考' }))
  h.frame(chunk(1, { type: 'text-delta', index: 1, text: '回答' }))
  assert.deepEqual(h.packets().map(p => p.op), ['start', 'delta', 'delta'])
  h.event(committed([{ type: 'reasoning', text: '中文\n思考' }, { type: 'text', text: '回答' }]))
  h.frame({ type: 'end', attemptId: 's1:1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } })
  const packets = h.packets()
  assert.deepEqual(packets.map(p => p.seq), [0, 1, 2, 3, 4])
  assert.ok(packets.every(p => p.sessionId === 's1' && p.attemptId === 's1:1' && p.version === 1))
  assert.equal(packets[1].text, '中文\n思考')
  assert.equal(packets[3].messageId, 'm1')
  assert.deepEqual(packets[3].blocks, [{ kind: 'reasoning', text: '中文\n思考' }, { kind: 'text', text: '回答' }])
})

test('non-text chunks are not leaked; block-end reconciles delta-only output', () => {
  const h = harness()
  h.frame(start)
  h.frame(chunk(0, { type: 'tool-call-delta', index: 0, arguments: 'secret' }))
  h.frame(chunk(1, { type: 'usage', usage: { inputTokens: 3 } }))
  h.frame(chunk(2, { type: 'block-end', index: 1, block: { type: 'text', text: '完整' } }))
  assert.deepEqual(h.packets().map(p => p.op), ['start', 'block'])
  assert.equal(h.packets()[1].text, '完整')
  assert.equal(JSON.stringify(h.packets()).includes('secret'), false)
})

test('subagents are not exported', () => {
  for (const header of [{ id: 's1', parentSession: 'root' }, { id: 's1', origin: 'subagent' }]) {
    const h = harness(header)
    h.frame(start)
    h.frame(chunk(0, { type: 'text-delta', index: 0, text: 'child' }))
    assert.deepEqual(h.packets(), [])
  }
})

test('failed attempts and retries keep separate identities', () => {
  const h = harness()
  h.frame(start)
  h.frame(chunk(0, { type: 'text-delta', index: 0, text: '失败前缀' }))
  h.frame({ type: 'end', attemptId: 's1:1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 9 } })
  h.frame({ ...start, attemptId: 's1:2', revision: 4 })
  assert.equal(h.packets()[2].outcome.eventType, 'assistant/attempt')
  assert.equal(h.packets()[3].attemptId, 's1:2')
  assert.equal(h.packets()[3].seq, 0)
})

test('interrupted message is committed before attempt end', () => {
  const h = harness()
  h.frame(start)
  h.frame(chunk(0, { type: 'reasoning-delta', index: 0, text: '前缀' }))
  const event = committed([{ type: 'reasoning', text: '前缀' }])
  event.data.interrupted = true
  h.event(event)
  assert.equal(h.packets()[2].interrupted, true)
})

test('turn fences close and reread the request id for the next turn', () => {
  const handlers = new Map()
  const lines = []
  let requestId = 'r1'
  apply({ on: (name, handler) => handlers.set(name, handler) }, {
    readTurnId: () => requestId, write: line => lines.push(JSON.parse(line.slice(PREFIX.length))),
  })
  const session = { id: 's1', header: {} }
  handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 1 } })
  handlers.get('session/event')(session, { type: 'turn/end', data: { turn: 1 } })
  requestId = 'r2'
  handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(lines.map(p => [p.op, p.requestId, p.turn]), [
    ['turn-start', 'r1', 1], ['turn-end', 'r1', 1], ['turn-start', 'r2', 2],
  ])
})

test('transport failure and malformed frame propagate, never silently downgrade', () => {
  const ctx = { handlers: new Map(), on(name, fn) { this.handlers.set(name, fn) } }
  apply(ctx, { readTurnId: () => 'r1', write() { throw new Error('stderr closed') } })
  assert.throws(() => ctx.handlers.get('agent/assistant-stream')({ agent: { session: { id: 's1', header: {} } }, frame: start }), /stderr closed/)
  const h = harness()
  assert.throws(() => h.frame(chunk(0, { type: 'text-delta', index: 0, text: 'orphan' })), /without start/)
  h.frame(start)
  assert.throws(() => h.frame({ ...chunk(0, { type: 'text-delta', index: 0, text: 'x' }), attemptId: 'other' }), /attempt/)
})
