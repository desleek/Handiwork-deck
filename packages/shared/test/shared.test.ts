import { describe, expect, it } from 'vitest';
import { canTransition, haversineKm, splitFee, toMajor, toMinor } from '../src';

describe('job state machine', () => {
  it('allows the happy path for the right actors', () => {
    expect(canTransition('open', 'quoted', 'system')).toBe(true);
    expect(canTransition('quoted', 'assigned', 'customer')).toBe(true);
    expect(canTransition('assigned', 'en_route', 'technician')).toBe(true);
    expect(canTransition('en_route', 'in_progress', 'technician')).toBe(true);
    expect(canTransition('in_progress', 'completed', 'technician')).toBe(true);
    expect(canTransition('completed', 'paid', 'system')).toBe(true);
  });

  it('rejects wrong actors and skipped steps', () => {
    expect(canTransition('quoted', 'assigned', 'technician')).toBe(false);
    expect(canTransition('open', 'completed', 'technician')).toBe(false);
    expect(canTransition('completed', 'paid', 'customer')).toBe(false);
    expect(canTransition('cancelled', 'open', 'admin')).toBe(false);
  });
});

describe('money', () => {
  it('splits the platform fee in minor units', () => {
    expect(splitFee(100_000, { bps: 1000 })).toEqual({ gross: 100_000, platformFee: 10_000, payeeAmount: 90_000 });
  });

  it('applies min / max clamps and never exceeds gross', () => {
    expect(splitFee(1_000, { bps: 1000, min: 500 }).platformFee).toBe(500);
    expect(splitFee(10_000_000, { bps: 1000, max: 250_000 }).platformFee).toBe(250_000);
    expect(splitFee(100, { bps: 1000, min: 500 }).platformFee).toBe(100);
  });

  it('rejects non-integer amounts', () => {
    expect(() => splitFee(10.5, { bps: 100 })).toThrow();
  });

  it('converts between major and minor units per currency', () => {
    expect(toMinor(1500.5, 'NGN')).toBe(150_050);
    expect(toMajor(150_050, 'NGN')).toBe(1500.5);
    expect(toMinor(5000, 'UGX')).toBe(5000);
  });
});

describe('geo', () => {
  it('computes great-circle distance', () => {
    // Lagos (Ikeja) -> Lagos (Victoria Island) is roughly 18-20 km.
    const d = haversineKm({ lat: 6.6018, lng: 3.3515 }, { lat: 6.4281, lng: 3.4219 });
    expect(d).toBeGreaterThan(17);
    expect(d).toBeLessThan(22);
  });
});
