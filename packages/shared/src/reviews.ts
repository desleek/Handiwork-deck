/** Section 7: every customer review scores the technician on each of these; all are mandatory. */
export const REVIEW_CATEGORIES = [
  'competence',
  'punctuality',
  'professionalism',
  'courtesy',
  'timeline',
  'transparency',
  'quality',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export const REVIEW_CATEGORY_LABEL: Record<ReviewCategory, string> = {
  competence: 'Competence',
  punctuality: 'Punctuality',
  professionalism: 'Professionalism',
  courtesy: 'Courtesy',
  timeline: 'Delivery timeline',
  transparency: 'Transparency & pricing fairness',
  quality: 'Quality of work',
};

/** Minimum length of the written part of a review. */
export const REVIEW_MIN_COMMENT_LENGTH = 10;

export type ReviewScores = Record<ReviewCategory, number>;

/** Overall rating: mean of the category scores, to 2 decimal places. */
export function overallRating(scores: ReviewScores): number {
  const vals = REVIEW_CATEGORIES.map((c) => scores[c]);
  if (vals.some((v) => !Number.isInteger(v) || v < 1 || v > 5)) throw new Error('Scores must be integers 1-5');
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

/** Short tags shown on a public review, e.g. "Punctuality 5★". Only notable scores (≥4 or ≤2) are tagged. */
export function reviewTags(scores: Partial<Record<string, number>>): string[] {
  return REVIEW_CATEGORIES.filter((c) => scores[c] !== undefined && (scores[c]! >= 4 || scores[c]! <= 2)).map(
    (c) => `${REVIEW_CATEGORY_LABEL[c]} ${scores[c]}★`,
  );
}

/**
 * Weighted-recent average: each rating's weight halves every `halfLifeDays`, so
 * recent work counts more. Used both for the public rating and for the Section 7a
 * labor rate adjustment.
 */
export function weightedRecentAverage(ratings: { value: number; at: Date }[], halfLifeDays: number, now = new Date()): number | null {
  if (!ratings.length) return null;
  let sum = 0;
  let weights = 0;
  for (const r of ratings) {
    const ageDays = Math.max(0, (now.getTime() - r.at.getTime()) / 86_400_000);
    const w = Math.pow(0.5, ageDays / halfLifeDays);
    sum += r.value * w;
    weights += w;
  }
  return Math.round((sum / weights) * 100) / 100;
}
