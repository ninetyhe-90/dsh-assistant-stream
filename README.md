# dsh-assistant-stream

A small [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that mirrors
assistant streaming activity to an NDJSON sink, so another process can consume tokens, block
boundaries, commits, and turn fences as they happen.

## What it emits

One JSON object per line, prefixed with `ASSISTANT_STREAM_V1 `:

```text
ASSISTANT_STREAM_V1 {"version":1,"sessionId":"s1","requestId":"r1","turn":1,"attemptId":"s1:1","seq":0,"op":"start","step":1}
```

| `op` | Meaning |
|---|---|
| `turn-start` / `turn-end` | Turn boundaries, emitted for the root session only |
| `start` | A model attempt began; `seq` restarts at 0 per attempt |
| `delta` | Incremental `text` or `reasoning` text |
| `block` | A completed text or reasoning block |
| `commit` | The committed assistant message for this attempt |
| `event-fence` | Ordering marker for tool calls, tool results, and usage commits |
| `end` | The attempt finished, with its outcome |

Subagent sessions (`parentSession` or `origin: "subagent"`) are never exported.

## Usage

```js
import * as plugin from 'dsh-assistant-stream'

export default {
  name: plugin.name,
  apply: (ctx) => plugin.apply(ctx, {
    // Optional: resolve the request id for the current turn.
    readTurnId: () => process.env.TURN_ID,
    // Optional: capture frames yourself; defaults to process.stderr.
    write: line => process.stdout.write(line),
  }),
}
```

Without `readTurnId`, the plugin reads `DSH_TURN_ID` and fails loudly when it is empty.

## Install

```sh
dsh plugin --profile <name> add dsh-assistant-stream
```

The package ships a `cordis.patch.yml` bundle layer that inserts the plugin row. To install from a
local checkout instead:

```sh
dsh plugin --profile <name> add /path/to/dsh-assistant-stream
```

Requires a DSH build that emits `agent/assistant-stream` and `session/event` (0.2.x). When neither
`readTurnId` nor `DSH_TURN_ID` is provided, `requestId` falls back to the session id.

## Requirements

- Node.js 20.11+

## Test

```sh
npm test
npm run check
```

## License

MIT
