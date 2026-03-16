/**
 * @file src/anthropic-translator.js
 * @description Bidirectional wire format translation between Anthropic Messages API
 * and OpenAI Chat Completions API.
 *
 * 📖 This is the key module that enables Claude Code to work natively through the
 *    FCM proxy without needing the external "free-claude-code" Python proxy.
 *    Claude Code sends requests in Anthropic format (POST /v1/messages) and this
 *    module translates them to OpenAI format for the upstream providers, then
 *    translates the responses back.
 *
 * 📖 Supports both JSON and SSE streaming modes.
 *
 * @functions
 *   → translateAnthropicToOpenAI(body) — Convert Anthropic Messages request → OpenAI chat completions
 *   → translateOpenAIToAnthropic(openaiResponse, requestModel) — Convert OpenAI JSON response → Anthropic
 *   → createAnthropicSSETransformer(requestModel) — Create a Transform stream for SSE translation
 *   → estimateAnthropicTokens(body) — Fast local token estimate for `/v1/messages/count_tokens`
 *
 * @exports translateAnthropicToOpenAI, translateOpenAIToAnthropic, createAnthropicSSETransformer, estimateAnthropicTokens
 * @see src/proxy-server.js — routes /v1/messages through this translator
 */

import { Transform } from 'node:stream'
import { randomUUID } from 'node:crypto'

function normalizeThinkingText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block.text === 'string' && block.text) return block.text
  if (typeof block.thinking === 'string' && block.thinking) return block.thinking
  if (typeof block.summary === 'string' && block.summary) return block.summary
  return ''
}

function contentBlocksToText(blocks, { includeThinking = false } = {}) {
  return blocks
    .map((block) => {
      if (block?.type === 'thinking' && includeThinking) {
        const thinkingText = normalizeThinkingText(block)
        return thinkingText ? `<thinking>${thinkingText}</thinking>` : ''
      }
      if (block?.type === 'redacted_thinking' && includeThinking) {
        return '<thinking>[redacted]</thinking>'
      }
      return block?.type === 'text' ? block.text : ''
    })
    .filter(Boolean)
}

function extractReasoningBlocks(message = {}) {
  if (Array.isArray(message.reasoning)) {
    return message.reasoning
      .map((entry) => normalizeThinkingText(entry))
      .filter(Boolean)
      .map((text) => ({ type: 'thinking', thinking: text }))
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    return [{ type: 'thinking', thinking: message.reasoning_content.trim() }]
  }
  return []
}

/**
 * 📖 Translate an Anthropic Messages API request body to OpenAI Chat Completions format.
 *
 * Anthropic format:
 *   { model, messages: [{role, content}], system, max_tokens, stream, temperature, top_p, stop_sequences }
 *
 * OpenAI format:
 *   { model, messages: [{role, content}], max_tokens, stream, temperature, top_p, stop }
 *
 * @param {object} body — Anthropic request body
 * @returns {object} — OpenAI-compatible request body
 */
