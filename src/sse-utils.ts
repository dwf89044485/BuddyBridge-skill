/**
 * SSE Utilities — helpers for formatting Server-Sent Event strings.
 *
 * Used by LLMProvider implementations to produce the SSE stream format
 * consumed by the bridge conversation engine.
 */

export function sseEvent(type: string, data: unknown): string {
  if (typeof data === 'string') {
    // Simple events (text, error, keep_alive): preserve `data` string field
    return `data: ${JSON.stringify({ type, data })}\n`;
  }
  // Structured events: spread object fields directly at top level (single-layer JSON)
  return `data: ${JSON.stringify({ type, ...(data as Record<string, unknown>) })}\n`;
}
