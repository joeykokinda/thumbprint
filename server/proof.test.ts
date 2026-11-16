import { expect, test } from "bun:test";
import { postId, proofCode, provenHandle } from "./proof.ts";

test("only a post carrying the device's code proves the handle", () => {
  const owner = "5gCoExampleOwner";
  const post = { user: { screen_name: "SomeOne" }, text: `Linking this account. ${proofCode(owner)}` };
  expect(provenHandle(post, owner)).toBe("x:someone");
  expect(provenHandle(post, "AnotherOwner")).toBeNull(); // someone else's proof cannot be reused
  expect(provenHandle({ user: { screen_name: "SomeOne" }, text: "gm" }, owner)).toBeNull();
  expect(provenHandle({}, owner)).toBeNull();
  expect(postId("https://x.com/jack/status/20?s=20")).toBe("20");
  expect(postId("https://evil.example/jack/status/20")).toBeNull();
});
