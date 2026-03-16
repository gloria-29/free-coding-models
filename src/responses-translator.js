/**
 * @file src/responses-translator.js
 * @description Bidirectional translation between the OpenAI Responses API wire format
 * and the older OpenAI Chat Completions wire used by the upstream free providers.
 *
 * @details
 *   📖 Codex CLI can speak either `responses` or `chat` depending on provider config.
 *   📖 Our upstream accounts still expose `/chat/completions`, so this module converts:
 *   - Responses requests → Chat Completions requests
 *   - Chat Completions JSON/SSE responses → Responses JSON/SSE responses
 *
 *   📖 The implementation focuses on the items Codex actually uses:
 *   - `instructions` / `input` message history
 *   - function tools + function-call outputs
 *   - assistant text deltas
 *   - function call argument deltas
 *   - final `response.completed` payload with usage
 *
 * @functions
 *   → `translateResponsesToOpenAI` — convert a Responses request body to chat completions
 *   → `translateOpenAIToResponses` — convert a chat completions JSON response to Responses JSON
 *   → `createResponsesSSETransformer` — convert chat-completions SSE chunks to Responses SSE
 *
 * @exports translateResponsesToOpenAI, translateOpenAIToResponses, createResponsesSSETransformer
 * @see src/proxy-server.js
 */

import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'

const MAX_SSE_BUFFER = 1 * 1024 * 1024

function serializeJsonish(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return String(value ?? '')
  }
}

function normalizeResponseContent(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }]
  if (!Array.isArray(content)) return []
  return content
}

function contentPartToText(part) {
  if (!part || typeof part !== 'object') return ''
  if (typeof part.text === 'string') return part.text
  if (part.type === 'reasoning' && typeof part.summary === 'string') return part.summary
  return ''
}

function pushTextMessage(messages, role, textParts) {
  const text = textParts.join('\n').trim()
  if (!text && role !== 'assistant') return
  messages.push({ role, content: text || '' })
}

function makeFunctionToolCall(entry = {}) {
  const callId = entry.call_id || entry.id || `call_${randomUUID().replace(/-/g, '')}`
  return {
    id: callId,
    type: 'function',
    function: {
      name: entry.name || entry.function?.name || '',
      arguments: typeof entry.arguments === 'string'
        ? entry.arguments
        : serializeJsonish(entry.arguments || entry.function?.arguments || {}),
    },
  }
}

export function translateResponsesToOpenAI(body) {
  if (!body || typeof body !== 'object') return { model: '', messages: [], stream: false }

  const messages = []

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions.trim() })
  }

  const inputItems = Array.isArray(body.input)
    ? body.input
    : body.input != null
      ? [body.input]
      : []

  for (const item of inputItems) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item })
      continue
    }
    if (!item || typeof item !== 'object') continue

    if (item.type === 'function_call') {
      messages.push({ role: 'assistant', content: null, tool_calls: [makeFunctionToolCall(item)] })
      continue
    }

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: serializeJsonish(item.output),
      })
      continue
    }

    if (item.type === 'input_text' && typeof item.text === 'string') {
      messages.push({ role: 'user', content: item.text })
      continue
    }

    if (item.type !== 'message') continue

    const role = item.role === 'assistant'
      ? 'assistant'
      : (item.role === 'developer' || item.role === 'system')
          ? 'system'
          : 'user'

    const textParts = []
    const toolCalls = []
    for (const part of normalizeResponseContent(item.content)) {
      if (part.type === 'function_call') {
        toolCalls.push(makeFunctionToolCall(part))
        continue
      }
      if (part.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: part.call_id || part.id || '',
          content: serializeJsonish(part.output),
        })
        continue
      }
      const text = contentPartToText(part)
      if (text) textParts.push(text)
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
        tool_calls: toolCalls,
      })
      continue
    }

    pushTextMessage(messages, role, textParts)
  }

  const result = {
    model: body.model,
    messages,
    stream: body.stream === true,
  }

  if (body.max_output_tokens != null) result.max_tokens = body.max_output_tokens
  if (body.temperature != null) result.temperature = body.temperature
  if (body.top_p != null) result.top_p = body.top_p

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = body.tools
      .filter(tool => tool && typeof tool === 'object' && (tool.type === 'function' || typeof tool.name === 'string'))
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name || tool.function?.name || '',
          description: tool.description || tool.function?.description || '',
          parameters: tool.parameters || tool.input_schema || tool.function?.parameters || {},
        },
      }))
  }

  return result
}

function buildResponsesOutput(message = {}) {
  const output = []
  const text = typeof message.content === 'string' ? message.content : ''
  if (text || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: text || '', annotations: [] }],
    })
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const callId = toolCall?.id || `call_${randomUUID().replace(/-/g, '')}`
      output.push({
        id: callId,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name: toolCall?.function?.name || '',
        arguments: toolCall?.function?.arguments || '{}',
      })
    }
  }

  return output
}

