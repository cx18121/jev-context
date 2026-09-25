import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { applyBriefUpdate, BRIEF_INSTRUCTIONS, BRIEF_UPDATE_BYTES, type BriefSource, type BriefUpdatePlan, type TaskBrief } from './task-brief.ts';
import { completeText, validateTextCompletionConfig, type TextCompletionConfig, type TextCompletionResult } from './text-completion.ts';

export const BRIEF_ENTRY = 'jev-context/task-brief';
export const BRIEF_SOURCE_ENTRY = 'jev-context/instruction-source';
export const BRIEF_START_ENTRY = 'jev-context/brief-start';
export const BRIEF_RESULT_ENTRY = 'jev-context/brief-result';

export type BriefConfig = TextCompletionConfig;
export const validateBriefConfig = validateTextCompletionConfig;

function contentText(content: string | { type: string; text?: string }[]): string {
  return typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** Persistent task text only. Tool activity belongs to the judge's recent window, not brief inference. */
export function taskSources(branch: SessionEntry[]): BriefSource[] {
  const sources: BriefSource[] = [];
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === BRIEF_SOURCE_ENTRY) {
      const data = entry.data as { version?: unknown; text?: unknown } | undefined;
      if (data?.version !== 1 || typeof data.text !== 'string') throw new Error('Invalid instruction source');
      sources.push({ id: entry.id, role: 'system', text: data.text });
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
    // System messages are deltas. The provider-rendered instruction snapshot above owns their current meaning.
  }
  return sources;
}

export interface BriefResult extends Omit<TextCompletionResult, 'text'> { brief?: TaskBrief }

export async function updateBrief(plan: BriefUpdatePlan, sources: BriefSource[], config: BriefConfig,
  complete: NonNullable<BriefConfig['complete']>, parentSignal: AbortSignal): Promise<BriefResult> {
  const { text, ...result } = await completeText({ systemPrompt: BRIEF_INSTRUCTIONS,
    messages: [{ role: 'user', content: JSON.stringify({ previous: plan.previous, sources: plan.sources }), timestamp: 0 }],
  }, BRIEF_UPDATE_BYTES, config, complete, parentSignal);
  if (result.outcome !== 'ok') return result;
  try { return { ...result, brief: applyBriefUpdate(plan, JSON.parse(text!), sources) }; }
  catch (error) { return { ...result, outcome: 'invalid', error: error instanceof Error ? error.message : String(error) }; }
}
