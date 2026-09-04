import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "./password.ts";

describe("password", () => {
  test("ハッシュは平文と異なり、argon2id 形式である", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toBe("correct horse battery staple");
    expect(hash).toContain("$argon2id$");
  });

  test("正しいパスワードは検証に成功する", async () => {
    const hash = await hashPassword("s3cret");
    expect(await verifyPassword("s3cret", hash)).toBe(true);
  });

  test("誤ったパスワードは検証に失敗する", async () => {
    const hash = await hashPassword("s3cret");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("同じパスワードでもハッシュはソルトにより毎回異なる", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });
});