export function translateOpenAIToResponses(openaiResponse, requestModel) {
  const choice = openaiResponse?.choices?.[0] || {}
  const message = choice?.message || {}
  const inputTokens = openaiResponse?.usage?.prompt_tokens || 0
  const outputTokens = openaiResponse?.usage?.completion_tokens || 0

  return {
    id: openaiResponse?.id || `resp_${randomUUID().replace(/-/g, '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: requestModel || openaiResponse?.model || '',
    output: buildResponsesOutput(message),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  }
}

function createResponseSseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

export function createResponsesSSETransformer(requestModel) {
  let buffer = ''
  let responseId = `resp_${randomUUID().replace(/-/g, '')}`
  let messageItemId = `msg_${randomUUID().replace(/-/g, '')}`
  let createdAt = Math.floor(Date.now() / 1000)
  let createdSent = false
  let messageAdded = false
  let messageText = ''
  let promptTokens = 0
  let completionTokens = 0
  const functionCalls = new Map()

  const ensureStarted = (stream) => {
    if (createdSent) return
    createdSent = true
    stream.push(createResponseSseEvent('response.created', {
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        model: requestModel || '',
        output: [],
      },
    }))
  }

  const ensureMessageItem = (stream) => {
    if (messageAdded) return
    messageAdded = true
    stream.push(createResponseSseEvent('response.output_item.added', {
      output_index: 0,
      item: {
        id: messageItemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      },
    }))
  }

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString()
      if (buffer.length > MAX_SSE_BUFFER) {
        buffer = ''
        return callback(new Error('Responses SSE buffer overflow'))
      }

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()

        if (payload === '[DONE]') {
          ensureStarted(this)
          ensureMessageItem(this)

          const output = [{
            id: messageItemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: messageText, annotations: [] }],
          }]
          this.push(createResponseSseEvent('response.output_item.done', {
            output_index: 0,
            item: output[0],
          }))

          const sortedCalls = [...functionCalls.entries()].sort((a, b) => a[0] - b[0])
          for (const [index, call] of sortedCalls) {
            const item = {
              id: call.id,
              type: 'function_call',
              status: 'completed',
              call_id: call.id,
              name: call.name,
              arguments: call.arguments,
            }
            output.push(item)
            this.push(createResponseSseEvent('response.output_item.done', {
              output_index: index + 1,
              item,
            }))
          }

          this.push(createResponseSseEvent('response.completed', {
            response: {
              id: responseId,
              object: 'response',
              created_at: createdAt,
              status: 'completed',
              model: requestModel || '',
              output,
              usage: {
                input_tokens: promptTokens,
                output_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            },
          }))
          continue
        }

        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }

        if (typeof parsed.id === 'string' && parsed.id.length > 0) responseId = parsed.id
        if (typeof parsed.model === 'string' && parsed.model.length > 0 && !requestModel) {
          requestModel = parsed.model
        }
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens || promptTokens
          completionTokens = parsed.usage.completion_tokens || completionTokens
        }

        ensureStarted(this)
        const choice = parsed.choices?.[0]
        if (!choice) continue
        const delta = choice.delta || {}

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          ensureMessageItem(this)
          messageText += delta.content
          this.push(createResponseSseEvent('response.output_text.delta', {
            output_index: 0,
            item_id: messageItemId,
            content_index: 0,
            delta: delta.content,
          }))
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCallDelta of delta.tool_calls) {
            const callIndex = Number.isInteger(toolCallDelta.index) ? toolCallDelta.index : functionCalls.size
            const existing = functionCalls.get(callIndex) || {
              id: toolCallDelta.id || `call_${randomUUID().replace(/-/g, '')}`,
              name: '',
              arguments: '',
              added: false,
            }
            if (typeof toolCallDelta.id === 'string' && toolCallDelta.id.length > 0) {
              existing.id = toolCallDelta.id
            }
            if (typeof toolCallDelta.function?.name === 'string' && toolCallDelta.function.name.length > 0) {
              existing.name = toolCallDelta.function.name
            }
            if (!existing.added) {
              existing.added = true
              this.push(createResponseSseEvent('response.output_item.added', {
                output_index: callIndex + 1,
                item: {
                  id: existing.id,
                  type: 'function_call',
                  status: 'in_progress',
                  call_id: existing.id,
                  name: existing.name,
                  arguments: existing.arguments,
                },
              }))
            }
            if (typeof toolCallDelta.function?.arguments === 'string' && toolCallDelta.function.arguments.length > 0) {
              existing.arguments += toolCallDelta.function.arguments
              this.push(createResponseSseEvent('response.function_call_arguments.delta', {
                output_index: callIndex + 1,
                item_id: existing.id,
                delta: toolCallDelta.function.arguments,
              }))
            }
            functionCalls.set(callIndex, existing)
          }
        }
      }

      callback()
    },
  })

  return { transform }
}
