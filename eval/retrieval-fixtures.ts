export interface RetrievalScenario {
  id: string;
  users: string[];
  action: string;
  latestPath: string;
  observations: Array<{ id: string; path: string; text: string }>;
  relevant: string[];
  reason: string;
  limit: number;
}

const observation = (id: string, text: string, path = `archive/${id}`) => ({ id, path, text });

/** Authored development cases, including known lexical failures. Labels are never lookup input. */
export function retrievalScenarios(): RetrievalScenario[] {
  return [
    {
      id: 'return-to-old-task', users: ['Implement invoice rounding.', 'First repair the sandbox.'],
      action: 'The sandbox is repaired. Return to invoice rounding.', latestPath: 'environment/status', limit: 2,
      observations: [observation('palette', 'Navy background.'), observation('rounding', 'Invoice rounding uses half-even arithmetic.'),
        observation('sandbox', 'Sandbox setup uses an isolated temporary directory.')],
      relevant: ['rounding'], reason: 'The original unfinished task needs its rounding rule; the repaired detour does not.',
    },
    {
      id: 'unfinished-task-during-detour', users: ['Implement invoice rounding.', 'First repair the sandbox.'],
      action: 'Inspect sandbox permissions.', latestPath: 'environment/status', limit: 2,
      observations: [observation('rounding', 'Invoice rounding uses half-even arithmetic.'),
        observation('sandbox', 'Sandbox permissions must allow owner writes.'), observation('palette', 'Navy background.')],
      relevant: ['rounding', 'sandbox'], reason: 'Both the temporary detour and the original task remain unfinished.',
    },
    {
      id: 'metadata-only', users: ['Change refundPolicy.'], action: 'Inspect the implementation.', latestPath: 'workspace/status', limit: 1,
      observations: [observation('palette', 'Navy background.'), observation('contract', 'A receipt is mandatory.', 'src/refund_policy.ts')],
      relevant: ['contract'], reason: 'The file path connects an otherwise opaque requirement to the task.',
    },
    {
      id: 'buried-rule', users: ['Implement packetLength decoding.'], action: 'Edit the decoder.', latestPath: 'workspace/status', limit: 1,
      observations: [observation('appendix', 'Reserved flags remain zero.'),
        observation('wire-rule', 'padding '.repeat(1000) + 'packetLength is big endian. ' + 'padding '.repeat(1000))],
      relevant: ['wire-rule'], reason: 'The required rule is in the middle of a long observation, not its edges.',
    },
    {
      id: 'correction-crowding', users: ['Implement semicolon export.', 'Correction: keep comma export; fix quoting only.'],
      action: 'Fix quoting.', latestPath: 'workspace/status', limit: 1,
      observations: [observation('obsolete', 'Semicolon export quoting draft.'), observation('current', 'Comma quoting doubles embedded quotes.')],
      relevant: ['current'], reason: 'The obsolete draft matches more accumulated query terms but no longer governs the task.',
    },
    {
      id: 'semantic-gap', users: ['Extend subscription trial.'], action: 'Implement the change.', latestPath: 'workspace/status', limit: 2,
      observations: [observation('rule', 'Grace interval must remain below fourteen days.'), observation('palette', 'Navy background.')],
      relevant: ['rule'], reason: 'This authored synonym dependency has no lexical overlap and needs a different retrieval signal.',
    },
    {
      id: 'shortlist-crowding', users: ['Implement invoice rounding.'], action: 'Edit the implementation.', latestPath: 'workspace/status', limit: 1,
      observations: [observation('rule', 'Invoice rounding uses half-even arithmetic.'), observation('tests', 'Invoice rounding tests must include negative amounts.')],
      relevant: ['rule', 'tests'], reason: 'Both observations matter, but the deliberately small shortlist admits only one.',
    },
    {
      id: 'shared-path-noise', users: ['Extend subscription trial.'], action: 'Implement the change.', latestPath: 'workspace/status.txt', limit: 1,
      observations: [observation('palette', 'Navy background.', 'docs/palette.txt'), observation('rule', 'Grace interval must remain below fourteen days.', 'config/billing.txt')],
      relevant: ['rule'], reason: 'A shared filename extension creates a lexical tie; the earlier unrelated observation wins.',
    },
    ...[8, 64, 256].map((size): RetrievalScenario => ({
      id: `archive-size-${size}`, users: ['Fix requestId propagation.'], action: 'Edit the implementation.', latestPath: 'workspace/status', limit: 4,
      observations: [...Array.from({ length: size - 1 }, (_, index) => observation(`noise-${index}`, `Palette swatch ${index} is navy.`)),
        observation('contract', 'request_id must pass unchanged through every response.')],
      relevant: ['contract'], reason: 'A distinctive identifier should find the last observation as unrelated archive size grows.',
    })),
  ];
}
