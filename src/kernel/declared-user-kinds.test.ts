/**
 * **アプリが「利用者の種類」を宣言できるようにする**(`V5-M17-T02`。`G-G5` /
 * [`ADR-0158`](../../docs/adr/0158-declared-user-kinds.md) 限定1・限定3・限定4・限定6・限定8)。
 *
 * **審査記録**: [`docs/plan/v5/records/v5-m12.md`](../../docs/plan/v5/records/v5-m12.md) §3-1。
 * **実施記録**: [`docs/plan/v5/records/v5-m17.md`](../../docs/plan/v5/records/v5-m17.md)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**: **値域の閉じ方がすべて `schemas/manifest.schema.json` の側に在ること。**
 * **`ADR-0158` 限定6 が `src/kernel/` に1バイトの差分も許さない**ので、予約語・上限8種・
 * 識別子の形の3つは**JSON Schema だけで**閉じている。**したがって拒否は
 * `validateManifestFull`(= `applyDiff` / `applyManifest` / `createApp` が通る1本)で起きる。**
 *
 * **測らないもの(誇張しない)**:
 * 1. **同じ `id` を2本書いた宣言を、本検査は拒否できない。** `uniqueItems` はオブジェクト
 *    全体の同値でしか効かず、`id` が同じで `name` が違う2本は通る。**`ADR-0158` 限定6 が
 *    `src/kernel/` の差分を1バイトも許さないので、id の重複検査を置く場所が無い。**
 *    **これは限界であって、直したのではない。**
 * 2. **宣言を書き込む差分操作は1つも無い**(`DIFF_OPS` は 16 のままである = 限定6)。
 *    **今日この宣言を書けるのは `applyManifest` を直に呼ぶ経路と `manifest.json` の
 *    直接編集だけであり、MCP / HTTP の `apply_diff` からは書けない。**
 *    **17種目の op を足すには `ADR-0158` §3a の門A が要る。**
 *
 * ---
 *
 * ## 【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11` / `T-G12`。判定値 = 廃止】
 *
 * **上のドキュメントは1バイトも消していない。** **`ADR-0158` 制定時の事実であって、
 * 今日の正ではない。**
 *
 * ### このファイルが何を測っていたか(着手前)
 *
 * **マニフェストの器 `app.user_kinds` の**値域**が、`schemas/manifest.schema.json` の側だけで
 * 閉じていること。** **25本すべてが `manifestWithKinds(...)` を `validateManifestFull` に
 * 通し、「この形は通る / この形は拒否される」の境目を測っていた。**
 *
 * ### 今日は何を測るか
 *
 * **器そのものが `$defs/app` から消えた。** **したがって「値域の境目」は1本も測れない** ——
 * **どんな中身を書いても、`/app` の `additionalProperties: false` が同じ1つの理由で拒否する。**
 * **同じ25本を、次の3つを固定する形に入れ替えた**(1本も消していないし、`skip` もしていない):
 *
 * 1. **`$defs/app` から `user_kinds` が綴りごと消えていること**(キーは 9 → 8)。
 * 2. **`user_kinds` を書いたマニフェストが、`/app` の1点で拒否されること**
 *    (`allowed_values` は `id` / `name` / `tables` / `views` / `workflows` / `functions` /
 *    `theme` / `roles` の8つ)。
 * 3. **`FIELD_TYPES` / `RESOURCE_KINDS` / `DIFF_OPS` の3配列に、利用者の種類を表す語が
 *    1つも無いこと**(`set_user_kinds` を含めて。**`ADR-0248` 以前の形に戻った**)。
 *
 * ### 担い手が無いもの(**このファイルで今日1バイトも測れなくなったもの。名指しで書く**)
 *
 * - **予約語(`owner` / `editor` / `viewer` / `anonymous`)を宣言できないこと**
 *   (`ADR-0158` 限定1)…… **`user_kinds` 側の `items.id.not.enum` は器ごと消えた。**
 *   **`app.roles[].id` には `not` が1つも無い** —— **今日はその4語を役割として宣言できる。**
 *   **担い手は無い。**
 * - **本数の上限が8種であること**(限定3)…… **`maxItems: 8` は消えた。**
 *   **`app.roles` の `maxItems` は 12 であり、同じ境目ではない。担い手は無い。**
 * - **識別子の形が `^[a-z0-9_]{1,32}$` に閉じること**(限定4)…… **`app.roles[].id` が
 *   同じパターンを持つが、それは別の器の値域であって、この器の担い手ではない。**
 * - **`id` と `name` の2キーしか持てないこと**(限定2 の構造での担保)……
 *   **`items` そのものが消えた。担い手は無い。**
 * - **同じ `id` を2本書いた宣言を拒否できない、という限界**(上の「測らないもの」1)
 *   …… **器ごと消えたので、この限界は今日1バイトも測れない。担い手は無い。**
 */

