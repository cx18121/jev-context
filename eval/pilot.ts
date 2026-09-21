import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateJev, validateJevConfig, JEV_MODEL, JEV_PRICE, JEV_PROMPT_VERSION, JEV_ENDPOINT, type JevConfig, type JevResult } from '../src/jev.ts';
import { pilotFixtures, type PilotFixture } from './fixtures.ts';

export const PILOT = {
  version: 'synthetic-v1', repeats: 2, maxCalls: 12, allowanceUsd: 0.05,
  inputTokensReservedPerCall: 64_000, timeoutMs: 30_000,
  diagnosticCutoffs: [0.1, 0.2, 0.5],
} as const;
const reservedPerCall = PILOT.inputTokensReservedPerCall * JEV_PRICE.inputUsdPerMillion / 1_000_000;
export const reservedUsd = reservedPerCall * PILOT.maxCalls;

export function pilotPlan() {
  const fixtures = pilotFixtures();
  if (fixtures.length * PILOT.repeats !== PILOT.maxCalls || reservedUsd > PILOT.allowanceUsd) {
    throw new Error('Pilot exceeds its fixed call or estimated cost allowance');
  }
  return {
    ...PILOT, model: JEV_MODEL, promptVersion: JEV_PROMPT_VERSION,
    priceSchedule: JEV_PRICE, reservedUsd,
    limits: 'Synthetic development cases only. Cutoffs are offline diagnostics, not calibrated defaults. No coding-agent outcomes or savings measured.',
    fixtures,
  };
}

export interface PilotAttempt { fixtureId: string; repeat: number; result: JevResult }

/** Missing or failed judgments are never counted as correct, wrong, or free. */
export function summarizePilot(fixtures: PilotFixture[], attempts: PilotAttempt[], stopReason: string | null) {
  const valid = attempts.filter((attempt) => attempt.result.outcome === 'ok');
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const cutoffs = PILOT.diagnosticCutoffs.map((cutoff) => {
    let relevant = 0, irrelevant = 0, harmfulOmissions = 0, irrelevantRetentions = 0;
    for (const attempt of valid) {
      for (const [id, expectation] of Object.entries(byId.get(attempt.fixtureId)!.expectations)) {
        const wouldRetire = attempt.result.relevance![id]! < cutoff;
        if (expectation.relevant) { relevant++; if (wouldRetire) harmfulOmissions++; }
        else { irrelevant++; if (!wouldRetire) irrelevantRetentions++; }
      }
    }
    return { cutoff, relevant, irrelevant, harmfulOmissions, irrelevantRetentions };
  });
  let pairWins = 0, pairTies = 0, pairLosses = 0;
  for (const attempt of valid) {
    const entries = Object.entries(byId.get(attempt.fixtureId)!.expectations);
    const positive = entries.find(([, expected]) => expected.relevant)![0];
    const negative = entries.find(([, expected]) => !expected.relevant)![0];
    const difference = attempt.result.relevance![positive]! - attempt.result.relevance![negative]!;
    if (difference > 0) pairWins++; else if (difference === 0) pairTies++; else pairLosses++;
  }
  const repeatDifferences = fixtures.map((fixture) => {
    const repeats = valid.filter((attempt) => attempt.fixtureId === fixture.id);
    return {
      fixtureId: fixture.id,
      absoluteScoreDifferences: repeats.length !== PILOT.repeats ? null : Object.fromEntries(
        Object.keys(fixture.expectations).map((id) => [id, Math.abs(repeats[0]!.result.relevance![id]! - repeats[1]!.result.relevance![id]!)])),
    };
  });
  const unknownCostCalls = attempts.filter((attempt) => attempt.result.pricedCostUsd === null).length;
  const knownCostSubtotalUsd = attempts.reduce((sum, attempt) => sum + (attempt.result.pricedCostUsd ?? 0), 0);
  return {
    plannedCalls: PILOT.maxCalls, completedCalls: attempts.length, validCalls: valid.length, stopReason,
    knownCostSubtotalUsd, unknownCostCalls, totalEstimatedCostUsd: unknownCostCalls ? null : knownCostSubtotalUsd,
    latencyMs: attempts.map((attempt) => ({ fixtureId: attempt.fixtureId, repeat: attempt.repeat, value: attempt.result.latencyMs })),
    pairWins, pairTies, pairLosses, cutoffs, repeatDifferences,
  };
}

/** Exclusive campaign directory + pre-call journal entry prevent silent overwrite or retry. */
export async function runPilot(directory: string, config: JevConfig, signal: AbortSignal, source: { head: string; dirty: boolean }) {
  validateJevConfig(config);
  if (config.timeoutMs !== PILOT.timeoutMs) throw new Error('Pilot timeout must match the frozen protocol');
  const plan = pilotPlan();
  signal.throwIfAborted();
  mkdirSync(directory, { mode: 0o700 }); // Parent must exist. An existing campaign, even incomplete, is never resumed.
  const manifest = {
    ...plan, createdAt: new Date().toISOString(), source,
    endpoint: config.endpoint ?? JEV_ENDPOINT,
    // evaluateJev does not apply a cutoff. These values describe the HTTP boundary only.
    config: { timeoutMs: config.timeoutMs },
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  writeFileSync(join(directory, 'manifest.json'), manifestText, { flag: 'wx', mode: 0o600, flush: true });
  const journal = join(directory, 'attempts.jsonl');
  writeFileSync(journal, '', { flag: 'wx', mode: 0o600 });
  const record = (entry: unknown) => appendFileSync(journal, JSON.stringify(entry) + '\n', { flush: true });
  const attempts: PilotAttempt[] = [];
  let stopReason: string | null = null;
  campaign: for (let repeat = 1; repeat <= PILOT.repeats; repeat++) {
    for (const fixture of plan.fixtures) {
      if (signal.aborted) { stopReason = 'cancelled'; break campaign; }
      if (attempts.length >= PILOT.maxCalls || (attempts.length + 1) * reservedPerCall > PILOT.allowanceUsd) {
        stopReason = 'allowance'; break campaign;
      }
      record({ type: 'start', fixtureId: fixture.id, repeat, requestHash: fixture.requestHash, reservedUsd: reservedPerCall });
      const result = await evaluateJev(fixture.request, config, signal);
      const attempt = { fixtureId: fixture.id, repeat, result };
      record({ type: 'result', ...attempt });
      attempts.push(attempt);
      if (result.outcome !== 'ok' || result.pricedCostUsd === null) { stopReason = result.outcome; break campaign; }
      const inputTokens = (result.rawUsage as { input_tokens: number }).input_tokens; // Validated by evaluateJev for ok results.
      if (inputTokens > PILOT.inputTokensReservedPerCall || result.pricedCostUsd > reservedPerCall ||
          attempts.reduce((sum, item) => sum + item.result.pricedCostUsd!, 0) > reservedUsd) {
        stopReason = 'usage_exceeded_reservation'; break campaign;
      }
    }
  }
  const report = {
    manifestHash: createHash('sha256').update(manifestText).digest('hex'),
    ...summarizePilot(plan.fixtures, attempts, stopReason),
  };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  return report;
}
