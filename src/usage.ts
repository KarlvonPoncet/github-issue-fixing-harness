import { ensureNumber, ensureRecord, enumValue, rejectUnknown, SchemaError } from './util.js';

export type UsageValue = number | null;

/** Normalized provider usage. Missing provider fields remain undefined. */
export interface ModelUsage {
  inputTokens?: UsageValue;
  outputTokens?: UsageValue;
  cachedInputTokens?: UsageValue;
  cacheWriteTokens?: UsageValue;
  reasoningTokens?: UsageValue;
  totalTokens?: UsageValue;
  costUsd?: number | null;
}

export type UsageProvenance = 'complete' | 'partial' | 'unavailable' | 'not_applicable';
export type CostProvenance = 'pricing_configured' | 'not_configured' | 'unavailable';

/** Run-level accounting with null totals where a provider did not report a field. */
export interface UsageSummary {
  modelCalls: number;
  reportedCalls: number;
  missingCalls: number;
  partialCalls: number;
  inputTokens: UsageValue;
  outputTokens: UsageValue;
  cachedInputTokens: UsageValue;
  cacheWriteTokens: UsageValue;
  reasoningTokens: UsageValue;
  totalTokens: UsageValue;
  costUsd: number | null;
  provenance: UsageProvenance;
  costProvenance: CostProvenance;
}

const usageFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
] as const;

function nullableNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  integer: boolean,
): UsageValue | undefined {
  if (!(key in record) || record[key] === undefined) return undefined;
  if (record[key] === null) return null;
  return ensureNumber(record[key], `${path}.${key}`, { integer, min: 0 });
}

export function parseModelUsage(input: unknown, path = 'usage'): ModelUsage {
  const record = ensureRecord(input, path);
  rejectUnknown(record, usageFields, path);
  const result: ModelUsage = {};
  const inputTokens = nullableNumber(record, 'inputTokens', path, true);
  const outputTokens = nullableNumber(record, 'outputTokens', path, true);
  const cachedInputTokens = nullableNumber(record, 'cachedInputTokens', path, true);
  const cacheWriteTokens = nullableNumber(record, 'cacheWriteTokens', path, true);
  const reasoningTokens = nullableNumber(record, 'reasoningTokens', path, true);
  const totalTokens = nullableNumber(record, 'totalTokens', path, true);
  const costUsd = nullableNumber(record, 'costUsd', path, false);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) result.cachedInputTokens = cachedInputTokens;
  if (cacheWriteTokens !== undefined) result.cacheWriteTokens = cacheWriteTokens;
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (costUsd !== undefined) result.costUsd = costUsd;
  return result;
}

export function parseUsageSummary(input: unknown, path = 'usage'): UsageSummary {
  const record = ensureRecord(input, path);
  rejectUnknown(
    record,
    [
      'modelCalls',
      'reportedCalls',
      'missingCalls',
      'partialCalls',
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'cacheWriteTokens',
      'reasoningTokens',
      'totalTokens',
      'costUsd',
      'provenance',
      'costProvenance',
    ],
    path,
  );
  const result = {
    modelCalls: requiredCount(record, 'modelCalls', path),
    reportedCalls: requiredCount(record, 'reportedCalls', path),
    missingCalls: requiredCount(record, 'missingCalls', path),
    partialCalls: requiredCount(record, 'partialCalls', path),
    inputTokens: requiredNullableCount(record, 'inputTokens', path),
    outputTokens: requiredNullableCount(record, 'outputTokens', path),
    cachedInputTokens: requiredNullableCount(record, 'cachedInputTokens', path),
    cacheWriteTokens: requiredNullableCount(record, 'cacheWriteTokens', path),
    reasoningTokens: requiredNullableCount(record, 'reasoningTokens', path),
    totalTokens: requiredNullableCount(record, 'totalTokens', path),
    costUsd: requiredNullableCost(record, 'costUsd', path),
    provenance: requiredProvenance(record, 'provenance', path),
    costProvenance: requiredCostProvenance(record, 'costProvenance', path),
  } satisfies UsageSummary;
  if (result.reportedCalls + result.missingCalls !== result.modelCalls)
    throw new SchemaError(`${path}.reportedCalls and missingCalls must add to modelCalls`);
  if (result.partialCalls > result.reportedCalls)
    throw new SchemaError(`${path}.partialCalls cannot exceed reportedCalls`);
  return result;
}

function requiredCount(record: Record<string, unknown>, key: string, path: string): number {
  return ensureNumber(record[key], `${path}.${key}`, { integer: true, min: 0 });
}

function requiredNullableCount(
  record: Record<string, unknown>,
  key: string,
  path: string,
): UsageValue {
  const value = record[key];
  if (value === null) return null;
  return ensureNumber(value, `${path}.${key}`, { integer: true, min: 0 });
}

