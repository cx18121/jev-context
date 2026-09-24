import assert from 'node:assert/strict';

export function validatedUsage(raw, prices) {
  const integer = (n) => Number.isSafeInteger(n) && n >= 0;
  assert.ok(raw && [raw.input_tokens, raw.output_tokens, raw.total_tokens, raw.input_tokens_details?.cached_tokens].every(integer), 'Missing/invalid provider usage');
  const cached = raw.input_tokens_details.cached_tokens;
  const write = raw.input_tokens_details.cache_write_tokens ?? 0;
  assert.ok(integer(write) && cached + write <= raw.input_tokens, 'Invalid provider cache counts');
  assert.equal(raw.total_tokens, raw.input_tokens + raw.output_tokens, 'Invalid provider total');
  assert.ok(raw.input_tokens > 0 && raw.input_tokens < (prices.tiers?.[0]?.inputTokensAbove ?? Infinity), 'Unsupported pricing tier or empty usage');
  const uncached = raw.input_tokens - cached - write;
  const cost = (uncached * prices.input + cached * prices.cacheRead + write * prices.cacheWrite + raw.output_tokens * prices.output) / 1e6;
  return { input: raw.input_tokens, output: raw.output_tokens, cached, write, uncached, catalogCostUsd: cost };
}
export function tapResponse(response, record, controller, prices, responseBytes) {
  if (!response.ok || !response.body) return response;
  let partial = '', bytes = 0, terminal = false;
  const decoder = new TextDecoder();
  function frames(text, eof = false) {
    partial = (partial + text).replace(/\r\n/g, '\n');
    if (eof && partial.trim()) partial += '\n\n';
    let end;
    while ((end = partial.indexOf('\n\n')) !== -1) {
      const frame = partial.slice(0, end); partial = partial.slice(end + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n').trim();
      if (!data || data === '[DONE]' || terminal) continue;
      const event = JSON.parse(data);
      if (['response.completed', 'response.done', 'response.incomplete'].includes(event.type)) {
        terminal = true; record.rawUsage = event.response?.usage ?? null;
        record.usage = validatedUsage(record.rawUsage, prices);
        record.providerStatus = event.response?.status;
      }
    }
  }
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, out) {
      bytes += chunk.byteLength;
      if (bytes > responseBytes) { controller.abort(); throw new Error('Response size ceiling'); }
      frames(decoder.decode(chunk, { stream: true })); out.enqueue(chunk);
    }, flush() { frames(decoder.decode(), true); },
  })), { status: response.status, headers: response.headers });
}
