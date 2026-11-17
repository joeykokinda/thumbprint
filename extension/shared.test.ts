import { expect, test } from "bun:test";
import "./shared.js";
declare const normalizeText: (text: string) => string;

test("approval preserves complete destinations and meaningful text", () => {
  const original = "Claim at https://example.com/legit?wallet=alice";
  for (const altered of [
    "Claim at https://example.com/drainer?wallet=alice",
    "Claim at https://example.com/legit?wallet=attacker",
    "Claim at http://example.com/legit?wallet=alice",
    "Claim at https://example.com/leg…",
    "Claim at https://www.example.com/legit?wallet=alice",
  ]) expect(normalizeText(altered)).not.toBe(normalizeText(original));
  expect(normalizeText("pay 10")).not.toBe(normalizeText("pay １０"));
  expect(normalizeText("one  two")).not.toBe(normalizeText("one two"));
  expect(normalizeText("line one\r\nline two\n")).toBe("line one\nline two");
});
