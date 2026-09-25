const MAX_BYTES = 32000;
const MAX_LINES = 2000;
const NOTICE = '\n\n[Output truncated to fit 32000 bytes or 2000 lines. Narrow the command and rerun. Full output was not saved.]';

/** Bound display memory without interrupting the command or persisting its discarded output. */
export class ToolOutput {
  private readonly prefix = Buffer.alloc(MAX_BYTES);
  private length = 0;
  private overflow = false;

  append(chunk: Buffer) {
    const kept = chunk.copy(this.prefix, this.length);
    this.length += kept;
    this.overflow ||= kept < chunk.length;
  }

  text(): string {
    // Do not turn a UTF-8 character cut by the raw byte ceiling into a replacement character.
    const text = new TextDecoder().decode(this.prefix.subarray(0, this.length), { stream: this.overflow });
    if (!this.overflow && Buffer.byteLength(text) <= MAX_BYTES && text.split('\n').length <= MAX_LINES) return text;

    // Invalid UTF-8 can expand on decoding. Bound the final encoded text, including the notice.
    let bytes = Buffer.byteLength(NOTICE);
    let lines = NOTICE.split('\n').length;
    let end = 0;
    for (const char of text) {
      bytes += Buffer.byteLength(char);
      if (char === '\n') lines++;
      if (bytes > MAX_BYTES || lines > MAX_LINES) break;
      end += char.length;
    }
    return text.slice(0, end) + NOTICE;
  }
}
