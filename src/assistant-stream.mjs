import { writeSync } from 'node:fs'

export const name = 'dsh-assistant-stream'
export const PREFIX = 'ASSISTANT_STREAM_V1 '

/**
 * Mirror assistant streaming frames to an NDJSON sink.
 *
 * The sink is the process stderr by default; pass `config.write` to capture the
 * lines elsewhere. Each frame carries the session id, the request id resolved
 * for the current turn, the turn number, and a dense per-attempt sequence.
 */
export function apply(ctx, config = {}) {
  const write = config.write ?? (line => {
    const bytes = Buffer.from(line)
    for (let offset = 0; offset < bytes.length;) offset += writeSync(2, bytes, offset, bytes.length - offset)
  })
  const attempts = new WeakMap()
  const turns = new WeakMap()
  const readTurnId = config.readTurnId ?? (() => process.env.DSH_TURN_ID?.trim() || undefined)

  function emit(agent, state, payload) {
    let turn = turns.get(agent.session)
    if (turn === undefined) {
      turn = { requestId: readTurnId() || agent.session.id, turn: state.turn, nextFence: 0 }
      turns.set(agent.session, turn)
    }
    write(PREFIX + JSON.stringify({
      version: 1, sessionId: agent.session.id, requestId: turn.requestId, turn: turn.turn,
      attemptId: state.attemptId, seq: state.seq++, ...payload,
    }) + '\n')
  }

  function exported(agent) {
    const header = agent.session.header
    return header.parentSession === undefined && header.origin !== 'subagent'
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!exported(agent)) return
    if (frame.type === 'start') {
      // An attempt may end without its terminal frame; replace it instead of rejecting
      // the new one, so one broken stream cannot block later attempts.
      const state = { attemptId: frame.attemptId, seq: 0, turn: frame.turn, step: frame.step }
      attempts.set(agent.session, state)
      emit(agent, state, { op: 'start', turn: frame.turn, step: frame.step })
      return
    }
    const state = attempts.get(agent.session)
    if (state === undefined) throw new Error('assistant stream frame without start')
    if (state.attemptId !== frame.attemptId) throw new Error('assistant stream attempt mismatch')
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
        emit(agent, state, { op: 'delta', kind: chunk.type === 'text-delta' ? 'text' : 'reasoning', index: chunk.index, text: chunk.text })
      } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
        emit(agent, state, { op: 'block', kind: chunk.block.type, index: chunk.index, text: chunk.block.text })
      }
    } else if (frame.type === 'end') {
      emit(agent, state, { op: 'end', outcome: frame.outcome })
      attempts.delete(agent.session)
    } else {
      throw new Error('unsupported assistant stream frame type: ' + frame.type)
    }
  })

  ctx.on('session/event', (session, event) => {
    if (!exported({ session })) return
    if (event.type === 'turn/start') {
      // A previous turn may close without turn/end; reset its state instead of rejecting.
      turns.delete(session)
      attempts.delete(session)
      emit({ session }, { attemptId: '', seq: 0, turn: event.data.turn }, { op: 'turn-start' })
      return
    }
    if (event.type === 'turn/end') {
      emit({ session }, { attemptId: '', seq: 0, turn: event.data.turn }, { op: 'turn-end' })
      turns.delete(session)
      attempts.delete(session)
      return
    }
    function fence(key) {
      const turn = turns.get(session)
      if (turn === undefined) return
      emit({ session }, { attemptId: '', seq: 0, turn: turn.turn }, { op: 'event-fence', key, fence: turn.nextFence++ })
    }
    if (event.type === 'tool/call') {
      fence('call:' + event.data.callId)
      return
    }
    if (event.type === 'tool/result') {
      fence('result:' + event.data.message.toolCallId)
      return
    }
    const state = attempts.get(session)
    if (state === undefined || event.type !== 'assistant/message') return
    if (event.data.turn !== state.turn || event.data.step !== state.step) throw new Error('assistant commit turn/step mismatch')
    const blocks = event.data.message.content
      .filter(block => block.type === 'text' || block.type === 'reasoning')
      .map(block => ({ kind: block.type, text: block.text }))
    emit({ session }, state, {
      op: 'commit', messageId: event.data.message.id, blocks,
      interrupted: event.data.interrupted === true,
    })
    if (event.data.usage !== undefined && session.requestContext?.()?.contextWindow !== undefined && ctx.get('tokenMeter') !== undefined) {
      fence('usage')
    }
  })
}
