import { runBenchmark } from '../src/benchmark.js';

const report = runBenchmark();
const a = report.adversarial;
console.log(`Scenario fixture suite: ${report.fixtures.passed}/${report.fixtures.total} expected outcomes matched`);
console.log(`Adversarial gate suite: ${a.unsafeBlocked}/${a.unsafeTotal} unsafe proposals blocked, ${a.safeApproved}/${a.safeTotal} safe controls approved, ${a.falseApprovals} false approvals, ${a.falseBlocks} false blocks`);
for (const c of [...report.fixtures.cases, ...a.cases].filter((c) => !c.passed)) console.log(`  MISMATCH: ${c.name ?? c.actionTitle} expected ${c.expected} got ${c.actual}`);
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
if (report.fixtures.failed > 0 || a.falseApprovals > 0 || a.falseBlocks > 0) process.exitCode = 1;
