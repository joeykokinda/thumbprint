import { expect, test } from "bun:test";
import "./shared.js";

declare const normalizeText: (text: string) => string;
// What the composer holds (left) and what the timeline renders (right) must hash the same.
test("a typed draft and its rendered post normalize to the same text", () => {
  const same = (typed: string, rendered: string) => expect(normalizeText(typed)).toBe(normalizeText(rendered));
  same("read docs.solana.com now", "read  https://docs.solana.com  now");
  same("claim at jup.ag/claim, today", "claim at  https://jup.ag/claim , today");
  same("https://www.example.com/a/very/long/path?x=1", " https://example.com/a/very/lo… ");
  same("line one\nline two\n", "line one\nline two");
  expect(normalizeText("go to good.com")).not.toBe(normalizeText("go to evil.com"));
});
