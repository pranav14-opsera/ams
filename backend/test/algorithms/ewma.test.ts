import { test } from "node:test";
import assert from "node:assert/strict";
import { ewmaDeviationSigma, initialEwmaState, updateEwma } from "../../src/algorithms/ewma";

test("initialEwmaState seeds mean from the first value, zero variance, count 1", () => {
  const state = initialEwmaState(100);
  assert.equal(state.mean, 100);
  assert.equal(state.variance, 0);
  assert.equal(state.observationCount, 1);
});

test("updateEwma moves the mean toward a new, higher value by lambda's proportion", () => {
  const state = initialEwmaState(100);
  const updated = updateEwma(state, 200, 0.2);
  assert.equal(updated.mean, 100 + 0.2 * 100); // 120
});

test("a constant sequence of identical values leaves the mean unchanged and variance at zero", () => {
  let state = initialEwmaState(50);
  for (let i = 0; i < 20; i++) state = updateEwma(state, 50, 0.3);
  assert.equal(state.mean, 50);
  assert.equal(state.variance, 0);
});

test("variance grows when values oscillate, and observationCount increments every update", () => {
  let state = initialEwmaState(100);
  state = updateEwma(state, 150, 0.3);
  state = updateEwma(state, 50, 0.3);
  state = updateEwma(state, 150, 0.3);
  assert.ok(state.variance > 0);
  assert.equal(state.observationCount, 4);
});

test("a higher lambda reacts faster to a step change than a lower lambda", () => {
  const stateHigh = updateEwma(initialEwmaState(100), 200, 0.5);
  const stateLow = updateEwma(initialEwmaState(100), 200, 0.1);
  assert.ok(stateHigh.mean > stateLow.mean);
});

test("lambda outside (0, 1] throws", () => {
  const state = initialEwmaState(100);
  assert.throws(() => updateEwma(state, 100, 0), RangeError);
  assert.throws(() => updateEwma(state, 100, 1.5), RangeError);
  assert.throws(() => updateEwma(state, 100, -0.1), RangeError);
});

test("a non-finite value throws rather than silently poisoning the running state", () => {
  const state = initialEwmaState(100);
  assert.throws(() => updateEwma(state, NaN, 0.2), RangeError);
  assert.throws(() => updateEwma(state, Infinity, 0.2), RangeError);
});

test("ewmaDeviationSigma returns 0 for a value exactly at the mean with zero variance", () => {
  const state = initialEwmaState(100);
  assert.equal(ewmaDeviationSigma(state, 100), 0);
});

test("ewmaDeviationSigma returns +Infinity for any deviation when variance is exactly zero (a genuinely unprecedented value against a perfectly stable baseline)", () => {
  const state = initialEwmaState(100);
  assert.equal(ewmaDeviationSigma(state, 101), Infinity);
});

test("ewmaDeviationSigma correctly reports how many standard deviations away a value sits", () => {
  let state = initialEwmaState(100);
  state = updateEwma(state, 120, 0.3);
  state = updateEwma(state, 80, 0.3);
  state = updateEwma(state, 120, 0.3);
  const stddev = Math.sqrt(state.variance);
  const sigma = ewmaDeviationSigma(state, state.mean + 2 * stddev);
  assert.ok(Math.abs(sigma - 2) < 1e-9);
});
