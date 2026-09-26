-- Section 11 enum additions (committed before use in 008).
ALTER TYPE payment_settlement ADD VALUE IF NOT EXISTS 'escrow';
ALTER TYPE payment_purpose ADD VALUE IF NOT EXISTS 'promotion';