import { describe, expect, test } from "bun:test";
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { DIFF_OPS, FIELD_TYPES, RESOURCE_KINDS } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

function defs(): Record<string, Any> {
  return (manifestSchema as unknown as { $defs: Record<string, Any> }).$defs;
}

function appProperties(): Any {
  return ((defs().app as Any).properties ?? {}) as Any;
}

/** `user_kinds` だけを差し替えた最小マニフェスト。 */
function manifestWithKinds(kinds: unknown): unknown {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [],
      views: [],
      user_kinds: kinds,
    },
  } satisfies { app: Any };
}

/**
 * **【`V8-M29` 第2波】どんな中身でも、拒否は `/app` の1点で起きる。**
 * **「何を書いたか」で `path` が変わらないことが、値域が消えたことの実測である。**
 */
function rejection(kinds: unknown): { path?: string | undefined; message?: string | undefined } {
  const result = validateManifestFull(manifestWithKinds(kinds));
  if (result.valid) {
    return {};
  }
  const first = result.errors[0];
  return { path: first?.path, message: first?.message };
}

const UNKNOWN_KEY_MESSAGE = '未知のプロパティ "user_kinds" は指定できません。';

const VALID_KINDS = [
  { id: "member", name: "会員" },
  { id: "supplier", name: "取引先" },
];

