import type { FrictionTotals } from "./types.ts";

export const HIGH_TOKEN_GROWTH_RATIO = 5;

export function emptyFrictionTotals(): FrictionTotals {
  return { observableSessions: 0, interruptions: 0, rejections: 0, compactions: 0, turns: 0 };
}

export interface FrictionContribution {
  interruptions: number;
  rejections: number;
  compactions: number;
  turns: number;
}

export function foldFriction(bucket: FrictionTotals, c: FrictionContribution): void {
  bucket.observableSessions += 1;
  bucket.interruptions += c.interruptions;
  bucket.rejections += c.rejections;
  bucket.compactions += c.compactions;
  bucket.turns += c.turns;
}
