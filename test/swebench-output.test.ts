import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolOutput } from '../eval/swebench/tool-output.ts';

function capture(data: Buffer, chunkSize = data.length || 1): string {
  const output = new ToolOutput();
  for (let offset = 0; offset < data.length; offset += chunkSize) output.append(data.subarray(offset, offset + chunkSize));
  return output.text();
}

function bounded(text: string) {
  assert.ok(Buffer.byteLength(text) <= 32000);
  assert.ok(text.split('\n').length <= 2000);
  assert.match(text, /Output truncated.*Narrow the command/);
  assert.ok(text.isWellFormed());
}

test('tool output preserves fitting text, empty output, and exact byte/line boundaries', () => {
  for (const text of ['', 'ordinary\noutput\n', '😀café\n', 'x'.repeat(32000), 'x\n'.repeat(1999) + 'x']) {
    assert.equal(capture(Buffer.from(text), 7), text);
  }
});

test('tool output retains a prefix from oversized chunks and discards all following data', () => {
  const output = new ToolOutput();
  output.append(Buffer.from('first\n' + 'x'.repeat(100000)));
  const expected = output.text();
  for (let n = 0; n < 100; n++) output.append(Buffer.alloc(65536, 'z'));
  assert.equal(output.text(), expected);
  assert.ok(expected.startsWith('first\n' + 'x'.repeat(1000)));
  bounded(expected);
  bounded(capture(Buffer.from('short\n'.repeat(5000))));
});

test('tool output bounds decoded invalid UTF-8 and does not split valid characters', () => {
  bounded(capture(Buffer.alloc(32000, 0xff)));
  const raw = Buffer.from('x' + '😀'.repeat(10000));
  const expected = capture(raw);
  for (const chunkSize of [1, 3, 4096, 65536]) assert.equal(capture(raw, chunkSize), expected);
  bounded(expected);
  assert.ok(!expected.includes('\ufffd'));
});
