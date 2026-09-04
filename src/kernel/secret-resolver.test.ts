import { afterEach, describe, expect, test } from "bun:test";
import { resolveSecret, SecretResolutionError } from "./secret-resolver.ts";

/**
 * secret 解決の単体テスト(V1-M4-T02 / ADR-0020 §2d)。
 *
 * 核心は「失敗時のエラーメッセージに stdout(= secret になりうる値)を絶対に含めない」こと。
 * env 経路・command 経路の双方で、値がエラー文言に漏れないことを直接 assert する。
 * テスト内でも解決値を console.log しない。
 */
describe("resolveSecret", () => {
  describe("kind: env", () => {
    const varName = "ST_SECRET_RESOLVER_TEST_ENV";

    afterEach(() => {
      delete process.env[varName];
    });

    test("設定済みの環境変数の値を返す", async () => {
      process.env[varName] = "env-secret-value";
      const value = await resolveSecret({ kind: "env", value: varName });
      expect(value).toBe("env-secret-value");
    });

    test("未設定の環境変数は SecretResolutionError を投げる", async () => {
      delete process.env[varName];
      await expect(resolveSecret({ kind: "env", value: varName })).rejects.toBeInstanceOf(
        SecretResolutionError,
      );
    });

    test("空文字の環境変数は SecretResolutionError を投げる", async () => {
      process.env[varName] = "";
      await expect(resolveSecret({ kind: "env", value: varName })).rejects.toBeInstanceOf(
        SecretResolutionError,
      );
    });

    test("エラーメッセージに(規約として)値文字列が現れない", async () => {
      // 別ケースとして「エラー文言に値が漏れない」規約を確認する。
      // 未設定エラーなので値そのものは無いが、変数名は含んでよく、
      // 仮に近い値がセットされていても漏れないことを担保する意味で、
      // 一旦セットした値とは別に、未設定にしてから投げさせて文言を検査する。
      const leaked = "SHOULD-NOT-APPEAR-IN-ENV-ERROR";
      process.env[varName] = leaked;
      // 値ありでは成功してしまうので、未設定にして失敗させ、文言に値が無いことを見る。
      delete process.env[varName];
      let caught: unknown;
      try {
        await resolveSecret({ kind: "env", value: varName });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretResolutionError);
      const message = (caught as Error).message;
      expect(message).not.toContain(leaked);
      // 参照(変数名)はエラーに含めてよい。
      expect(message).toContain(varName);
    });
  });

  describe("kind: command", () => {
    test("stdout を secret として返す", async () => {
      const value = await resolveSecret({ kind: "command", value: "printf 'SECRET-VALUE-123'" });
      expect(value).toBe("SECRET-VALUE-123");
    });

    test("末尾の改行は1つだけ剥がす", async () => {
      const value = await resolveSecret({
        kind: "command",
        value: "printf 'SECRET-VALUE-123\\n'",
      });
      expect(value).toBe("SECRET-VALUE-123");
    });

    test("中間の改行は保持する", async () => {
      const value = await resolveSecret({
        kind: "command",
        value: "printf 'line1\\nline2\\n'",
      });
      // 末尾の1つだけ剥がれ、中間の改行は残る。
      expect(value).toBe("line1\nline2");
    });

    test("exit code が 0 以外なら SecretResolutionError を投げる", async () => {
      await expect(
        resolveSecret({ kind: "command", value: "exit 3; echo LEAK" }),
      ).rejects.toBeInstanceOf(SecretResolutionError);
    });

    test("失敗コマンドのエラーに stdout(LEAK)が含まれない", async () => {
      let caught: unknown;
      try {
        await resolveSecret({ kind: "command", value: "printf LEAK; exit 3" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretResolutionError);
      expect((caught as Error).message).not.toContain("LEAK");
    });

    test("【漏えい核心】失敗コマンドの message と String(error) の双方に stdout が漏れない", async () => {
      let caught: unknown;
      try {
        await resolveSecret({ kind: "command", value: "printf DONT-LEAK-STDOUT; exit 1" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretResolutionError);
      const error = caught as Error;
      expect(error.message).not.toContain("DONT-LEAK-STDOUT");
      expect(String(error)).not.toContain("DONT-LEAK-STDOUT");
    });

    test("exit code と stderr はエラーに含めてよい(参考情報として使える)", async () => {
      let caught: unknown;
      try {
        await resolveSecret({
          kind: "command",
          value: "printf STDERR-MARKER 1>&2; exit 7",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretResolutionError);
      const message = (caught as Error).message;
      // exit code はデバッグの手がかりとして含めてよい。
      expect(message).toContain("7");
      // stderr は secret ではないので含めてよい。
      expect(message).toContain("STDERR-MARKER");
    });
  });
});
