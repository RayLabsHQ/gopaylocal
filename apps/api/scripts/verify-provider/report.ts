// ── Output formatting ───────────────────────────────────────────────────────

import type { StepResult, StepStatus } from './runner';
import { summarize } from './runner';

const STATUS_WIDTH = 8;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Live progress line, printed as each step finishes (full detail). */
export function formatStepLine(r: StepResult): string {
  const time = fmtDuration(r.durationMs);
  return `  ${r.status.padEnd(STATUS_WIDTH)} ${r.name}${time ? ` (${time})` : ''}\n           ${r.detail}`;
}

export function formatSummaryTable(title: string, results: StepResult[]): string {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const lines = [
    title,
    `  ${'STEP'.padEnd(nameWidth)}  ${'STATUS'.padEnd(STATUS_WIDTH)} ${'TIME'.padEnd(6)} DETAIL`,
  ];
  for (const r of results) {
    lines.push(
      `  ${r.name.padEnd(nameWidth)}  ${r.status.padEnd(STATUS_WIDTH)} ${fmtDuration(r.durationMs).padEnd(6)} ${oneLine(r.detail, 90)}`,
    );
  }
  const c = summarize(results);
  lines.push(`Result: ${c.PASS} passed, ${c.FAIL} failed, ${c.SKIPPED} skipped, ${c.BLOCKED} blocked`);
  return lines.join('\n');
}

export interface JsonReport {
  tool: 'gopaylocal-verify-provider';
  schemaVersion: 1;
  provider: string | null;
  mode: string;
  dryRun: boolean;
  environment: { effective: string; basis: string; allowLive: boolean } | null;
  refused: string | null;
  commit: string | null;
  node: string;
  startedAt: string;
  finishedAt: string;
  capabilities: Record<string, boolean> | null;
  steps: StepResult[];
  artifacts: Record<string, unknown>;
  summary: Record<StepStatus, number>;
  ok: boolean;
}

export function exitCodeFor(results: StepResult[], interrupted: boolean): number {
  if (interrupted) return 130;
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}
