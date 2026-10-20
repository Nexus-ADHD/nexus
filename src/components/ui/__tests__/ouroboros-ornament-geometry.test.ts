import { describe, expect, it } from 'vitest';
import {
  ALPHA,
  DIAL_MAJOR_EVERY,
  DIAL_TICKS,
  R_DIAL,
  R_INNER,
  R_ORBIT,
  R_ORBIT_OUTER,
  R_SPINE,
  ROSE_RAYS,
  cardinals,
  centre,
  dialTicks,
  hairline,
  ringRadii,
  roseRays,
} from '../ouroboros-ornament-geometry';

const SIZE = 360;
const C = SIZE / 2;
/** Distance from the hero's centre, which is what every radius is measured from. */
const rFrom = (x: number, y: number) => Math.hypot(x - C, y - C);

describe('ouroboros ornament — centring', () => {
  // The bug this suite exists for: the component first wrapped everything in
  // <G x y>, which react-native-svg does not treat as a translation, so the
  // whole ornament rendered in the top-left corner. Coordinates are absolute
  // now, and these assertions are what make that checkable in Node.
  it('puts the centre at the middle of the hero box', () => {
    expect(centre(SIZE)).toEqual({ cx: 180, cy: 180 });
    expect(centre(792)).toEqual({ cx: 396, cy: 396 });
  });

  it('centres every orbit on it, not on the origin', () => {
    const rings = ringRadii(SIZE);
    expect(rings.inner).toBeCloseTo(R_INNER * SIZE, 6);
    expect(rings.orbit).toBeCloseTo(R_ORBIT * SIZE, 6);
    expect(rings.outer).toBeCloseTo(R_ORBIT_OUTER * SIZE, 6);
  });

  it('emits every tick, mark and ray around the centre', () => {
    // if anything is still centre-relative it lands near (0,0) and this catches it
    for (const t of dialTicks(SIZE)) {
      expect(rFrom(t.x1, t.y1)).toBeCloseTo(R_DIAL * SIZE, 4);
    }
    for (const m of cardinals(SIZE)) {
      expect(rFrom(m.x, m.y)).toBeGreaterThan(R_ORBIT * SIZE);
    }
    for (const r of roseRays(SIZE)) {
      expect(rFrom(r.x2, r.y2)).toBeLessThan(R_INNER * SIZE);
    }
  });

  it('scales with the hero rather than assuming one size', () => {
    const small = dialTicks(104)[0];
    const large = dialTicks(792)[0];
    expect(Math.hypot(small.x1 - 52, small.y1 - 52)).toBeCloseTo(R_DIAL * 104, 4);
    expect(Math.hypot(large.x1 - 396, large.y1 - 396)).toBeCloseTo(R_DIAL * 792, 4);
  });
});

describe('ouroboros ornament — the orbits', () => {
  it('nest outward without crossing, and leave the numeral its room', () => {
    expect(R_INNER).toBeLessThan(R_SPINE);
    expect(R_SPINE).toBeLessThan(R_DIAL);
    expect(R_DIAL).toBeLessThan(R_ORBIT);
    expect(R_ORBIT).toBeLessThan(R_ORBIT_OUTER);
  });

  it('stay inside the hero box, marks included', () => {
    // a ring that clips its own frame reads as a bug, not as a crop
    for (const m of cardinals(SIZE)) expect(rFrom(m.x, m.y) + m.r).toBeLessThan(C);
    for (const t of dialTicks(SIZE)) expect(rFrom(t.x2, t.y2)).toBeLessThan(C);
    expect(ringRadii(SIZE).outer).toBeLessThan(C);
  });
});

describe('ouroboros ornament — the dial', () => {
  it('divides the circle evenly and marks every sixth tick', () => {
    const ticks = dialTicks(SIZE);
    expect(ticks).toHaveLength(DIAL_TICKS);
    expect(ticks.filter((t) => t.major)).toHaveLength(DIAL_TICKS / DIAL_MAJOR_EVERY);
  });

  it('draws every tick outward from the dial radius', () => {
    for (const t of dialTicks(SIZE)) {
      expect(rFrom(t.x2, t.y2)).toBeGreaterThan(rFrom(t.x1, t.y1));
    }
  });

  it("starts at twelve o'clock, which is where the tail is pinned", () => {
    const [first] = dialTicks(SIZE);
    expect(first.x1).toBeCloseTo(C, 6);
    expect(first.y1).toBeCloseTo(C - R_DIAL * SIZE, 6);
  });

  it('turns rigidly: rotation moves every tick by the same angle', () => {
    const a = dialTicks(SIZE, 0);
    const b = dialTicks(SIZE, 30);
    for (let i = 0; i < a.length; i += 1) {
      const angA = Math.atan2(a[i].y1 - C, a[i].x1 - C);
      const angB = Math.atan2(b[i].y1 - C, b[i].x1 - C);
      const delta = (((angB - angA) * 180) / Math.PI + 360) % 360;
      expect(delta).toBeCloseTo(30, 4);
    }
  });
});

describe('ouroboros ornament — the cardinal marks', () => {
  it('are four, at the quarters, with twelve filled as the origin', () => {
    const marks = cardinals(SIZE);
    expect(marks).toHaveLength(4);
    expect(marks.filter((m) => m.origin)).toHaveLength(1);
    expect(marks[0].origin).toBe(true);
    expect(marks[0].x).toBeCloseTo(C, 6);
    expect(marks[0].y).toBeLessThan(C); // twelve o'clock
  });

  it('draws the gold seal smaller than the three open marks', () => {
    const marks = cardinals(SIZE);
    const seal = marks.find((m) => m.origin)!;
    const open = marks.find((m) => !m.origin)!;
    expect(seal.r).toBeLessThan(open.r);
  });
});

describe('ouroboros ornament — the compass rose', () => {
  it('fills the inner disc without touching the inner orbit', () => {
    const rays = roseRays(SIZE);
    expect(rays).toHaveLength(ROSE_RAYS);
    for (const r of rays) {
      expect(rFrom(r.x2, r.y2)).toBeLessThan(R_INNER * SIZE);
      expect(rFrom(r.x1, r.y1)).toBeLessThan(rFrom(r.x2, r.y2));
    }
  });

  it("turns at half the dial's rate, so the two never lock together", () => {
    const [a] = roseRays(SIZE, 0);
    const [b] = roseRays(SIZE, 40);
    const delta =
      (((Math.atan2(b.y1 - C, b.x1 - C) - Math.atan2(a.y1 - C, a.x1 - C)) * 180) /
        Math.PI +
        360) %
      360;
    expect(delta).toBeCloseTo(20, 4);
  });
});

describe('ouroboros ornament — the gold budget', () => {
  it('spends gold on exactly one mark, and places it rather than stroking it', () => {
    // §4.4 makes gold a seal, not a stroke. If a future edit reaches for gold on
    // the rings, the dial, or the other three quarters, this should stop it.
    expect(cardinals(SIZE).filter((m) => m.origin)).toHaveLength(1);
    // everything else is white hairline or teal, and all of it is faint
    for (const key of ['orbit', 'orbitOuter', 'inner', 'tick', 'rose'] as const) {
      expect(ALPHA[key]).toBeLessThan(80);
    }
  });
});

describe('ouroboros ornament — hairlines', () => {
  it('never rounds away to nothing on a small hero', () => {
    for (const size of [40, 104, 264, 792]) {
      expect(hairline(size)).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(hairline(size))).toBe(true);
    }
  });
});