export function translateAnthropicToOpenAI(body) {
  // 📖 Guard against null/undefined/non-object input
  if (!body || typeof body !== 'object') return { model: '', messages: [], stream: false }
  if (!Array.isArray(body.messages)) body = { ...body, messages: [] }

  const openaiMessages = []

  // 📖 Anthropic "system" field → OpenAI system message
  if (body.system) {
    if (typeof body.system === 'string') {
      openaiMessages.push({ role: 'system', content: body.system })
    } else if (Array.isArray(body.system)) {
      // 📖 Anthropic supports system as array of content blocks
      const text = contentBlocksToText(body.system, { includeThinking: true }).join('\n\n')
      if (text) openaiMessages.push({ role: 'system', content: text })
    }
  }

  // 📖 Convert Anthropic messages to OpenAI format
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user'

      if (typeof msg.content === 'string') {
        openaiMessages.push({ role, content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // 📖 Anthropic content blocks: [{type: "text", text: "..."}, {type: "tool_result", ...}]
        const textParts = contentBlocksToText(msg.content, { includeThinking: true })
        const toolResults = msg.content.filter(b => b.type === 'tool_result')
        const toolUses = msg.content.filter(b => b.type === 'tool_use')

        // 📖 Tool use blocks (assistant) → OpenAI tool_calls
        if (toolUses.length > 0 && role === 'assistant') {
          const toolCalls = toolUses.map(tu => ({
            id: tu.id || randomUUID(),
            type: 'function',
            function: {
              name: tu.name,
              arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
            }
          }))
          openaiMessages.push({
            role: 'assistant',
            content: textParts.join('\n') || null,
            tool_calls: toolCalls,
          })
        }
        // 📖 Tool result blocks (user) → OpenAI tool messages
        else if (toolResults.length > 0) {
          // 📖 First push any text parts as user message
          if (textParts.length > 0) {
            openaiMessages.push({ role: 'user', content: textParts.join('\n') })
          }
          for (const tr of toolResults) {
            const content = typeof tr.content === 'string'
              ? tr.content
              : Array.isArray(tr.content)
                ? tr.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : JSON.stringify(tr.content || '')
            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id || tr.id || '',
              content,
            })
          }
        }
        // 📖 Plain text content blocks → join into single message
        else if (textParts.length > 0) {
          openaiMessages.push({ role, content: textParts.join('\n') })
        }
      }
    }
  }

  const result = {
    model: body.model,
    messages: openaiMessages,
    stream: body.stream === true,
  }

  // 📖 Map Anthropic parameters to OpenAI equivalents
  if (body.max_tokens != null) result.max_tokens = body.max_tokens
  if (body.temperature != null) result.temperature = body.temperature
  if (body.top_p != null) result.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    result.stop = body.stop_sequences
  }

  // 📖 Map Anthropic tools to OpenAI function tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || {},
      }
    }))
  }

  return result
}

/**
 * 📖 Translate an OpenAI Chat Completions JSON response to Anthropic Messages format.
 *
 * @param {object} openaiResponse — parsed OpenAI response
 * @param {string} requestModel — model name from the original request
 * @returns {object} — Anthropic Messages response
 */