describe("(T02-1) 宣言キーは `$defs/app` 直下の1本である(`ADR-0158` 限定8)", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`$defs/app` に `user_kinds` が在る」。
  // **旧行の逐語**: `expect(appProperties().user_kinds).toBeDefined();`
  test("`$defs/app` に `user_kinds` は在らない(綴りごと消えた)", () => {
    expect(appProperties().user_kinds).toBeUndefined();
    expect(Object.keys(appProperties())).not.toContain("user_kinds");
  });

  // 【`V5-M29-T03` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
  //   消したテスト名(逐語): 「`$defs` の本数は 28 のままである(新しい `$defs` を作らない)」
  //   そのブロックが測っていたもの:
  //     - `expect(Object.keys(defs())).toHaveLength(28)`
  //     - 消した位置にあったコメントの逐語: 「**この 28 は着手前の実測値である**(`docs/plan/v5/records/v5-m17.md` §0)。
  //       **`ADR-0158` 限定8 が「`$defs` の本数を増やさない」を求めているので、本行は
  //       「本タスクが増やさなかったこと」を測る** —— **後続が増やしたら赤くなる。**
  //       **その意味で `v5-merge-repair-2.md` §5 が数えた焼き込みの 156 箇所と同じ形である。**」
  //   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
  //   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
  //   検出力0のまま `Ran` を水増しする)。
  //   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

  // **【`V8-M16-T02` / `J-G1b` / `D-V8-31`】期待値を 8 → 9 に、テスト名を実体に合わせて
  // 書き換えた。****旧テスト名の逐語は「`$defs/app` のキーは 7 → 8 で、増えたのは
  // `user_kinds` の1本だけである」、旧行の逐語は `expect(keys).toHaveLength(8);` である。**
  // **書き換えた理由**: この検査が固定していたのは「`ADR-0158` が `$defs/app` に足したのは
  // `user_kinds` の1本だけである」ことであり、9本目 `roles` を足したのは別の決定
  // (`V8-M16` の器の新設。門A 本審査 = 限定採用)である。**検査は消していない** ——
  // 下の `arrayContaining` と `toContain` が「`user_kinds` が消えていないこと」を今日も測る。
  //
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】期待値を 9 → 8 に戻し、
  // 末尾の `toContain` を反転させた。**
  // **旧テスト名の逐語**: 「`$defs/app` のキーは 7 → 8 で、増えたのは `user_kinds` の
  // 1本だけである(のち `V8-M16` が9本目 `roles` を足して 8 → 9)」。
  // **旧行の逐語**: `expect(keys).toHaveLength(9);` / `expect(keys).toContain("user_kinds");`
  // **本数は 8 に戻ったが、8本目は `user_kinds` ではなく `roles` である。**
  // **【禁止の履行】足した1本と消した1本を差し引きして「元に戻った」と書かない。**
  test("`$defs/app` のキーは 9 → 8 で、消えたのは `user_kinds` の1本だけである", () => {
    const keys = Object.keys(appProperties());
    expect(keys).toHaveLength(8);
    // **着手前の7本を名前で持つ** —— **本数だけを数える形にしない**(消えたら赤くなる)。
    expect(keys).toEqual(
      expect.arrayContaining(["id", "name", "tables", "views", "workflows", "functions", "theme"]),
    );
    // **8本目は `V8-M16` が足した `roles` である**(本波はこちらを1バイトも触っていない)。
    expect(keys).toContain("roles");
    expect(keys).not.toContain("user_kinds");
  });

  test("宣言を書かないマニフェストは今日どおり通る(既定を変えない)", () => {
    // **【`V8-M29` 第2波】この1本は1バイトも書き換えていない** ——
    // **器を撤去しても、器を使っていないアプリは1つも壊れない、というのが本波の前提である。**
    const result = validateManifestFull({ app: { id: "shop", name: "店", tables: [], views: [] } });
    expect(result.valid).toBe(true);
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「宣言を書いたマニフェストが通る」。
  // **旧行の逐語**:
  //   `const result = validateManifestFull(manifestWithKinds(VALID_KINDS));`
  //   `expect(result.valid).toBe(true);`
  // **【この1本が、既存アプリに起きることそのものである】** **`user_kinds` を書いて
  // 保存されている既存アプリは、今日から `validateManifestFull` を通らない。**
  // **救済は実装に1つも無い**(`ADR-0301` 限定6 の ④)。
  test("宣言を書いたマニフェストは今日から拒否される(`/app` の1点。既存アプリの救済は無い)", () => {
    const result = validateManifestFull(manifestWithKinds(VALID_KINDS));
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.errors[0]?.path).toBe("/app");
    expect(result.valid === false && result.errors[0]?.message).toBe(UNKNOWN_KEY_MESSAGE);
    expect(result.valid === false && result.errors[0]?.allowed_values).toEqual([
      "id",
      "name",
      "tables",
      "views",
      "workflows",
      "functions",
      "theme",
      "roles",
    ]);
  });
});

