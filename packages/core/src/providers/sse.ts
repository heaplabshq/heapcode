/**
 * Parses a text/event-stream body into the string payloads of its `data:` lines.
 * Yields each payload (e.g. an OpenAI chunk JSON string, or "[DONE]").
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) yield data;
        }
      }
    }
    // Flush a final data line that arrived without a trailing newline.
    const rest = buffer.replace(/\r$/, '');
    if (rest.startsWith('data:')) {
      const data = rest.slice(5).trim();
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}
