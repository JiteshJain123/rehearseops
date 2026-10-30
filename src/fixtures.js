import { ACTION_TYPES } from './actions.js';

export const SCENARIOS = [
  {
    id: 'database-pool-exhaustion',
    title: 'Database connection exhaustion',
    subtitle: 'Checkout errors after a pool configuration change',
    severity: 'SEV-1',
    category: 'Capacity regression',
    affectedServices: ['checkout-api', 'postgres-primary', 'payments-worker'],
    description: 'Checkout requests start timing out shortly after a deployment increases the connection pool per replica.',
    rawLogs: `[2026-10-28T14:02:00Z] INFO deployer release=checkout-v2.8 pool_max=40 replicas=3\n[2026-10-28T14:02:10Z] WARN postgres connection_count=97 max_connections=100 waiters=18\n[2026-10-28T14:02:14Z] ERROR checkout-api request_id=req-71 db_acquire_timeout_ms=5000\n[2026-10-28T14:02:19Z] WARN checkout-api retry_rate=3.4x baseline retry_policy=fixed\n[2026-10-28T14:02:27Z] ERROR checkout-api http_status=500 route=/checkout rate=18%\n[2026-10-28T14:02:40Z] INFO payments-worker external_db_connections=10\n[2026-10-28T14:02:45Z] INFO autoscaler hpa=checkout-api current_replicas=3 min_replicas=3 max_replicas=6 cpu=82% decision=scale_out_pending`,
    facts: {
      replicas: 3,
      maxReplicas: 6,
      poolSize: 40,
      maxConnections: 100,
      otherConnections: 10,
      maxRetryAttempts: 3,
      changeWindowConfirmed: false
    },
    factEvidence: { replicas: ['E001', 'E007'], maxReplicas: ['E007'], poolSize: ['E001'], maxConnections: ['E002'], otherConnections: ['E006'], currentRetryAttempts: [] },
    events: [
      { id: 'E001', time: '14:02:00', service: 'deployer', level: 'info', message: 'Release checkout-v2.8 deployed with pool_max=40 across 3 replicas.', source: 'deployment.log' },
      { id: 'E002', time: '14:02:10', service: 'postgres-primary', level: 'warning', message: '97 connections in use against a limit of 100; 18 waiters observed.', source: 'postgres.log' },
      { id: 'E003', time: '14:02:14', service: 'checkout-api', level: 'error', message: 'Database connection acquisition timed out after 5000 ms.', source: 'checkout.log' },
      { id: 'E004', time: '14:02:19', service: 'checkout-api', level: 'warning', message: 'Retry volume reached 3.4× baseline under a fixed retry policy.', source: 'checkout.log' },
      { id: 'E005', time: '14:02:27', service: 'checkout-api', level: 'error', message: 'HTTP 500 rate reached 18% on /checkout.', source: 'gateway.log' },
      { id: 'E006', time: '14:02:40', service: 'payments-worker', level: 'info', message: 'A separate consumer pool accounts for 10 database connections.', source: 'worker.log' },
      { id: 'E007', time: '14:02:45', service: 'autoscaler', level: 'info', message: 'HPA for checkout-api: 3 replicas now, max 6; CPU at 82% so a scale-out is pending.', source: 'hpa-events.log' }
    ],
    hypotheses: [
      { id: 'H1', title: 'Application pool budget exceeds database capacity', likelihood: 'High', confidence: 0.91, evidenceIds: ['E001', 'E002', 'E006', 'E007'], counterEvidenceIds: [], explanation: 'Three replicas at 40 connections create a potential pool of 120 plus 10 from another consumer, against a limit of 100. The pending scale-out to 6 replicas would push demand to 250.' },
      { id: 'H2', title: 'Retry amplification is worsening the saturation', likelihood: 'High', confidence: 0.82, evidenceIds: ['E003', 'E004', 'E005'], counterEvidenceIds: [], explanation: 'Connection timeouts are followed by a 3.4× retry spike under a fixed retry policy. This is likely an amplifier, not necessarily the original trigger.' },
      { id: 'H3', title: 'Independent database degradation', likelihood: 'Medium', confidence: 0.43, evidenceIds: ['E002', 'E003'], counterEvidenceIds: ['E001'], explanation: 'A database-side issue could contribute, but the timing after the pool configuration change makes this less supported by the current evidence.' }
    ],
    actions: [
      { id: 'increase-pool-50', type: 'set_pool_size', params: { poolSize: 50 }, risk: 'high', summary: 'Raise the per-replica connection pool to reduce local waiting.', expectedStatus: 'blocked' },
      { id: 'enable-bounded-retries', type: 'retry_policy', params: { maxAttempts: 3, strategy: 'exponential_jitter' }, risk: 'low', summary: 'Reduce synchronized retry bursts and cap retry amplification.', expectedStatus: 'approved-for-simulation' },
      { id: 'reduce-pool-15', type: 'set_pool_size', params: { poolSize: 15 }, risk: 'medium', summary: 'Size the pool for the autoscaler ceiling: 6 × 15 + 10 = 100.', expectedStatus: 'approved-for-simulation' },
      { id: 'reduce-pool-30', type: 'set_pool_size', params: { poolSize: 30 }, risk: 'medium', summary: 'Looks right at 3 replicas (100), but breaks when the autoscaler reaches 6 (190).', expectedStatus: 'blocked' },
      { id: 'raise-db-limit', type: 'set_db_max_connections', params: { maxConnections: 200 }, risk: 'high', summary: 'Increase the database connection limit without checking instance capacity.', expectedStatus: 'blocked' }
    ],
    referenceDocs: ['PostgreSQL connection settings and max_connections', 'Node.js database connection pool sizing', 'Exponential backoff with jitter for distributed systems']
  },
  {
    id: 'retry-storm',
    title: 'Retry storm after upstream slowdown',
    subtitle: 'Retries multiply load on an already degraded dependency',
    severity: 'SEV-1',
    category: 'Resilience failure',
    affectedServices: ['order-api', 'inventory-service', 'message-broker'],
    description: 'An upstream service slows down, clients retry aggressively, and request volume grows rather than settling.',
    rawLogs: `[2026-10-28T15:10:00Z] WARN inventory p95_latency_ms=3200 baseline_ms=180\n[2026-10-28T15:10:04Z] WARN order-api retry_attempts=8 policy=fixed_no_jitter\n[2026-10-28T15:10:08Z] ERROR inventory queue_depth=9400 consumer_lag_s=74\n[2026-10-28T15:10:12Z] ERROR order-api upstream_timeout_rate=31%\n[2026-10-28T15:10:16Z] WARN message-broker publish_rate=4.1x baseline`,
    facts: { currentRetryAttempts: 8, maxRetryAttempts: 3, retryStrategy: 'fixed_no_jitter', upstreamHealthy: false, changeWindowConfirmed: false },
    factEvidence: { currentRetryAttempts: ['E002'], retryStrategy: ['E002'], upstreamHealthy: ['E001', 'E004'] },
    events: [
      { id: 'E001', time: '15:10:00', service: 'inventory-service', level: 'warning', message: 'p95 latency increased to 3200 ms from a 180 ms baseline.', source: 'inventory.log' },
      { id: 'E002', time: '15:10:04', service: 'order-api', level: 'warning', message: 'Client is making up to 8 fixed retries without jitter.', source: 'order-api.log' },
      { id: 'E003', time: '15:10:08', service: 'inventory-service', level: 'error', message: 'Queue depth reached 9400; consumer lag is 74 seconds.', source: 'inventory.log' },
      { id: 'E004', time: '15:10:12', service: 'order-api', level: 'error', message: 'Upstream timeout rate reached 31%.', source: 'gateway.log' },
      { id: 'E005', time: '15:10:16', service: 'message-broker', level: 'warning', message: 'Publish rate is 4.1× baseline.', source: 'broker.log' }
    ],
    hypotheses: [
      { id: 'H1', title: 'Retry amplification is driving further overload', likelihood: 'High', confidence: 0.93, evidenceIds: ['E001', 'E002', 'E003', 'E005'], counterEvidenceIds: [], explanation: 'Fixed retries without jitter can amplify load while the upstream dependency is already slow.' },
      { id: 'H2', title: 'Inventory service degradation is the initiating event', likelihood: 'High', confidence: 0.87, evidenceIds: ['E001', 'E003'], counterEvidenceIds: [], explanation: 'Latency rises before the retry spike; inventory may be the original degraded dependency.' },
      { id: 'H3', title: 'Broker saturation is the sole cause', likelihood: 'Low', confidence: 0.31, evidenceIds: ['E005'], counterEvidenceIds: ['E001'], explanation: 'Broker pressure is visible, but the earlier inventory latency suggests a broader sequence.' }
    ],
    actions: [
      { id: 'raise-retries', type: 'retry_policy', params: { maxAttempts: 12, strategy: 'fixed_no_jitter' }, risk: 'high', summary: 'Increase retry count to mask upstream timeouts.', expectedStatus: 'blocked' },
      { id: 'open-circuit-breaker', type: 'circuit_breaker', params: { state: 'enabled' }, risk: 'medium', summary: 'Fail fast while dependency health violates the threshold.', expectedStatus: 'approved-for-simulation' },
      { id: 'bounded-backoff', type: 'retry_policy', params: { maxAttempts: 3, strategy: 'exponential_jitter' }, risk: 'low', summary: 'Bound retries and desynchronize repeated requests.', expectedStatus: 'approved-for-simulation' },
      { id: 'disable-circuit-breaker', type: 'circuit_breaker', params: { state: 'disabled' }, risk: 'high', summary: 'Allow requests to continue hitting a degraded dependency.', expectedStatus: 'blocked' }
    ],
    referenceDocs: ['Retry storm mitigation', 'Exponential backoff and jitter', 'Circuit breaker patterns for unhealthy dependencies']
  },
  {
    id: 'migration-rollback-risk',
    title: 'Unsafe rollback after schema migration',
    subtitle: 'The application release and database schema are no longer backward-compatible',
    severity: 'SEV-2',
    category: 'Release compatibility',
    affectedServices: ['orders-api', 'postgres-primary', 'migration-job'],
    description: 'A new schema migration removed a column that the previous application version still expects.',
    rawLogs: `[2026-10-28T16:00:00Z] INFO migration schema_version=v42 removed_column=legacy_status\n[2026-10-28T16:01:02Z] INFO deployer orders_api_version=v42.1\n[2026-10-28T16:03:10Z] ERROR orders-api undefined_column=legacy_status route=/orders\n[2026-10-28T16:03:15Z] WARN rollback-check old_app=v41 compatible_with_schema_v42=false\n[2026-10-28T16:03:20Z] INFO release-manager forward_fix_available=true`,
    facts: { currentSchemaVersion: 'v42', compatibleReleases: ['v42.1', 'v42.2'], incompatibleReleases: ['v41'], forwardFixAvailable: true, changeWindowConfirmed: false },
    factEvidence: { currentSchemaVersion: ['E001'], incompatibleReleases: ['E004'], forwardFixAvailable: ['E005'] },
    events: [
      { id: 'E001', time: '16:00:00', service: 'migration-job', level: 'info', message: 'Schema v42 removed legacy_status.', source: 'migration.log' },
      { id: 'E002', time: '16:01:02', service: 'deployer', level: 'info', message: 'Application v42.1 deployed.', source: 'deployment.log' },
      { id: 'E003', time: '16:03:10', service: 'orders-api', level: 'error', message: 'Requests fail because legacy_status is missing.', source: 'orders.log' },
      { id: 'E004', time: '16:03:15', service: 'rollback-check', level: 'warning', message: 'Previous app v41 is marked incompatible with schema v42.', source: 'release-check.log' },
      { id: 'E005', time: '16:03:20', service: 'release-manager', level: 'info', message: 'A forward fix is available in the fixture.', source: 'release-manager.log' }
    ],
    hypotheses: [
      { id: 'H1', title: 'Application/schema incompatibility causes request failures', likelihood: 'High', confidence: 0.96, evidenceIds: ['E001', 'E002', 'E003'], counterEvidenceIds: [], explanation: 'The schema removes a column that the application still queries; failures appear after the migration and release.' },
      { id: 'H2', title: 'Rollback may reintroduce the incompatible query', likelihood: 'High', confidence: 0.94, evidenceIds: ['E003', 'E004'], counterEvidenceIds: [], explanation: 'The old application version is explicitly marked incompatible with the current schema.' },
      { id: 'H3', title: 'A forward-compatible application fix is the safer direction', likelihood: 'Medium', confidence: 0.72, evidenceIds: ['E005'], counterEvidenceIds: [], explanation: 'The fixture says a forward fix exists, but release validation is still required.' }
    ],
    actions: [
      { id: 'rollback-v41', type: 'app_rollback', params: { targetVersion: 'v41' }, risk: 'high', summary: 'Restore the previous application release.', expectedStatus: 'blocked' },
      { id: 'run-compat-tests', type: 'verification_only', params: { description: 'Run schema-contract tests for v42.2 against schema v42' }, risk: 'low', summary: 'Validate the candidate release against schema v42 before rollout.', expectedStatus: 'approved-for-simulation' },
      { id: 'forward-fix', type: 'forward_fix', params: { targetVersion: 'v42.2' }, risk: 'medium', summary: 'Use a forward fix that no longer queries the removed column.', expectedStatus: 'approved-for-simulation' },
      { id: 'restore-column', type: 'schema_change', params: { description: 'Restore legacy_status column' }, risk: 'high', summary: 'Attempt to restore removed schema state without a migration plan.', expectedStatus: 'blocked' }
    ],
    referenceDocs: ['Expand-and-contract database migrations', 'Backward-compatible database schema changes', 'Safe deployment rollback procedures']
  },
  {
    id: 'disk-retention-risk',
    title: 'Disk pressure with retention constraints',
    subtitle: 'A cleanup shortcut could destroy logs still needed for investigation',
    severity: 'SEV-2',
    category: 'Storage exhaustion',
    affectedServices: ['worker-node-03', 'log-agent', 'payment-worker'],
    description: 'A worker node is nearing disk capacity. Some logs are younger than the defined retention window.',
    rawLogs: `[2026-10-28T17:20:00Z] WARN worker-node-03 disk_used_percent=94 mount=/var\n[2026-10-28T17:20:06Z] WARN log-agent oldest_log_age_days=21 required_retention_days=14\n[2026-10-28T17:20:11Z] INFO log-agent recent_payment_logs_age_days=2\n[2026-10-28T17:20:16Z] ERROR payment-worker temp_write_failed=true path=/var/tmp/report.tmp\n[2026-10-28T17:20:22Z] WARN cleanup-proposal delete_all_logs=true`,
    facts: { diskUsedPercent: 94, requiredRetentionDays: 14, oldLogAgeDays: 21, recentLogAgeDays: 2, changeWindowConfirmed: false },
    factEvidence: { diskUsedPercent: ['E001'], requiredRetentionDays: ['E002'], oldLogAgeDays: ['E002'], recentLogAgeDays: ['E003'] },
    events: [
      { id: 'E001', time: '17:20:00', service: 'worker-node-03', level: 'warning', message: 'Disk utilization reached 94% on /var.', source: 'node-metrics.log' },
      { id: 'E002', time: '17:20:06', service: 'log-agent', level: 'warning', message: 'Oldest logs are 21 days old; required retention is 14 days.', source: 'log-agent.log' },
      { id: 'E003', time: '17:20:11', service: 'log-agent', level: 'info', message: 'Recent payment logs are only 2 days old.', source: 'log-agent.log' },
      { id: 'E004', time: '17:20:16', service: 'payment-worker', level: 'error', message: 'Temporary report write failed due to storage pressure.', source: 'worker.log' },
      { id: 'E005', time: '17:20:22', service: 'cleanup-proposal', level: 'warning', message: 'A proposed cleanup would delete all logs, including retained evidence.', source: 'cleanup-plan.json' }
    ],
    hypotheses: [
      { id: 'H1', title: 'Disk pressure is blocking temporary writes', likelihood: 'High', confidence: 0.89, evidenceIds: ['E001', 'E004'], counterEvidenceIds: [], explanation: 'High disk utilization and a failed temp write are consistent with storage pressure.' },
      { id: 'H2', title: 'A retention-violating cleanup could destroy required evidence', likelihood: 'High', confidence: 0.97, evidenceIds: ['E002', 'E003', 'E005'], counterEvidenceIds: [], explanation: 'The proposed delete-all action includes logs younger than the required 14-day retention period.' },
      { id: 'H3', title: 'Bounded cleanup of expired temporary files may relieve pressure', likelihood: 'Medium', confidence: 0.68, evidenceIds: ['E001', 'E004'], counterEvidenceIds: [], explanation: 'Temporary-file cleanup is a candidate, but the actual size, ownership and safe deletion eligibility must be verified.' }
    ],
    actions: [
      { id: 'delete-all-logs', type: 'delete_logs', params: { olderThanDays: 0 }, risk: 'high', summary: 'Delete every log file to free disk space quickly.', expectedStatus: 'blocked' },
      { id: 'cleanup-temp', type: 'cleanup_temp', params: { pathPattern: '/var/tmp/*' }, risk: 'low', summary: 'Remove temporary files by path pattern.', expectedStatus: 'blocked' },
      { id: 'delete-logs-14d', type: 'delete_logs', params: { olderThanDays: 14 }, risk: 'low', summary: 'Remove only logs older than the stated retention window.', expectedStatus: 'approved-for-simulation' },
      { id: 'expand-volume', type: 'expand_volume', params: { sizeGb: 200 }, risk: 'medium', summary: 'Increase capacity after checking quota and approvals.', expectedStatus: 'blocked' }
    ],
    referenceDocs: ['Log retention and deletion controls', 'Linux disk pressure investigation', 'Safe temporary-file cleanup']
  }
];

export function actionTitle(action) {
  return ACTION_TYPES[action.type]?.title(action.params) ?? action.id;
}

export function getScenario(id) {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function publicScenario(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    subtitle: scenario.subtitle,
    severity: scenario.severity,
    category: scenario.category,
    affectedServices: scenario.affectedServices,
    description: scenario.description,
    rawLogs: scenario.rawLogs,
    facts: scenario.facts,
    events: scenario.events,
    hypotheses: scenario.hypotheses,
    factEvidence: scenario.factEvidence ?? {},
    actions: scenario.actions.map((action) => ({ id: action.id, title: actionTitle(action), type: action.type, params: action.params, risk: action.risk, summary: action.summary })),
    referenceDocs: scenario.referenceDocs
  };
}