describe("(T02-2) 予約語は宣言できない(`ADR-0158` 限定1)", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】拒否の理由が変わった。**
  // **旧テスト名の逐語**: `` `${reserved}` を宣言したら拒否される ``。
  // **旧行の逐語**:
  //   `const result = validateManifestFull(manifestWithKinds([{ id: reserved, name: "x" }]));`
  //   `expect(result.valid).toBe(false);`
  // **拒否は `items.id.not.enum` が出していた。****今日その `not.enum` は器ごと消えており、
  // 拒否を出しているのは `/app` の `additionalProperties: false` である。**
  // **【担い手が無いもの】** **予約語の締め出しは、今日どこにも無い** ——
  // **`app.roles[].id` はこの4語を拒否しない。**
  for (const reserved of ["owner", "editor", "viewer"]) {
    test(`\`${reserved}\` を書いても拒否されるが、理由は予約語ではなく器の不在である`, () => {
      expect(rejection([{ id: reserved, name: "x" }])).toEqual({
        path: "/app",
        message: UNKNOWN_KEY_MESSAGE,
      });
    });
  }

  // **【2026-08-11。`V8-M29` 第2波】上の3語とまったく同じ理由に変わった。**
  // **旧テスト名の逐語**: 「`anonymous` も宣言できない(`audience` の値と衝突するため。限定より狭い側)」。
  // **旧行の逐語**: `expect(result.valid).toBe(false);`
  // **【隠さない】** **`audience` は `V8-M20` がキーごと廃止しており、衝突相手そのものが
  // 今日は無い。**
  test("`anonymous` も同じ理由で拒否される(衝突相手の `audience` は `V8-M20` が廃止済み)", () => {
    expect(rejection([{ id: "anonymous", name: "x" }])).toEqual({
      path: "/app",
      message: UNKNOWN_KEY_MESSAGE,
    });
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`customer` は予約語ではないので宣言できる(既定の1本目。限定3)」。
  // **旧行の逐語**:
  //   `const result = validateManifestFull(manifestWithKinds([{ id: "customer", name: "お客様" }]));`
  //   `expect(result.valid).toBe(true);`
  // **【禁止の履行】「予約語と同じ扱いになった」とは書かない** —— **予約語だから拒否
  // されているのではなく、器が無いから拒否されている。****区別が今日は付かない。**
  test("`customer` も今日は拒否される(予約語と区別が付かない。旧: 通っていた)", () => {
    expect(rejection([{ id: "customer", name: "お客様" }])).toEqual({
      path: "/app",
      message: UNKNOWN_KEY_MESSAGE,
    });
  });
});

describe("(T02-3) 本数の上限は8種である(`ADR-0158` 限定3)", () => {
  const kinds = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `kind_${i}`, name: `種類${i}` }));

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「8種は通る」。
  // **旧行の逐語**: `expect(validateManifestFull(manifestWithKinds(kinds(8))).valid).toBe(true);`
  test("8種も今日は拒否される(旧: 通っていた)", () => {
    expect(rejection(kinds(8))).toEqual({ path: "/app", message: UNKNOWN_KEY_MESSAGE });
  });

  // **【2026-08-11。`V8-M29` 第2波】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「9種目は拒否される」。
  // **旧行の逐語**: `expect(validateManifestFull(manifestWithKinds(kinds(9))).valid).toBe(false);`
  // **【担い手が無いもの】** **8と9の境目は今日1バイトも観測できない** ——
  // **上の8種とまったく同じ `path` / `message` で拒否される。**
  test("9種も8種とまったく同じ理由で拒否される —— 上限8の境目は今日観測できない", () => {
    expect(rejection(kinds(9))).toEqual(rejection(kinds(8)));
    expect(rejection(kinds(9))).toEqual({ path: "/app", message: UNKNOWN_KEY_MESSAGE });
  });

  // **【2026-08-11。`V8-M29` 第2波】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「空配列は拒否される(`undefined` と `[]` を混ぜない)」。
  // **旧行の逐語**: `expect(validateManifestFull(manifestWithKinds([])).valid).toBe(false);`
  // **`undefined` と `[]` の区別は今日も付く** —— **`undefined`(キーを書かない)は通り、
  // `[]`(キーを書く)は拒否される。****ただし拒否しているのは `minItems: 1` ではない。**
  test("空配列は拒否され、キーを書かない場合は通る(理由は `minItems` ではなく器の不在)", () => {
    expect(rejection([])).toEqual({ path: "/app", message: UNKNOWN_KEY_MESSAGE });
    expect(
      validateManifestFull({ app: { id: "shop", name: "店", tables: [], views: [] } }).valid,
    ).toBe(true);
  });
});

