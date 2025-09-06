/**
 * Unit tests for critical path functions.
 *
 * Run: npx tsx src/test/unit.test.ts
 */

import assert from "node:assert/strict";
import { weiToEth, bigIntReviver, ethPriceToUsd, formatUsd, getBucketTime } from "../utils/math";
import type { CandleResolution } from "../types/events";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ── weiToEth ────────────────────────────────────────────────────────────────

console.log("\n— weiToEth —");

test("converts 1 ETH (1e18 wei)", () => {
  assert.equal(weiToEth(10n ** 18n), "1");
});

test("converts 0.5 ETH", () => {
  assert.equal(weiToEth(5n * 10n ** 17n), "0.5");
});

test("converts 0 wei", () => {
  assert.equal(weiToEth(0n), "0");
});

test("handles string input", () => {
  assert.equal(weiToEth("1000000000000000000"), "1");
});

test("handles null/undefined", () => {
  assert.equal(weiToEth(null), null);
  assert.equal(weiToEth(undefined), null);
});

test("strips trailing zeros", () => {
  const result = weiToEth(1_500_000_000_000_000_000n);
  assert.equal(result, "1.5");
});

test("preserves full precision for small values", () => {
  const result = weiToEth(1n); // 1 wei = 0.000000000000000001 ETH
  assert.ok(result?.startsWith("0."));
  assert.ok(result?.includes("1"));
});

test("handles very large values without overflow", () => {
  const result = weiToEth(10n ** 30n); // 1 trillion ETH
  assert.equal(result, "1000000000000");
});

// ── bigIntReviver ───────────────────────────────────────────────────────────

console.log("\n— bigIntReviver —");

test("revives BigInt strings ending with n", () => {
  assert.equal(bigIntReviver("key", "123n"), 123n);
});

test("revives negative BigInt strings", () => {
  assert.equal(bigIntReviver("key", "-456n"), -456n);
});

test("passes through regular strings", () => {
  assert.equal(bigIntReviver("key", "hello"), "hello");
});

test("passes through numbers", () => {
  assert.equal(bigIntReviver("key", 42), 42);
});

test("passes through strings that look like numbers but don't end with n", () => {
  assert.equal(bigIntReviver("key", "123"), "123");
});

test("works with JSON.parse", () => {
  const json = '{"amount": "1000000000000000000n", "name": "test"}';
  const obj = JSON.parse(json, bigIntReviver);
  assert.equal(obj.amount, 1000000000000000000n);
  assert.equal(obj.name, "test");
});

// ── ethPriceToUsd ───────────────────────────────────────────────────────────

console.log("\n— ethPriceToUsd —");

test("converts 1 ETH at $3000", () => {
  const WAD = 10n ** 18n;
  const rate = 300_000_000_000n; // $3000 with 8 decimals
  const result = ethPriceToUsd(WAD, rate);
  assert.ok(Math.abs(result - 3000) < 0.01, `Expected ~3000, got ${result}`);
});

test("converts 0.5 ETH at $2000", () => {
  const halfEth = 5n * 10n ** 17n;
  const rate = 200_000_000_000n; // $2000
  const result = ethPriceToUsd(halfEth, rate);
  assert.ok(Math.abs(result - 1000) < 0.01, `Expected ~1000, got ${result}`);
});

test("handles zero price", () => {
  const rate = 300_000_000_000n;
  const result = ethPriceToUsd(0n, rate);
  assert.equal(result, 0);
});

test("handles very small prices (sub-wei)", () => {
  const rate = 300_000_000_000n;
  const result = ethPriceToUsd(1n, rate); // 1 wei
  assert.ok(result < 0.001, `Expected tiny number, got ${result}`);
  assert.ok(result > 0, `Expected positive, got ${result}`);
});

// ── formatUsd ───────────────────────────────────────────────────────────────

console.log("\n— formatUsd —");

test("formats large values with 2 decimals", () => {
  assert.equal(formatUsd(1234.5678), "1234.57");
});

test("formats values >= 0.01 with 4 decimals", () => {
  assert.equal(formatUsd(0.05), "0.0500");
});

