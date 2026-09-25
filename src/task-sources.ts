import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { SketchSource } from './task-sketch.ts';

export const INSTRUCTION_SOURCE_ENTRY = 'jev-context/instruction-source';

function contentText(content: string | { type: string; text?: string }[]): string {
  return (typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')).toWellFormed();
}

/** Persistent task text only. Normalize once, before either hashing or chunking derived state. */
export function taskSources(branch: readonly SessionEntry[]): SketchSource[] {
  const sources: SketchSource[] = [];
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === INSTRUCTION_SOURCE_ENTRY) {
      const data = entry.data as { version?: unknown; text?: unknown } | undefined;
      if (data?.version !== 1 || typeof data.text !== 'string') throw new Error('Invalid instruction source');
      sources.push({ id: entry.id, role: 'system', text: data.text.toWellFormed() });
      continue;
    }
    if (entry.type !== 'message' && entry.type !== 'custom_message') continue;
    const message: AgentMessage = entry.type === 'message' ? entry.message : {
      role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp),
    };
    if (message.role === 'user' || message.role === 'custom') {
      sources.push({ id: entry.id, role: message.role === 'user' ? 'user' : 'extension', text: contentText(message.content) });
    } else if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      const text = contentText(message.content);
      if (text.trim()) sources.push({ id: entry.id, role: 'assistant', text });
    }
    // System messages are deltas. The provider-rendered instruction snapshot owns their current meaning.
  }
  return sources;
}
