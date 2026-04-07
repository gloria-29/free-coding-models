/**
 * @file web/src/hooks/useSSE.js
 * @description React hook for SSE (Server-Sent Events) connection.
 * 📖 Connects to /api/events, auto-reconnects on failure, returns live model data.
 * → useSSE
 */
import { useState, useEffect, useRef, useCallback } from 'react'

export function useSSE(url = '/api/events') {
  const [models, setModels] = useState([])
  const [connected, setConnected] = useState(false)
  const [updateCount, setUpdateCount] = useState(0)
  const esRef = useRef(null)
  const reconnectTimer = useRef(null)

  const connect = useCallback(() => {
    if (esRef.current) esRef.current.close()

    const es = new EventSource(url)
    esRef.current = es

    es.onopen = () => setConnected(true)
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        setModels(data)
        setUpdateCount((c) => c + 1)
      } catch (e) {
        console.error('SSE parse error:', e)
      }
    }
    es.onerror = () => {
      setConnected(false)
      es.close()
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(connect, 3000)
    }
  }, [url])

  useEffect(() => {
    connect()
    return () => {
      esRef.current?.close()
      clearTimeout(reconnectTimer.current)
    }
  }, [connect])

  return { models, connected, updateCount }
}
