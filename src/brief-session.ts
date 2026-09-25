import { applyBriefUpdate, BRIEF_INSTRUCTIONS, BRIEF_UPDATE_BYTES, type BriefSource, type BriefUpdatePlan, type TaskBrief } from './task-brief.ts';
import { completeText, validateTextCompletionConfig, type TextCompletionConfig, type TextCompletionResult } from './text-completion.ts';

export const BRIEF_ENTRY = 'jev-context/task-brief';
export { INSTRUCTION_SOURCE_ENTRY as BRIEF_SOURCE_ENTRY, taskSources } from './task-sources.ts';
export const BRIEF_START_ENTRY = 'jev-context/brief-start';
export const BRIEF_RESULT_ENTRY = 'jev-context/brief-result';

export type BriefConfig = TextCompletionConfig;
export const validateBriefConfig = validateTextCompletionConfig;

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
