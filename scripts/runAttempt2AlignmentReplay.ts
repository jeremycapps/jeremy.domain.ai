import { runAttempt2AlignmentReplay } from "../src/lib/corusAlignmentReplay.js";

const result = await runAttempt2AlignmentReplay({
  runId: process.argv[2] ?? "b9e4e3fd-0ca2-41f1-884e-dd43c57e5051"
});

console.log(
  JSON.stringify(
    {
      run_id: result.run_id,
      provider_calls_made: result.provider_calls_made,
      strict_metrics_preserved: result.strict_metrics_preserved,
      diagnostic_metrics: result.diagnostic_metrics,
      scope_compatibility: result.scope_compatibility,
      prior_worse_verdict_status: result.prior_worse_verdict_status
    },
    null,
    2
  )
);
