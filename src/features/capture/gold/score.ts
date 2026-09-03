import { recognizeLocally } from '../local-recognizer';
import type { CaptureContext } from '../types';
import { GOLD_HABITS, NOW_REF } from './types';
import type { GoldCase } from './types';

export type GoldField = 'kind' | 'title' | 'dueAt' | 'habitId';

export interface GoldResult {
  case: GoldCase;
  /** Feld → stimmt. Felder, die der Fall nicht prüft, fehlen. */
  fields: Partial<Record<GoldField, boolean>>;
  actual: { kind: string; title: string; dueAt: string | null; habitId: string | null };
  ok: boolean;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function scoreCase(gold: GoldCase): GoldResult {
  const ctx: CaptureContext = {
    now: gold.now ?? NOW_REF,
    tz: 'Europe/Berlin',
    habits: gold.habits ?? GOLD_HABITS,
    allowedKinds: ['task', 'event', 'habit_check'],
  };
  const draft = recognizeLocally(gold.text, ctx).items[0];
  const actual = {
    kind: draft.kind,
    title: draft.title,
    dueAt: draft.dueAt,
    habitId: draft.habitId,
  };

  const fields: Partial<Record<GoldField, boolean>> = {
    kind: draft.kind === gold.expect.kind,
    title: norm(draft.title) === norm(gold.expect.title),
    dueAt: draft.dueAt === gold.expect.dueAt,
  };
  if (gold.expect.habitId !== undefined) fields.habitId = draft.habitId === gold.expect.habitId;

  return { case: gold, fields, actual, ok: Object.values(fields).every(Boolean) };
}

export interface Bucket {
  total: number;
  ok: number;
  fields: Record<GoldField, { checked: number; ok: number }>;
}

function emptyBucket(): Bucket {
  return {
    total: 0,
    ok: 0,
    fields: {
      kind: { checked: 0, ok: 0 },
      title: { checked: 0, ok: 0 },
      dueAt: { checked: 0, ok: 0 },
      habitId: { checked: 0, ok: 0 },
    },
  };
}

function add(bucket: Bucket, result: GoldResult): void {
  bucket.total++;
  if (result.ok) bucket.ok++;
  for (const [field, passed] of Object.entries(result.fields) as [GoldField, boolean][]) {
    bucket.fields[field].checked++;
    if (passed) bucket.fields[field].ok++;
  }
}

export interface GoldReport {
  overall: Bucket;
  byCategory: Map<string, Bucket>;
  bySource: Map<string, Bucket>;
  failures: GoldResult[];
}

export function scoreCorpus(cases: GoldCase[]): GoldReport {
  const report: GoldReport = {
    overall: emptyBucket(),
    byCategory: new Map(),
    bySource: new Map(),
    failures: [],
  };
  for (const gold of cases) {
    const result = scoreCase(gold);
    add(report.overall, result);
    for (const [map, key] of [
      [report.byCategory, gold.category],
      [report.bySource, gold.source],
    ] as [Map<string, Bucket>, string][]) {
      if (!map.has(key)) map.set(key, emptyBucket());
      add(map.get(key)!, result);
    }
    if (!result.ok) report.failures.push(result);
  }
  return report;
}

export function pct(ok: number, total: number): string {
  if (total === 0) return '  — ';
  return `${((ok / total) * 100).toFixed(1).padStart(5)}%`;
}
