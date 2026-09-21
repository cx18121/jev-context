import { prepareFixture, type Scenario, type Expectation } from './fixtures.ts';

interface Pair {
  id: string;
  task: string;
  correction: string;
  observations: [string, string];
  before: [Expectation, Expectation];
  after: [Expectation, Expectation];
}
const yes = (reason: string): Expectation => ({ relevant: true, reason });
const no = (reason: string): Expectation => ({ relevant: false, reason });

const pairs: Pair[] = [
  {
    id: 'csv-target',
    task: 'Write a new CSV export fixture for the Atlas importer. Atlas is the only target. Preserve its documented delimiter and escaping behavior. Do not change either importer or produce a multi-importer fixture.',
    correction: 'Correction: the export is for the Boreal importer, not Atlas. Produce only the Boreal fixture using its contract. We no longer need an Atlas fixture.',
    observations: [
      '# Atlas CSV import contract\nAtlas accepts semicolon-separated columns in the order account;region;amount. Enclose any field containing a semicolon or quote in double quotes. Escape a literal quote with a backslash. Files use UTF-8, with a header row and LF line endings. An empty amount is the literal NULL, not an empty string.\n',
      '# Boreal CSV import contract\nBoreal accepts comma-separated columns in the order account,amount,region. Enclose fields containing a comma or quote in double quotes and double every embedded quote. Files use UTF-8, with a header row and CRLF line endings. An empty amount is an empty field. The importer rejects the literal NULL.\n',
    ],
    before: [yes('Atlas is the requested fixture target.'), no('Boreal is a different importer outside the requested scope.')],
    after: [no('The correction cancels the Atlas fixture.'), yes('Boreal replaces Atlas as the only fixture target.')],
  },
  {
    id: 'api-client-target',
    task: 'Create a standalone response decoder for the mobile client. It must implement only the mobile wire contract. The command-line client has a separate decoder outside this task.',
    correction: 'Correction: create the command-line client decoder instead. The mobile decoder is cancelled. The new decoder only needs the command-line wire contract, not dual compatibility.',
    observations: [
      '# Command-line response contract\nA successful response is an object with a numeric code field equal to 0 and a result array. A failed response has a nonzero code and a message string. Entries in result use snake_case field names. The CLI protocol has no status field and no nested error object. Preserve unknown fields when decoding entries.\n',
      '# Mobile response contract\nA successful response is an object with status set to ok and an items array. A failed response has status set to error and a nested error object containing key and description. Entries in items use camelCase field names. The mobile protocol has no numeric code field. Preserve unknown fields when decoding entries.\n',
    ],
    before: [no('The command-line decoder is explicitly outside the initial scope.'), yes('The mobile contract defines the requested decoder.')],
    after: [yes('The corrected decoder targets the command-line contract.'), no('The mobile decoder has been cancelled, with dual compatibility excluded.')],
  },
  {
    id: 'retry-release-target',
    task: 'Write a standalone expected-configuration fixture for the CURRENT release. It should contain only that release\'s retry values. Do not implement a migration, rollback procedure, or release comparison.',
    correction: 'Correction: the deployment is rolling back. Write the standalone expected-configuration fixture for the PRIOR release instead. Include only its target values, not a diff or migration procedure.',
    observations: [
      '// config/retry.ts — complete snapshot from the prior release\nexport const retry = { attempts: 9, delayMs: 800, mode: "exponential", jitter: true, retryOn: ["timeout", "busy"] };\n// This snapshot was captured before the replacement release. It defines the prior release only and does not claim these are the current file contents.\n',
      '// config/retry.ts — complete snapshot from the current release\nexport const retry = { attempts: 2, delayMs: 50, mode: "fixed", jitter: false, retryOn: ["timeout"] };\n// This snapshot was captured after the release replacement. It defines the current release configuration and fully replaces the prior file for current-release tests.\n',
    ],
    before: [no('The prior values are not part of the requested current-only fixture.'), yes('The current snapshot supplies the requested target values.')],
    after: [yes('The rollback target now requires the prior-release values.'), no('A prior-only fixture does not need current values or a comparison.')],
  },
  {
    id: 'historical-comparison',
    task: 'Document the CURRENT upload-size and media-type restrictions. The current snapshot fully replaces the prior snapshot. Describe only current behavior, not history or a change log.',
    correction: 'Also add an exact before-and-after comparison against the prior upload policy. Keep the current-policy documentation and explain which limits and media types changed.',
    observations: [
      '// src/upload-policy.ts — current snapshot, after the replacement\nexport const uploadPolicy = { maxBytes: 5242880, mediaTypes: ["image/png", "image/jpeg"], animatedImages: false, maxFiles: 3 };\n// These are the full current validation settings. The upload endpoint applies all listed limits before saving any file.\n',
      '// src/upload-policy.ts — prior snapshot, before the replacement\nexport const uploadPolicy = { maxBytes: 1048576, mediaTypes: ["image/png"], animatedImages: false, maxFiles: 1 };\n// These are the full validation settings in the prior release. They have since been replaced and should not be described as current runtime behavior.\n',
    ],
    before: [yes('The current policy defines all requested documentation.'), no('The initial task explicitly excludes history; the old policy is superseded.')],
    after: [yes('Both the current documentation and comparison still require current values.'), yes('The newly requested comparison requires the prior values.')],
  },
  {
    
id: 'second-consumer-enabled',
    task: 'Implement the event publisher for the audit consumer only. The analytics consumer is disabled in every environment and outside this change. Use the audit transport contract; do not implement analytics delivery.',
    correction: 'The analytics consumer is now enabled and included in this change. Publish each event to BOTH audit and analytics using their respective transport contracts. Keep the audit requirement.',
    observations: [
      '# Audit transport\nSend each event as a JSON object with event_id, actor_id, and occurred_at. Sign the UTF-8 body with HMAC-SHA256 and send the signature in x-audit-signature. The audit endpoint accepts one event per request, uses the event_id for idempotency, and returns HTTP 202 after writing the audit record.\n',
      '# Analytics transport\nSend events as a JSON array with id, actor, and timestamp on every entry. The endpoint accepts at most 50 events per batch. Authenticate with the service bearer token, not an audit HMAC signature. The analytics endpoint returns HTTP 204 and deduplicates entries by id within the ingestion window.\n',
    ],
    before: [yes('Audit is the only enabled consumer in the initial task.'), no('Analytics delivery is disabled everywhere and explicitly excluded.')],
    after: [yes('The original audit requirement remains active.'), yes('The newly enabled analytics consumer adds its distinct delivery requirements.')],
  },
  {
    id: 'temporary-detour-control',
    task: 'Fix inbound webhook signature verification and add regression tests. Keep the outbound webhook sender unchanged; its protocol is outside this task.',
    correction: 'Before continuing, repair the local test runner\'s missing temporary directory. This is only a detour. Finish the original inbound-signature change and its regression tests afterward.',
    observations: [
      '# Outbound webhook signing\nThe outbound sender signs the serialized JSON body using HMAC-SHA512. It encodes the digest as base64 and sends it in x-outbound-digest. Delivery retries preserve the original body but generate a new delivery identifier. This is a separate partner protocol implemented by the sender, not the inbound verifier.\n',
      '# Inbound webhook verification\nVerify x-inbound-signature as the hexadecimal HMAC-SHA256 digest of the exact raw request bytes before JSON parsing. Reject missing, malformed, or unequal signatures. Compare equal-length digests in constant time. Whitespace differences in the raw body change the signed bytes even when parsed JSON is equivalent.\n',
    ],
    before: [no('Outbound signing is a separate protocol outside the task.'), yes('Inbound verification rules define the requested security fix.')],
    after: [no('The temporary-directory detour does not bring outbound signing into scope.'), yes('The inbound task is explicitly unfinished and still requires its verification rules.')],
  },
];

/** Only the added user instruction changes across states. Candidate questions are byte-identical. */
export function pairedFixtures() {
  return pairs.flatMap((pair) => (['before', 'after'] as const).map((variant) => {
    const scenario: Scenario = {
      id: `${pair.id}-${variant}`, pair: { id: pair.id, variant },
      task: pair.task, observations: pair.observations, expectations: pair[variant],
      correction: variant === 'after' ? pair.correction : undefined,
      action: 'I have read the available observations. Implementation and verification are still pending.',
      latest: 'Workspace check complete. The repository is available, the working tree is clean, and no implementation changes have been made.',
    };
    return prepareFixture(scenario);
  }));
}
