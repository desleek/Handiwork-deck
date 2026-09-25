/** Every review scores the technician on each of these; all are mandatory. */
export const REVIEW_CATEGORIES = ['quality', 'punctuality', 'communication', 'value', 'professionalism'] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export const REVIEW_CATEGORY_LABEL: Record<ReviewCategory, string> = {
  quality: 'Quality of work',
  punctuality: 'Punctuality',
  communication: 'Communication',
  value: 'Value for money',
  professionalism: 'Professionalism',
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

/** Short tags shown on a review, e.g. "Punctuality 5★". Only notable scores (≥4 or ≤2) are tagged. */
export function reviewTags(scores: Partial<ReviewScores>): string[] {
  return REVIEW_CATEGORIES.filter((c) => scores[c] !== undefined && (scores[c]! >= 4 || scores[c]! <= 2)).map(
    (c) => `${REVIEW_CATEGORY_LABEL[c]} ${scores[c]}★`,
  );
}