function requiredNullableCost(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | null {
  const value = record[key];
  if (value === null) return null;
  return ensureNumber(value, `${path}.${key}`, { min: 0 });
}

function requiredProvenance(
  record: Record<string, unknown>,
  key: string,
  path: string,
): UsageProvenance {
  return enumValue(
    record[key],
    ['complete', 'partial', 'unavailable', 'not_applicable'] as const,
    `${path}.${key}`,
  );
}

function requiredCostProvenance(
  record: Record<string, unknown>,
  key: string,
  path: string,
): CostProvenance {
  return enumValue(
    record[key],
    ['pricing_configured', 'not_configured', 'unavailable'] as const,
    `${path}.${key}`,
  );
}

export function unavailableUsage(): UsageSummary {
  return {
    modelCalls: 0,
    reportedCalls: 0,
    missingCalls: 0,
    partialCalls: 0,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costUsd: null,
    provenance: 'unavailable',
    costProvenance: 'unavailable',
  };
}

export function notApplicableUsage(): UsageSummary {
  return { ...unavailableUsage(), provenance: 'not_applicable' };
}

type TokenKey =
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteTokens'
  | 'reasoningTokens'
  | 'totalTokens';

/**
 * Summarize one sample per attempted model call. A missing field is null in the
 * aggregate instead of being treated as zero. Cached and reasoning fields are
 * optional provider breakdowns; input/output/total determine partial status.
 */
export function summarizeUsage(
  samples: Array<ModelUsage | undefined>,
  costsTrusted = false,
): UsageSummary {
  const modelCalls = samples.length;
  if (modelCalls === 0) return unavailableUsage();
  const reportedCalls = samples.filter((sample) => sample !== undefined).length;
  const missingCalls = modelCalls - reportedCalls;
  const partialCalls = samples.filter(
    (sample) =>
      sample !== undefined &&
      !['inputTokens', 'outputTokens', 'totalTokens'].every(
        (key) => typeof sample[key as keyof ModelUsage] === 'number',
      ),
  ).length;
  const sum = (key: TokenKey): UsageValue => {
    if (!samples.every((sample) => typeof sample?.[key] === 'number')) return null;
    return samples.reduce((total, sample) => total + (sample?.[key] as number), 0);
  };
  const allCostsReported = samples.every((sample) => typeof sample?.costUsd === 'number');
  return {
    modelCalls,
    reportedCalls,
    missingCalls,
    partialCalls,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cachedInputTokens: sum('cachedInputTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    costUsd:
      costsTrusted && allCostsReported
        ? samples.reduce((total, sample) => total + (sample?.costUsd as number), 0)
        : null,
    provenance:
      reportedCalls === 0
        ? 'unavailable'
        : missingCalls > 0 || partialCalls > 0
          ? 'partial'
          : 'complete',
    costProvenance: costsTrusted ? 'pricing_configured' : 'not_configured',
  };
}

export function aggregateUsage(summaries: UsageSummary[]): UsageSummary {
  const active = summaries.filter((summary) => summary.modelCalls > 0);
  if (active.length === 0)
    return summaries.some((summary) => summary.provenance === 'not_applicable')
      ? notApplicableUsage()
      : unavailableUsage();
  const metric = (key: TokenKey): UsageValue => {
    if (!active.every((summary) => typeof summary[key] === 'number')) return null;
    return active.reduce((total, summary) => total + (summary[key] as number), 0);
  };
  const pricingConfigured = active.every(
    (summary) => summary.costProvenance === 'pricing_configured' && summary.costUsd !== null,
  );
  return {
    modelCalls: active.reduce((total, summary) => total + summary.modelCalls, 0),
    reportedCalls: active.reduce((total, summary) => total + summary.reportedCalls, 0),
    missingCalls: active.reduce((total, summary) => total + summary.missingCalls, 0),
    partialCalls: active.reduce((total, summary) => total + summary.partialCalls, 0),
    inputTokens: metric('inputTokens'),
    outputTokens: metric('outputTokens'),
    cachedInputTokens: metric('cachedInputTokens'),
    cacheWriteTokens: metric('cacheWriteTokens'),
    reasoningTokens: metric('reasoningTokens'),
    totalTokens: metric('totalTokens'),
    costUsd: pricingConfigured
      ? active.reduce((total, summary) => total + (summary.costUsd as number), 0)
      : null,
    provenance: active.some((summary) => summary.provenance !== 'complete')
      ? 'partial'
      : 'complete',
    costProvenance: pricingConfigured ? 'pricing_configured' : 'not_configured',
  };
}
