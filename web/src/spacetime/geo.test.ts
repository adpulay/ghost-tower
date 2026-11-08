import assert from "node:assert/strict";
import { test } from "node:test";
import { corridorPolygon, offsetM, pointInPolygon, type LatLon } from "./geo.ts";

const A: LatLon = [32.9788, -96.79];

test("corridorPolygon: covers the path and 300 m either side, but not beyond", () => {
  // 2 km due east, sampled every 100 m like a prediction.
  const path = Array.from({ length: 21 }, (_, i) => offsetM(A, 0, i * 100));
  const zone = corridorPolygon(path, 300);
  assert.ok(zone.length >= 3);
  assert.equal(pointInPolygon(offsetM(A, 0, 1000), zone), true, "on the path");
  assert.equal(pointInPolygon(offsetM(A, 250, 1000), zone), true, "250 m north of it");
  assert.equal(pointInPolygon(offsetM(A, -250, 1000), zone), true, "250 m south of it");
  assert.equal(pointInPolygon(offsetM(A, 450, 1000), zone), false, "450 m north is outside");
  assert.equal(pointInPolygon(offsetM(A, 0, 2500), zone), false, "past the end of the path");
  assert.equal(pointInPolygon(offsetM(A, 0, 200), zone), true, "near the start");
});

test("corridorPolygon: a zone built from a later prediction moves with the car", () => {
  const early = corridorPolygon(Array.from({ length: 21 }, (_, i) => offsetM(A, 0, i * 100)), 300);
  const later = corridorPolygon(Array.from({ length: 21 }, (_, i) => offsetM(A, 0, 1500 + i * 100)), 300);
  const phoneAhead = offsetM(A, 20, 3000);
  assert.equal(pointInPolygon(phoneAhead, early), false, "outside the old zone");
  assert.equal(pointInPolygon(phoneAhead, later), true, "inside the refreshed zone");
});

test("corridorPolygon: edge cases", () => {
  assert.deepEqual(corridorPolygon([]), []);
  assert.ok(corridorPolygon([A]).length >= 3);
});
