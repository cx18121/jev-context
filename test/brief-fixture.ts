import type { Api, Model } from '@earendil-works/pi-ai';
import type { BriefConfig } from '../src/brief-session.ts';
import { applyBriefUpdate, planBriefUpdate, type BriefChunk, type TaskBrief } from '../src/task-brief.ts';
import { assistant, zeroUsage } from './history-fixture.ts';

export function scriptedBrief(model: Model<Api>): BriefConfig {
  return { model, timeoutMs: 1000, maxTokens: 512, complete: async (_model, context) => {
    const message = context.messages[0]!;
    const input = JSON.parse(message.content as string) as { previous: TaskBrief | null; sources: BriefChunk[] };
    const quote = (source: BriefChunk) => source.text.slice(0, 240).trim();
    const output = { retain: input.previous?.items.map((item) => item.id) ?? [], supersede: [],
      add: input.sources.filter((source) => (source.role === 'user' || source.role === 'system') && quote(source)).map((source) => ({
        kind: 'requirement', text: quote(source), references: [{ sourceId: source.id, quote: quote(source) }],
      })),
      activity: input.sources.filter((source) => source.role === 'assistant' && quote(source) && !source.text.startsWith('{')).slice(-1).map((source) => ({
        text: quote(source), references: [{ sourceId: source.id, quote: quote(source) }],
      })) };
    return { ...assistant(), model: model.id, provider: model.provider, api: model.api,
      content: [{ type: 'text', text: JSON.stringify(output) }],
      usage: { ...zeroUsage(), input: 100, output: 20, totalTokens: 120 } };
  } };
}

export function taskBrief(text = 'Complete the user task.'): TaskBrief {
  const sources = [{ id: 'fixture-user', role: 'user' as const, text }];
  return applyBriefUpdate(planBriefUpdate(sources, null)!, { retain: [], supersede: [], activity: [],
    add: [{ kind: 'requirement', text, references: [{ sourceId: sources[0]!.id, quote: text }] }] }, sources);
}
