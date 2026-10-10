import { describe, expect, it } from "vitest";
import { IDENTITY, MAX_SCALE, MIN_SCALE, contentToViewBox, fitTransform, panBy, toViewBox, viewBoxMapping, viewBoxToContent, wheelDeltaPx, zoomAbout, zoomFactor } from "../src/lib/viewport.ts";

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe("viewBoxMapping (xMidYMid meet)", () => {
  it("fits the viewBox uniformly and centres it", () => {
    // A 1000×500 picture in an 800×600 element: width-bound, s = 0.8, letterboxed vertically.
    expect(viewBoxMapping(800, 600, 1000, 500)).toEqual({ s: 0.8, ox: 0, oy: 100 });
    // Height-bound: s = 0.5, centred horizontally.
    expect(viewBoxMapping(800, 300, 400, 600)).toEqual({ s: 0.5, ox: 300, oy: 0 });
    // 1:1 when the sizes match; identity for degenerate sizes.
    expect(viewBoxMapping(640, 480, 640, 480)).toEqual({ s: 1, ox: 0, oy: 0 });
    expect(viewBoxMapping(0, 0, 100, 100)).toEqual({ s: 1, ox: 0, oy: 0 });
  });

  it("toViewBox undoes the mapping", () => {
    const m = viewBoxMapping(800, 600, 1000, 500);
    close(toViewBox(0, 100, m), { x: 0, y: 0 });
    close(toViewBox(800, 500, m), { x: 1000, y: 500 });
    close(toViewBox(400, 300, m), { x: 500, y: 250 });
  });
});

describe("zoomAbout", () => {
  it("leaves the content under the pointer where it is", () => {
    const t = { x: 37, y: -12, k: 1.3 };
    const p = { x: 210, y: 95 }; // the pointer, in viewBox units
    const under = viewBoxToContent(t, p);
    for (const factor of [1.1, 0.5, 3, 0.9]) {
      const t2 = zoomAbout(t, factor, p);
      expect(t2.k).toBeCloseTo(t.k * factor, 9);
      close(contentToViewBox(t2, under), p);
    }
  });

  it("clamps the scale and still anchors on the pointer", () => {
    const p = { x: 10, y: 10 };
    const big = zoomAbout(IDENTITY, 100, p);
    expect(big.k).toBe(MAX_SCALE);
    close(contentToViewBox(big, viewBoxToContent(IDENTITY, p)), p);
    const small = zoomAbout(IDENTITY, 0.001, p);
    expect(small.k).toBe(MIN_SCALE);
    close(contentToViewBox(small, viewBoxToContent(IDENTITY, p)), p);
    // At the bound a further zoom is a no-op (not a drift).
    expect(zoomAbout(big, 2, p)).toEqual(big);
  });

  it("is driven by a symmetric wheel factor, whatever the deltaMode", () => {
    expect(zoomFactor(-100) * zoomFactor(100)).toBeCloseTo(1, 12);
    expect(zoomFactor(-100)).toBeGreaterThan(1); // wheel up = zoom in
    expect(wheelDeltaPx({ deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelDeltaPx({ deltaY: 1, deltaMode: 2 })).toBe(800);
    expect(wheelDeltaPx({ deltaY: -53, deltaMode: 0 })).toBe(-53);
  });
});

describe("fitTransform", () => {
  it("scales the content down to fit the view with the padding and centres it", () => {
    // 2000×500 content in an 800×600 view, 16 px padding: width-bound, k = 768/2000.
    const t = fitTransform(2000, 500, 800, 600);
    expect(t.k).toBeCloseTo(0.384, 9);
    close(contentToViewBox(t, { x: 1000, y: 250 }), { x: 400, y: 300 }); // the content's centre lands on the view's
    close(contentToViewBox(t, { x: 0, y: 0 }), { x: 16, y: 300 - 250 * t.k });
    // Height-bound.
    expect(fitTransform(100, 2000, 800, 600).k).toBeCloseTo(568 / 2000, 9);
  });
  it("never enlarges past 1:1 (a lone card stays card-sized) and never below the zoom floor", () => {
    const small = fitTransform(120, 40, 800, 600);
    expect(small.k).toBe(1);
    close(contentToViewBox(small, { x: 60, y: 20 }), { x: 400, y: 300 });
    expect(fitTransform(120, 40, 800, 600, 16, 2).k).toBe(2);
    expect(fitTransform(1e6, 1e6, 800, 600).k).toBe(MIN_SCALE);
  });
  it("is the identity for degenerate sizes", () => {
    expect(fitTransform(0, 0, 800, 600)).toEqual(IDENTITY);
    expect(fitTransform(100, 100, 0, 600)).toEqual(IDENTITY);
  });
});

describe("panBy", () => {
  it("moves the content exactly as far as the pointer (in client px), independent of k", () => {
    const m = viewBoxMapping(800, 600, 1000, 500); // s = 0.8
    for (const k of [0.5, 1, 2.7]) {
      const t = { x: 5, y: 7, k };
      const c = { x: 123, y: 45 };
      const before = contentToViewBox(t, c);
      const after = contentToViewBox(panBy(t, 40, -24, m), c);
      // In client px the content moved by exactly the pointer delta.
      expect((after.x - before.x) * m.s).toBeCloseTo(40, 9);
      expect((after.y - before.y) * m.s).toBeCloseTo(-24, 9);
    }
  });

  it("is a plain translation at 1:1", () => {
    expect(panBy({ x: 1, y: 2, k: 3 }, 10, 20, { s: 1, ox: 0, oy: 0 })).toEqual({ x: 11, y: 22, k: 3 });
  });
});
