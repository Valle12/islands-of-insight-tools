import { describe, expect, test } from "bun:test";
import {
  DIAL_RADIUS,
  nearestVertex,
  vertexAngle,
  vertexPoint,
} from "../../src/pages/phasic-dial-solver/dialView";

describe("dial geometry", () => {
  test("position 0 points straight up", () => {
    for (const sides of [2, 3, 4, 5, 6, 12]) {
      expect(vertexAngle(0, sides)).toBe(-90);
      const p = vertexPoint(0, sides);
      expect(p.x).toBeCloseTo(0, 6);
      expect(p.y).toBeCloseTo(-DIAL_RADIUS, 6);
    }
  });

  test("positions are evenly spaced clockwise", () => {
    expect(vertexAngle(1, 4)).toBe(0);
    expect(vertexAngle(2, 4)).toBe(90);
    expect(vertexAngle(3, 4)).toBe(180);
    expect(vertexAngle(1, 6)).toBe(-30);
    expect(vertexAngle(3, 6)).toBe(90);
  });

  test("every position sits on the circumcircle", () => {
    for (let i = 0; i < 5; i++) {
      const p = vertexPoint(i, 5);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(DIAL_RADIUS, 6);
    }
  });

  test("a cursor snaps to the position it is nearest", () => {
    // Straight up, right, down, left on a square dial.
    expect(nearestVertex(0, -10, 4)).toBe(0);
    expect(nearestVertex(10, 0, 4)).toBe(1);
    expect(nearestVertex(0, 10, 4)).toBe(2);
    expect(nearestVertex(-10, 0, 4)).toBe(3);
  });

  test("a cursor between two positions rounds to the closer one", () => {
    // 10 degrees clockwise of straight up is still position 0 on a square.
    expect(nearestVertex(Math.sin(0.17), -Math.cos(0.17), 4)).toBe(0);
    // Just past the halfway line (45 degrees) it flips to position 1.
    expect(nearestVertex(Math.sin(0.8), -Math.cos(0.8), 4)).toBe(1);
  });

  test("snapping wraps rather than running off the end", () => {
    // Just anticlockwise of straight up must be the LAST position, not -1.
    expect(nearestVertex(-Math.sin(0.8), -Math.cos(0.8), 4)).toBe(3);
    expect(nearestVertex(-Math.sin(0.8), -Math.cos(0.8), 6)).toBe(5);
    // Exactly halfway back around a two-position dial.
    expect(nearestVertex(0, 10, 2)).toBe(1);
  });

  test("a many-sided dial still resolves every position", () => {
    for (let i = 0; i < 12; i++) {
      const p = vertexPoint(i, 12);
      expect(nearestVertex(p.x, p.y, 12)).toBe(i);
    }
  });
});