describe("(T02-4) 識別子の形は有限に閉じる(`ADR-0158` 限定4)", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】拒否の理由が変わった。**
  // **旧テスト名の逐語**: `` `${bad.slice(0, 12)}` は拒否される ``。
  // **旧行の逐語**:
  //   `expect(validateManifestFull(manifestWithKinds([{ id: bad, name: "x" }])).valid).toBe(false);`
  // **拒否は `items.id.pattern` が出していた。****今日その `pattern` は器ごと消えている。**
  for (const bad of [
    "会員", // 日本語
    "two words", // 空白
    "Member", // 大文字
    "with-hyphen", // 記号
    "", // 空文字
    "x".repeat(33), // 33文字
  ]) {
    test(`\`${bad.slice(0, 12)}\` は拒否されるが、理由は \`pattern\` ではなく器の不在である`, () => {
      expect(rejection([{ id: bad, name: "x" }])).toEqual({
        path: "/app",
        message: UNKNOWN_KEY_MESSAGE,
      });
    });
  }

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「32文字ちょうどは通る」。
  // **旧行の逐語**:
  //   `expect(validateManifestFull(manifestWithKinds([{ id: "a".repeat(32), name: "x" }])).valid).toBe(`
  //   `  true,`
  //   `);`
  // **【担い手が無いもの】** **32文字と33文字の境目は今日1バイトも観測できない。**
  test("32文字ちょうども今日は拒否される —— 32 と 33 の境目は観測できない(旧: 通っていた)", () => {
    expect(rejection([{ id: "a".repeat(32), name: "x" }])).toEqual({
      path: "/app",
      message: UNKNOWN_KEY_MESSAGE,
    });
    expect(rejection([{ id: "a".repeat(32), name: "x" }])).toEqual(
      rejection([{ id: "a".repeat(33), name: "x" }]),
    );
  });

  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「表示名(`name`)は別キーで、日本語を書ける」。
  // **旧行の逐語**:
  //   `const result = validateManifestFull(manifestWithKinds([{ id: "member", name: "会員のみなさま" }]));`
  //   `expect(result.valid).toBe(true);`
  // **【担い手が無いもの】** **「識別子と表示名を別キーに分ける」という設計そのものが、
  // この器については今日1バイトも残っていない。**
  test("表示名を書いた正しい宣言も今日は拒否される(旧: 通っていた)", () => {
    expect(rejection([{ id: "member", name: "会員のみなさま" }])).toEqual({
      path: "/app",
      message: UNKNOWN_KEY_MESSAGE,
    });
  });

  // **【2026-08-11。`V8-M29` 第2波】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「`name` を書かないと拒否される」。
  // **旧行の逐語**: `expect(validateManifestFull(manifestWithKinds([{ id: "member" }])).valid).toBe(false);`
  // **拒否は `items.required` が出していた。****今日は `name` の有無で1文字も変わらない。**
  test("`name` を書かなくても書いても、まったく同じ理由で拒否される(`required` は測れない)", () => {
    expect(rejection([{ id: "member" }])).toEqual({ path: "/app", message: UNKNOWN_KEY_MESSAGE });
    expect(rejection([{ id: "member" }])).toEqual(rejection([{ id: "member", name: "会員" }]));
  });

  // **【2026-08-11。`V8-M29` 第2波】拒否の理由が変わった。**
  // **旧テスト名の逐語**: 「規約に無いキーを足すと拒否される(`additionalProperties: false`)」。
  // **旧行の逐語**:
  //   `const result = validateManifestFull(`
  //   `  manifestWithKinds([{ id: "member", name: "会員", can_write: ["orders"] }]),`
  //   `);`
  //   `expect(result.valid).toBe(false);`
  // **`additionalProperties: false` が拒否している点は同じだが、**効いている位置が
  // `items` から `/app` へ1段上がった**。
  test("規約に無いキーを足しても拒否されるが、効いているのは `items` ではなく `/app` の `additionalProperties` である", () => {
    // **種類ごとに規則を宣言するキーを1本も作らない**(`ADR-0158` 限定2)。
    expect(rejection([{ id: "member", name: "会員", can_write: ["orders"] }])).toEqual({
      path: "/app",
      message: UNKNOWN_KEY_MESSAGE,
    });
  });
});