export function translateOpenAIToAnthropic(openaiResponse, requestModel) {
  const choice = openaiResponse.choices?.[0]
  const message = choice?.message || {}
  const content = []

  for (const reasoningBlock of extractReasoningBlocks(message)) {
    content.push(reasoningBlock)
  }

  // 📖 Text content → Anthropic text block
  if (message.content) {
    content.push({ type: 'text', text: message.content })
  }

  // 📖 Tool calls → Anthropic tool_use blocks
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function?.arguments || '{}') } catch { /* ignore */ }
      content.push({
        type: 'tool_use',
        id: tc.id || randomUUID(),
        name: tc.function?.name || '',
        input,
      })
    }
  }

  // 📖 Fallback: Anthropic requires at least one content block — provide empty text if none
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  // 📖 Map OpenAI finish_reason → Anthropic stop_reason
  let stopReason = 'end_turn'
  if (choice?.finish_reason === 'stop') stopReason = 'end_turn'
  else if (choice?.finish_reason === 'length') stopReason = 'max_tokens'
  else if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use'

  return {
    id: openaiResponse.id || `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel || openaiResponse.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  }
}

/**
 * 📖 Create a Transform stream that converts OpenAI SSE chunks to Anthropic SSE format.
 *
 * OpenAI SSE:
 *   data: {"choices":[{"delta":{"content":"Hello"}}]}
 *
 * Anthropic SSE:
 *   event: message_start
 *   data: {"type":"message_start","message":{...}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * @param {string} requestModel — model from original request
 * @returns {{ transform: Transform, getUsage: () => object }}
 */
// 📖 Max SSE buffer size to prevent memory exhaustion from malformed streams (1 MB)
const MAX_SSE_BUFFER = 1 * 1024 * 1024

export function createAnthropicSSETransformer(requestModel) {
  let headerSent = false
  // 📖 Track block indices for proper content_block_start/stop/delta indexing.
  // nextBlockIndex increments for each new content block (text or tool_use).
  // currentBlockIndex tracks the index of the most recently opened block.
  let nextBlockIndex = 0
  let currentBlockIndex = -1
  let inputTokens = 0
  let outputTokens = 0
  let buffer = ''

  const transform = new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString()
      // 📖 Guard against unbounded buffer growth from malformed SSE streams
      if (buffer.length > MAX_SSE_BUFFER) {
        buffer = ''
        return callback(new Error('SSE buffer overflow'))
      }
      const lines = buffer.split('\n')
      // 📖 Keep the last incomplete line in the buffer
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') {
          // 📖 End of stream — close any open block, then send message_delta + message_stop
          if (currentBlockIndex >= 0) {
            this.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex })}\n\n`)
            currentBlockIndex = -1
          }
          this.push(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokens },
          })}\n\n`)
          this.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
          continue
        }

        let parsed
        try { parsed = JSON.parse(payload) } catch { continue }

        // 📖 Send message_start header on first chunk
        if (!headerSent) {
          headerSent = true
          this.push(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: parsed.id || `msg_${randomUUID().replace(/-/g, '')}`,
              type: 'message',
              role: 'assistant',
              content: [],
              model: requestModel || parsed.model || '',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          })}\n\n`)
        }

        const choice = parsed.choices?.[0]
        if (!choice) continue
        const delta = choice.delta || {}

        // 📖 Track usage if present
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || inputTokens
          outputTokens = parsed.usage.completion_tokens || outputTokens
        }

        // 📖 Text delta
        if (delta.content) {
          if (currentBlockIndex < 0 || nextBlockIndex === 0) {
            // 📖 Open first text block
            currentBlockIndex = nextBlockIndex++
            this.push(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: { type: 'text', text: '' },
            })}\n\n`)
          }
          this.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          })}\n\n`)
        }

        // 📖 Tool call deltas (if model supports tool use)
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (tc.function?.name) {
              // 📖 New tool call — close previous block if open, then start new one
              if (currentBlockIndex >= 0) {
                this.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex })}\n\n`)
              }
              currentBlockIndex = nextBlockIndex++
              this.push(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id || randomUUID(),
                  name: tc.function.name,
                  input: {},
                },
              })}\n\n`)
            }
            if (tc.function?.arguments) {
              this.push(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: currentBlockIndex >= 0 ? currentBlockIndex : 0,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              })}\n\n`)
            }
          }
        }

        // 📖 Handle finish_reason for tool_calls — close ALL open blocks
        if (choice.finish_reason === 'tool_calls' && currentBlockIndex >= 0) {
          this.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex })}\n\n`)
          currentBlockIndex = -1
        }
      }
      callback()
    },

    flush(callback) {
      // 📖 Process any remaining buffer
      if (buffer.trim()) {
        // ignore incomplete data
      }
      callback()
    },
  })

  return {
    transform,
    getUsage: () => ({ input_tokens: inputTokens, output_tokens: outputTokens }),
  }
}

function estimateTokenCountFromText(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return 0
  return Math.ceil(normalized.length / 4)
}

export function estimateAnthropicTokens(body) {
  const openaiBody = translateAnthropicToOpenAI(body)
  const messageTokens = Array.isArray(openaiBody.messages)
    ? openaiBody.messages.reduce((total, message) => {
        let nextTotal = total + 4
        if (typeof message.content === 'string') {
          nextTotal += estimateTokenCountFromText(message.content)
        }
        if (Array.isArray(message.tool_calls)) {
          for (const toolCall of message.tool_calls) {
            nextTotal += estimateTokenCountFromText(toolCall.function?.name || '')
            nextTotal += estimateTokenCountFromText(toolCall.function?.arguments || '')
          }
        }
        if (typeof message.tool_call_id === 'string') {
          nextTotal += estimateTokenCountFromText(message.tool_call_id)
        }
        return nextTotal
      }, 2)
    : 0

  const toolTokens = Array.isArray(body?.tools)
    ? body.tools.reduce((total, tool) => total + estimateTokenCountFromText(JSON.stringify(tool || {})), 0)
    : 0

  return messageTokens + toolTokens
}
