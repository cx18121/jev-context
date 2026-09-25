import { applySketchUpdate, validateSketchUpdatePlan, SKETCH_INSTRUCTIONS, SKETCH_OUTPUT_BYTES, type SketchSource, type SketchUpdatePlan, type TaskSketch } from './task-sketch.ts';
import { completeText, validateTextCompletionConfig, type TextCompletionConfig, type TextCompletionResult } from './text-completion.ts';

export interface SketchResult extends Omit<TextCompletionResult, 'text'> { sketch?: TaskSketch }

/** The caller owns branch freshness, persistence, catch-up limits, and whether to dispatch. */
export async function updateSketch(plan: SketchUpdatePlan, capturedSources: readonly SketchSource[], config: TextCompletionConfig,
  complete: NonNullable<TextCompletionConfig['complete']>, parentSignal: AbortSignal): Promise<SketchResult> {
  // Detach asynchronous validation from mutable caller state. Fresh branch checks happen after return.
  const snapshot = structuredClone({ plan, sources: capturedSources });
  validateTextCompletionConfig(config);
  const local: SketchResult = { outcome: 'invalid', completionInvoked: false, usage: null, pricedCostUsd: 0, usageSource: 'pi-normalized' };
  if (parentSignal.aborted) return { ...local, outcome: 'cancelled' };
  try {
    validateSketchUpdatePlan(snapshot.plan, snapshot.sources);
    if (snapshot.plan.previous && snapshot.plan.sources.every((source) => !source.text.trim())) {
      return { ...local, outcome: 'ok', sketch: applySketchUpdate(snapshot.plan,
        { summary: snapshot.plan.previous.summary }, snapshot.sources) };
    }
  } catch (error) { return { ...local, error: error instanceof Error ? error.message : String(error) }; }
  const { text, ...result } = await completeText({ systemPrompt: SKETCH_INSTRUCTIONS,
    messages: [{ role: 'user', content: JSON.stringify({ previous: snapshot.plan.previous, sources: snapshot.plan.sources }), timestamp: 0 }],
  }, SKETCH_OUTPUT_BYTES, config, complete, parentSignal);
  if (result.outcome !== 'ok') return result;
  try { return { ...result, sketch: applySketchUpdate(snapshot.plan, JSON.parse(text!), snapshot.sources) }; }
  catch (error) { return { ...result, outcome: 'invalid', error: error instanceof Error ? error.message : String(error) }; }
}
