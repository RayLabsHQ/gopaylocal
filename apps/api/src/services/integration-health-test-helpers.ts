// Test-only helpers (imported by unit tests, never by the Worker): read the
// integration-health statements out of a SQL recorder.

import type { SqlRecorder } from "../lib/sql-recorder-test-helpers";
import type { IntegrationHealthIssue } from "./integration-health.service";

const WRITE = /^update "integrations" set "health" = "integrations"\."health" \|\| jsonb_build_object/;
const CLEAR = /^update "integrations" set "health" = "integrations"\."health" - \$1::text/;

/** Every issue recorded (the jsonb written), in order. */
export function healthWrites(r: Pick<SqlRecorder, "queries">): IntegrationHealthIssue[] {
  return r.queries
    .filter((q) => WRITE.test(q.sql))
    .map((q) => JSON.parse(q.params[1] as string) as IntegrationHealthIssue);
}

/** Every area cleared, in order. */
export function healthClears(r: Pick<SqlRecorder, "queries">): string[] {
  return r.queries.filter((q) => CLEAR.test(q.sql)).map((q) => q.params[0] as string);
}