describe("(T02-5) 種類ごとに規則を宣言するキーは1本も無い(`ADR-0158` 限定2)", () => {
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】向きを反転させた。**
  // **旧テスト名の逐語**: 「`user_kinds` の要素が持てるキーは `id` と `name` の2本だけである」。
  // **旧行の逐語**:
  //   `const item = ((appProperties().user_kinds as Any).items ?? {}) as Any;`
  //   `expect(Object.keys((item.properties ?? {}) as Any).sort()).toEqual(["id", "name"]);`
  //   `expect(item.additionalProperties).toBe(false);`
  // **【担い手が無いもの。名指しで書く】** **要素の形(`id` と `name` の2本だけ)は、
  // `items` ごと消えたので今日1バイトも測れない。**
  // **`app.roles[].rules` は「役割 x 対象 x できること」を書ける** —— **旧 `user_kinds` が
  // 1本も持たなかった「種類ごとの規則」は、今日は書ける。****つまりこの限定2 は
  // 引き継がれていない。**
  test("`user_kinds` の `items` そのものが今日は無い(要素の形は測れない)", () => {
    expect(appProperties().user_kinds).toBeUndefined();
    // **代わりに立つ器は、規則を持てる**(限定2 は引き継がれていない。隠さない)。
    const roleItem = ((appProperties().roles as Any).items ?? {}) as Any;
    // **【2026-08-14 追記(`V8-M1-T02`。台帳 `I-G1` / `I-G6` = どちらも 限定採用。
    // `ADR-0334` 限定1)。旧の期待値を1バイトも消していない】**
    // **旧(逐語)**: `expect(Object.keys((roleItem.properties ?? {}) as Any).sort()).toEqual(["id", "name", "rules"]);`
    // **4キー目 `signup`(この役割で登録できるか)を `V8-M1-T02` が足した。**
    // **`ADR-0158` 限定2 の残余(宣言された種類が運営の権限を持たないこと)を
    // `signup` は1ミリも破らない** —— **登録に招待を要求しても、その役割が持つ権限は
    // 1つも増えない**(`ADR-0334` 限定8)。
    expect(Object.keys((roleItem.properties ?? {}) as Any).sort()).toEqual([
      "id",
      "name",
      "rules",
      "signup",
    ]);
  });
});

