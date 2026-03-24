/**
 * NDJSON Parser — newline-delimited JSON stream parser.
 *
 * Handles cross-chunk line buffering and incremental JSON parsing.
 * Identical pattern to codebuddy-provider.ts lines 351-367.
 */

/**
 * Parse a chunk of NDJSON data, yielding complete JSON objects.
 * Maintains an internal buffer for incomplete lines across chunks.
 */
export class NdjsonParser {
  private buffer = '';

  /**
   * Feed a chunk of data (from stdout.on('data')).
   * Returns an array of parsed JSON objects.
   */
  feed(chunk: string | Buffer): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const results: unknown[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        results.push(JSON.parse(line));
      } catch {
        // Incomplete or malformed JSON — skip this line.
        // In theory NDJSON guarantees one complete JSON per line,
        // but partial lines from stream fragmentation are handled by
        // keeping the remainder in buffer.
        console.warn('[ndjson] Failed to parse line:', line.slice(0, 200));
      }
    }

    return results;
  }

  /**
   * Flush any remaining data in the buffer (call on stream end).
   */
  flush(): unknown[] {
    if (!this.buffer.trim()) return [];
    const results: unknown[] = [];
    try {
      results.push(JSON.parse(this.buffer));
    } catch {
      // Last chunk was incomplete, discard.
    }
    this.buffer = '';
    return results;
  }

  /** Get remaining unprocessed data in buffer. */
  get remaining(): string {
    return this.buffer;
  }
}
