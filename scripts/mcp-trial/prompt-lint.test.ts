import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { lintPrompt } from "./prompt-lint.ts";
import { loadScenario, scenariosDir } from "./scenario.ts";

describe("lintPrompt", () => {
  test("普通の日本語の依頼は通る", () => {
    expect(lintPrompt("プラットフォーム管理アプリを作って。アプリ一覧が見たい。")).toEqual([]);
  });

  test("ツール名や語彙の言及だけでは弾かない", () => {
    expect(lintPrompt("apply_diff で add_table してくれればいい。型は text で。")).toEqual([]);
  });

  test("コードフェンスを弾く", () => {
    const found = lintPrompt("これを適用して。\n```json\n{}\n```");
    expect(found.map((f) => f.kind)).toContain("code_fence");
  });

  test("チルダのコードフェンスも弾く", () => {
    expect(lintPrompt("~~~\nx\n~~~").map((f) => f.kind)).toContain("code_fence");
  });

  test("JSON オブジェクトリテラル(引用符付きキー)を弾く", () => {
    const found = lintPrompt('この差分を適用して: {"op": "add_table", "table": {"id": "books"}}');
    expect(found.map((f) => f.kind)).toContain("json_literal");
  });

  test("オブジェクトの配列を弾く", () => {
    expect(lintPrompt("operations は [{ ... }] の形で").map((f) => f.kind)).toContain(
      "json_literal",
    );
  });

  test("インラインコードに波括弧が入っていたら弾く", () => {
    expect(lintPrompt("`{id: books}` を渡して").map((f) => f.kind)).toContain("inline_code_brace");
  });

  test("インラインコードでも波括弧が無ければ通す", () => {
    expect(lintPrompt("`books` テーブルを作って")).toEqual([]);
  });

  test("インデント4桁のコードブロックを弾く", () => {
    const found = lintPrompt("こうして。\n\n    {\n      id: 1\n    }\n");
    expect(found.map((f) => f.kind)).toContain("indented_block");
  });

  test("違反には該当箇所の抜粋が付く", () => {
    const found = lintPrompt('{"a":1}');
    expect(found[0]?.excerpt).toContain('"a"');
  });
});

describe("scenarios/ のプロンプトは全部 lint を通る", () => {
  for (const file of readdirSync(scenariosDir()).filter((f) => f.endsWith(".md"))) {
    test(file, () => {
      const scenario = loadScenario(join(scenariosDir(), file));
      for (const turn of scenario.turns) {
        expect(lintPrompt(turn)).toEqual([]);
      }
    });
  }
});
