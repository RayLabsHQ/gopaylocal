import { describe, it, expect } from 'vitest';
import {
  createExperimentSchema,
  updateExperimentSchema,
  endExperimentSchema,
  DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B,
} from './index';

const base = { productId: 'prod_1', campaignAId: 'camp_a', campaignBId: 'camp_b', name: 'India 30% vs 45%' };

describe('createExperimentSchema', () => {
  it('defaults the split to 50 and trims the name', () => {
    const parsed = createExperimentSchema.parse({ ...base, name: '  India test  ' });
    expect(parsed.trafficSplitB).toBe(DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B);
    expect(DEFAULT_EXPERIMENT_TRAFFIC_SPLIT_B).toBe(50);
    expect(parsed.name).toBe('India test');
  });

  it('accepts splits from 1 to 99 and rejects 0, 100 and fractions', () => {
    expect(createExperimentSchema.safeParse({ ...base, trafficSplitB: 1 }).success).toBe(true);
    expect(createExperimentSchema.safeParse({ ...base, trafficSplitB: 99 }).success).toBe(true);
    expect(createExperimentSchema.safeParse({ ...base, trafficSplitB: 0 }).success).toBe(false);
    expect(createExperimentSchema.safeParse({ ...base, trafficSplitB: 100 }).success).toBe(false);
    expect(createExperimentSchema.safeParse({ ...base, trafficSplitB: 50.5 }).success).toBe(false);
  });

  it('rejects the same campaign as both arms, on campaignBId', () => {
    const r = createExperimentSchema.safeParse({ ...base, campaignBId: 'camp_a' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['campaignBId']);
  });

  it('rejects a blank name, a name over 200 characters and missing ids', () => {
    expect(createExperimentSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createExperimentSchema.safeParse({ ...base, name: 'x'.repeat(201) }).success).toBe(false);
    expect(createExperimentSchema.safeParse({ ...base, productId: '' }).success).toBe(false);
    const { campaignBId: _omit, ...noB } = base;
    expect(createExperimentSchema.safeParse(noB).success).toBe(false);
  });
});

describe('updateExperimentSchema', () => {
  it('does not inject the create default: a name-only update has no split', () => {
    const parsed = updateExperimentSchema.parse({ name: 'Renamed' });
    expect(parsed).toEqual({ name: 'Renamed' });
    expect('trafficSplitB' in parsed).toBe(false);
  });

  it('accepts a split-only update and validates its range', () => {
    expect(updateExperimentSchema.parse({ trafficSplitB: 30 })).toEqual({ trafficSplitB: 30 });
    expect(updateExperimentSchema.safeParse({ trafficSplitB: 0 }).success).toBe(false);
    expect(updateExperimentSchema.safeParse({ trafficSplitB: 100 }).success).toBe(false);
  });

  it('rejects an empty update', () => {
    expect(updateExperimentSchema.safeParse({}).success).toBe(false);
  });

  it('does not let the arms, product or status be changed', () => {
    const parsed = updateExperimentSchema.parse({ name: 'x', campaignAId: 'other', status: 'ended', productId: 'p2' });
    expect(parsed).toEqual({ name: 'x' });
  });
});

describe('endExperimentSchema', () => {
  it('requires a winner campaign id', () => {
    expect(endExperimentSchema.safeParse({ winnerCampaignId: 'camp_b' }).success).toBe(true);
    expect(endExperimentSchema.safeParse({}).success).toBe(false);
    expect(endExperimentSchema.safeParse({ winnerCampaignId: '' }).success).toBe(false);
  });
});