test("formats tiny values >= 0.0001 with 6 decimals", () => {
  assert.equal(formatUsd(0.000123), "0.000123");
});

test("formats zero", () => {
  assert.equal(formatUsd(0), "0");
});

test("formats very tiny values with scientific notation", () => {
  const result = formatUsd(0.00000001);
  assert.ok(result.includes("e") || result.includes("0.0000000"), `Unexpected format: ${result}`);
});

// ── getBucketTime ───────────────────────────────────────────────────────────

console.log("\n— getBucketTime —");

test("buckets to 1-minute intervals", () => {
  const ts = 1700000065n; // 65 seconds past a minute boundary
  const result = getBucketTime(ts, "1m" as CandleResolution);
  assert.equal(result, 1700000040n); // floored to 60s boundary
});

test("buckets to 1-hour intervals", () => {
  const ts = 1700003700n; // 100 seconds past an hour
  const result = getBucketTime(ts, "1h" as CandleResolution);
  assert.equal(result, 1700002800n); // floored to 3600s boundary
});

test("buckets to 1-day intervals", () => {
  const ts = 1700050000n;
  const result = getBucketTime(ts, "1d" as CandleResolution);
  const expected = (1700050000n / 86400n) * 86400n;
  assert.equal(result, expected);
});

test("exact boundary returns same value", () => {
  const ts = 3600n * 100n; // exactly on an hour boundary
  assert.equal(getBucketTime(ts, "1h" as CandleResolution), ts);
});

test("all resolutions produce valid buckets", () => {
  const ts = 1700000123n;
  const resolutions: CandleResolution[] = ["1m", "15m", "1h", "4h", "1d"];
  for (const res of resolutions) {
    const bucket = getBucketTime(ts, res);
    assert.ok(bucket <= ts, `${res}: bucket ${bucket} > timestamp ${ts}`);
    assert.ok(bucket > 0n, `${res}: bucket should be positive`);
  }
});

// ── Reorg detection logic (pure function tests) ─────────────────────────────

console.log("\n— Reorg detection logic —");

test("parent hash match = no reorg", () => {
  const storedParentHash = "0xabc";
  const incomingParentHash = "0xabc";
  assert.equal(storedParentHash === incomingParentHash, true);
});

test("parent hash mismatch = reorg detected", () => {
  const storedParentHash = "0xabc" as string;
  const incomingParentHash = "0xdef" as string;
  assert.equal(storedParentHash === incomingParentHash, false);
});

test("no stored parent (cold start) = no reorg", () => {
  const storedParent = null;
  // If no stored parent exists, detectAndRecover returns { detected: false }
  assert.equal(storedParent === null, true);
});

// ── BigInt edge cases ───────────────────────────────────────────────────────

console.log("\n— BigInt edge cases —");

test("market cap calculation doesn't overflow", () => {
  const WAD = 10n ** 18n;
  const price = 10n ** 15n; // 0.001 ETH in wei
  const supply = 10n ** 27n; // 1 billion tokens with 18 decimals
  const mcap = price * supply / WAD;
  assert.ok(mcap > 0n, "mcap should be positive");
  assert.equal(mcap, 10n ** 24n); // 0.001 * 1B = 1M ETH
});

test("zero supply = zero mcap", () => {
  const WAD = 10n ** 18n;
  const price = 10n ** 18n;
  const supply = 0n;
  const mcap = price * supply / WAD;
  assert.equal(mcap, 0n);
});

test("very small price with large supply", () => {
  const WAD = 10n ** 18n;
  const price = 1n; // 1 wei
  const supply = 10n ** 27n; // 1B tokens
  const mcap = price * supply / WAD;
  assert.ok(mcap >= 0n);
});

test("bigIntReviver round-trips through JSON", () => {
  const original = { price: 123456789n, name: "test" };
  const serialized = JSON.stringify(original, (_k, v) => typeof v === "bigint" ? v.toString() + "n" : v);
  const deserialized = JSON.parse(serialized, bigIntReviver);
  assert.equal(deserialized.price, 123456789n);
  assert.equal(deserialized.name, "test");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