describe("(T02-6) カーネル語彙を1つも動かしていない(`ADR-0158` 限定6)", () => {
  // **`v5-merge-repair-2.md` §3-2 が採った形を踏襲する** —— **総量ではなく「着手前の名前が
  // 今日も全部在ること」と「本タスクが足しそうな名前がどこにも無いこと」を測る。**
  // **後続が語彙を足しても赤くならない。消したら・改名したら赤くなる。**
  //
  // **【`V8-M29` 第2波】この1本は1バイトも書き換えていない** —— **本波が消したのは
  // ここに名前で持っていない `set_user_kinds` の1語だけであり、この32語は今日も全部在る。**
  test("着手前の `FIELD_TYPES` / `RESOURCE_KINDS` / `DIFF_OPS` の名前が1つも消えていない", () => {
    expect(FIELD_TYPES).toEqual(
      expect.arrayContaining([
        "text",
        "long_text",
        "number",
        "boolean",
        "date",
        "select",
        "reference",
        "image",
        "file",
      ]),
    );
    expect(RESOURCE_KINDS).toEqual(
      expect.arrayContaining([
        "app",
        "table",
        "form",
        "list_view",
        "detail_view",
        "workflow",
        "function",
      ]),
    );
    expect(DIFF_OPS).toEqual(
      expect.arrayContaining([
        "add_table",
        "add_field",
        "add_view",
        "update_view",
        "remove_field",
        "remove_table",
        "change_table",
        "change_field",
        "remove_view",
        "add_workflow",
        "update_workflow",
        "remove_workflow",
        "add_function",
        "update_function",
        "remove_function",
        "set_theme",
      ]),
    );
  });

  // **【`V5-M17b` / `ADR-0248` により、この検査は意味が変わった】**
  // **旧テスト名の逐語**: 「利用者の種類を表す語を3配列のどこにも足していない」。
  // **旧の禁止語リストには `set_user_kinds` が入っていた。** **今日は `DIFF_OPS` の
  // 17種目として実在するので、その1語だけを禁止リストから外した。**
  // **`ADR-0158` 限定6(`DIFF_OPS` を1つも動かさない)は `ADR-0248` が正面から破った** ——
  // 破る手続き(門A の本審査 + 同格の個別 ADR)は `ADR-0158` §3a の 5 が要求しており、
  // **`ADR-0248` がその ADR である。****「限定6 は守られている」とは書かない。**
  // **残る7語は今日も禁止のままである** —— **`RESOURCE_KINDS` にも `FIELD_TYPES` にも
  // 利用者の種類は1語も入っておらず、`DIFF_OPS` に入ったのは全体差し替えの1 op だけである。**
  //
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】禁止リストに
  // `set_user_kinds` を戻した。**
  // **旧テスト名の逐語**: 「利用者の種類を表す語は、`set_user_kinds` の1語を除いて3配列の
  // どこにも無い」。
  // **旧行の逐語**:
  //   `expect([...FIELD_TYPES, ...RESOURCE_KINDS] as readonly string[]).not.toContain(`
  //   `  "set_user_kinds",`
  //   `);`
  //   `expect(DIFF_OPS as readonly string[]).toContain("set_user_kinds");`
  // **【禁止の履行】これを「`ADR-0158` 限定6 が回復した」と書かない** ——
  // **限定6 は「`DIFF_OPS` を1つも動かさない」であり、本波は動かした側である
  // (減らす向きに)。****3配列の見た目が `ADR-0248` 以前と同じになっただけである。**
  test("利用者の種類を表す語は、`set_user_kinds` を含めて3配列のどこにも無い", () => {
    const all = [...FIELD_TYPES, ...RESOURCE_KINDS, ...DIFF_OPS] as readonly string[];
    for (const word of [
      "user_kind",
      "user_kinds",
      "role",
      "roles",
      "audience",
      "add_user_kind",
      "declare_user_kind",
      // **部分更新・削除の op を1つも足していない**(`ADR-0248` 限定1 / 限定2 / 限定3)。
      "remove_user_kind",
      "update_user_kind",
      "unset_user_kinds",
      // **【`V8-M29` 第2波が禁止リストへ戻した1語】** **全体差し替えの op も今日は無い。**
      "set_user_kinds",
    ]) {
      expect(all).not.toContain(word);
    }
    // **代わりに立つ `set_roles` は `DIFF_OPS` にだけ在る**(`RESOURCE_KINDS` /
    // `FIELD_TYPES` は今日も無傷である)。
    expect([...FIELD_TYPES, ...RESOURCE_KINDS] as readonly string[]).not.toContain("set_roles");
    expect(DIFF_OPS as readonly string[]).toContain("set_roles");
  });
});
