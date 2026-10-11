/**
 * **一意違反の文言の宣言(`$defs/field` の `unique_message`)の語彙と適用時の拒否**
 * (`V23-M2-T01`。上位: `docs/adr/0498-unique-message-reject-and-atomic-creator-grant.md` の
 * §Decision 1・限定1・限定3、`docs/adr/0517-v23-m2-guard-authorization-and-conditional-rows.md`
 * の §Decision 7、計画 `docs/plan/v23/00-v23-plan.md` §21-2 の T01 と §21-4 の「T01 に足す」、
 * 決定 `D-V23-46`・`D-V23-56`)。
 *
 * ## このファイルが測るもの
 *
 * - (A) 受け入れ: `unique: true` と `unique: "owner"` の両方に書ける。 陰性対照(書かない宣言は今日どおり)。
 * - (R) 定義だけで決まる拒否: `unique` の無い列・`unique: false` の列に書くと断る / 0文字・201文字・
 *   文字列でない値を断る / 長さは文字(コードポイント)で数える(サロゲートペアを含む200文字は通り、
 *   201文字は断る)。
 * - (D) 差分を当てて測る: `add_field` と `change_field` で足せる / `change_field` の `null` で外せて、
 *   外すと定義が宣言前と1バイトも違わない / `unique` を外して文言が残る形は断る / `unique` の無い列へ
 *   `change_field` で文言だけ足す形も断る / `undo` で戻る。
 *
 * ## このファイルが測らないもの
 *
 * - 書込時に文言が返ること・422 と `kind`(`src/server/unique-message.test.ts`。`V23-M2-T03`)。
 * - MCP と HTTP の口(このファイルはカーネルの `validateManifestFull`・`applyDiff` を直接呼ぶ)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import type { Diff, Manifest } from "./types.ts";
import { undo } from "./undo.ts";
import { validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const APP_ID = "umsg";

const MESSAGE = "既に別の組織に所属しています";

/** 1文字で UTF-16 の2単位になる文字(サロゲートペア)。 */
const WIDE = "\u{20BB7}";

/** `members` の `member` 列(差し替えの題材)と、`unique` の無い `memo` 列を持つマニフェスト。 */
function manifestWith(memberField: Any = { id: "member", name: "利用者", type: "text" }): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "所属",
      tables: [
        {
          id: "members",
          name: "所属",
          fields: [memberField, { id: "memo", name: "メモ", type: "text" }],
        },
      ],
      views: [{ id: "member-list", type: "list_view", table: "members", columns: ["member"] }],
    },
  } as unknown as Manifest;
}

function errorsOf(result: { valid: boolean; errors?: ValidationError[] }): ValidationError[] {
  return result.valid ? [] : (result.errors ?? []);
}

const UM = "/app/tables/0/fields/0/unique_message";

/** 定義を直接検べて、`unique_message` を指す拒否が1件以上あることを見る。 */
function expectRejectedAt(field: Any, pathPrefix: string = UM): ValidationError[] {
  const result = validateManifestFull(manifestWith(field));
  expect(result.valid, JSON.stringify(field)).toBe(false);
  const errors = errorsOf(result);
  expect(
    errors.some((error) => error.path.startsWith(pathPrefix)),
    JSON.stringify(errors),
  ).toBe(true);
  return errors;
}

// ---------------------------------------------------------------------------
// (A) 受け入れ
// ---------------------------------------------------------------------------

describe("(A) 受け入れ", () => {
  test("(A-1) unique: true の列に unique_message を書ける", () => {
    const result = validateManifestFull(
      manifestWith({
        id: "member",
        name: "利用者",
        type: "text",
        unique: true,
        unique_message: MESSAGE,
      }),
    );
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  test('(A-2) unique: "owner" の列にも unique_message を書ける(D-V23-46)', () => {
    const result = validateManifestFull(
      manifestWith({
        id: "member",
        name: "利用者",
        type: "text",
        unique: "owner",
        unique_message: MESSAGE,
      }),
    );
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  test("(A-3) 陰性対照: unique_message を書かない宣言は今日どおり通る", () => {
    for (const field of [
      { id: "member", name: "利用者", type: "text" },
      { id: "member", name: "利用者", type: "text", unique: true },
      { id: "member", name: "利用者", type: "text", unique: "owner" },
    ]) {
      const result = validateManifestFull(manifestWith(field));
      expect(result.valid, JSON.stringify(result)).toBe(true);
    }
  });

  test("(A-4) 9型のどれにも書ける(unique を書ける型ならどれでも)", () => {
    for (const field of [
      { type: "text" },
      { type: "long_text" },
      { type: "number" },
      { type: "boolean" },
      { type: "date" },
      { type: "select", options: ["a", "b"] },
      { type: "reference", reference_table: "members" },
      { type: "image" },
      { type: "file" },
    ]) {
      const result = validateManifestFull(
        manifestWith({
          id: "member",
          name: "利用者",
          ...field,
          unique: true,
          unique_message: MESSAGE,
        }),
      );
      expect(result.valid, `${field.type} ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (R) 定義だけで決まる拒否
// ---------------------------------------------------------------------------

describe("(R) 定義だけで決まる拒否", () => {
  test("(R-1a) unique の無い列に書くと断られる(書けるが効かない宣言を作らない)", () => {
    const errors = expectRejectedAt({
      id: "member",
      name: "利用者",
      type: "text",
      unique_message: MESSAGE,
    });
    const hit = errors.find((error) => error.path === UM);
    expect(hit, JSON.stringify(errors)).toBeDefined();
    expect(hit?.message).toContain("unique");
  });

  test("(R-1b) unique: false の列に書くと断られる", () => {
    const errors = expectRejectedAt({
      id: "member",
      name: "利用者",
      type: "text",
      unique: false,
      unique_message: MESSAGE,
    });
    expect(
      errors.find((error) => error.path === UM),
      JSON.stringify(errors),
    ).toBeDefined();
  });

  test("(R-2a) 0文字は断られる", () => {
    expectRejectedAt({
      id: "member",
      name: "利用者",
      type: "text",
      unique: true,
      unique_message: "",
    });
  });

  test("(R-2b) 201文字は断られ、200文字は通る", () => {
    expectRejectedAt({
      id: "member",
      name: "利用者",
      type: "text",
      unique: true,
      unique_message: "あ".repeat(201),
    });
    const ok = validateManifestFull(
      manifestWith({
        id: "member",
        name: "利用者",
        type: "text",
        unique: true,
        unique_message: "あ".repeat(200),
      }),
    );
    expect(ok.valid, JSON.stringify(ok)).toBe(true);
  });

  test("(R-2c) 長さは文字(コードポイント)で数える: サロゲートペアを含む200文字は通り、201文字は断る(D-V23-56)", () => {
    // 200文字 = サロゲートペア100文字 + 普通の100文字(UTF-16 では300単位)。
    const twoHundred = WIDE.repeat(100) + "あ".repeat(100);
    expect([...twoHundred]).toHaveLength(200);
    expect(twoHundred.length).toBe(300);
    const ok = validateManifestFull(
      manifestWith({
        id: "member",
        name: "利用者",
        type: "text",
        unique: true,
        unique_message: twoHundred,
      }),
    );
    expect(ok.valid, JSON.stringify(ok)).toBe(true);

    // 全部がサロゲートペアの200文字(UTF-16 では400単位)も通る。
    const allWide = validateManifestFull(
      manifestWith({
        id: "member",
        name: "利用者",
        type: "text",
        unique: true,
        unique_message: WIDE.repeat(200),
      }),
    );
    expect(allWide.valid, JSON.stringify(allWide)).toBe(true);

    expectRejectedAt({
      id: "member",
      name: "利用者",
      type: "text",
      unique: true,
      unique_message: `${twoHundred}あ`,
    });
    expectRejectedAt({
      id: "member",
      name: "利用者",
      type: "text",
      unique: true,
      unique_message: WIDE.repeat(201),
    });
  });

  test("(R-3) 文字列でない値は断られる", () => {
    for (const bad of [42, true, ["a"], { text: "a" }]) {
      expectRejectedAt({
        id: "member",
        name: "利用者",
        type: "text",
        unique: true,
        unique_message: bad,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// (D) 差分を当てて測る
// ---------------------------------------------------------------------------

describe("(D) 差分を当てて測る", () => {
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-unique-message-decl-"));
    store = KernelMetaStore.open(dataRoot);
    createApp(store, "所属", { app_id: APP_ID });
    // **キーの並びを `id` / `name` / `unique` / `type` にしてある。** `change_field` は今日も
    // 項目を `buildChangedField`(`apply-diff.ts`)で組み直し、`type` を `unique` の後ろへ
    // 並べ直す(文言の宣言と関係なく、どの `change_field` でも起きる今日の挙動)。 並びを
    // 最初からそろえておくことで、(D-5) の「1バイトも違わない」が文言の足し外しだけを測る。
    const applied = applyManifest(
      dataRoot,
      APP_ID,
      manifestWith({ id: "member", name: "利用者", unique: true, type: "text" }),
    );
    if (!applied.valid) {
      throw new Error(`初期マニフェストの投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  function manifestJson(): string {
    return JSON.stringify(readCurrentManifest(dataRoot, APP_ID));
  }

  function fieldOf(tableField: string): Any | undefined {
    const table = readCurrentManifest(dataRoot, APP_ID).app.tables[0] as unknown as {
      fields: Any[];
    };
    return table.fields.find((field) => field.id === tableField);
  }

  function changeField(diffId: string, field: string, changes: Any) {
    return applyDiff(dataRoot, APP_ID, {
      diff_id: diffId,
      intent: "一意違反の文言を変える",
      operations: [{ op: "change_field", table: "members", field, changes }],
    } as unknown as Diff);
  }

  function declareMessage(): void {
    const result = changeField("d-declare", "member", { unique_message: MESSAGE });
    if (!result.valid) {
      throw new Error(`宣言の適用に失敗: ${JSON.stringify(result.errors)}`);
    }
  }

  test("(D-1) add_field で unique と一緒に足せ、定義に残る", () => {
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-add",
      intent: "一意の列を足す",
      operations: [
        {
          op: "add_field",
          table: "members",
          field: {
            id: "code",
            name: "コード",
            type: "text",
            unique: "owner",
            unique_message: MESSAGE,
          },
        },
      ],
    } as unknown as Diff);
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(fieldOf("code")?.unique_message).toBe(MESSAGE);
  });

  test("(D-2) add_field で unique の無い列に書くと断られ、定義は変わらない", () => {
    const before = manifestJson();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-add-bad",
      intent: "一意でない列に文言を書く",
      operations: [
        {
          op: "add_field",
          table: "members",
          field: { id: "code", name: "コード", type: "text", unique_message: MESSAGE },
        },
      ],
    } as unknown as Diff);
    expect(result.valid).toBe(false);
    expect(
      errorsOf(result).some((error) => error.path.endsWith("unique_message")),
      JSON.stringify(errorsOf(result)),
    ).toBe(true);
    expect(manifestJson()).toBe(before);
  });

  test("(D-3) change_field で既存の一意の列に足せ、定義に残る", () => {
    declareMessage();
    expect(fieldOf("member")).toEqual({
      id: "member",
      name: "利用者",
      type: "text",
      unique: true,
      unique_message: MESSAGE,
    });
  });

  test("(D-4) change_field で文言だけを書き換えられる", () => {
    declareMessage();
    const result = changeField("d-reword", "member", { unique_message: "登録済みです" });
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(fieldOf("member")?.unique_message).toBe("登録済みです");
  });

  test("(D-5) change_field で null を書くと外れ、定義が宣言前と1バイトも違わない", () => {
    const before = manifestJson();
    declareMessage();
    expect(manifestJson()).not.toBe(before);
    const removed = changeField("d-undeclare", "member", { unique_message: null });
    expect(removed.valid, JSON.stringify(removed)).toBe(true);
    expect(manifestJson()).toBe(before);
  });

  test("(D-6) change_field で unique を外して unique_message が残る形は断られ、定義は変わらない(D-V23-56)", () => {
    declareMessage();
    const before = manifestJson();
    const result = changeField("d-unique-false", "member", { unique: false });
    expect(result.valid).toBe(false);
    expect(
      errorsOf(result).some((error) => error.path.endsWith("unique_message")),
      JSON.stringify(errorsOf(result)),
    ).toBe(true);
    expect(manifestJson()).toBe(before);
  });

  test("(D-7) unique と unique_message を同じ change_field で一緒に外すと通る", () => {
    declareMessage();
    const result = changeField("d-both-off", "member", { unique: false, unique_message: null });
    expect(result.valid, JSON.stringify(result)).toBe(true);
    const field = fieldOf("member");
    expect(field?.unique).toBe(false);
    expect(field !== undefined && "unique_message" in field).toBe(false);
  });

  test("(D-8) change_field で unique の無い列に文言だけ足す形は断られる", () => {
    const before = manifestJson();
    const result = changeField("d-memo", "memo", { unique_message: MESSAGE });
    expect(result.valid).toBe(false);
    expect(
      errorsOf(result).some((error) => error.path.endsWith("unique_message")),
      JSON.stringify(errorsOf(result)),
    ).toBe(true);
    expect(manifestJson()).toBe(before);
  });

  test("(D-9) change_field で 0文字・201文字を書くと断られる", () => {
    declareMessage();
    const before = manifestJson();
    for (const bad of ["", "あ".repeat(201), WIDE.repeat(201)]) {
      const result = changeField(`d-len-${bad.length}`, "member", { unique_message: bad });
      expect(result.valid, String(bad.length)).toBe(false);
      expect(manifestJson()).toBe(before);
    }
  });

  test("(D-10) 型を変える change_field でも文言は引き継がれる(unique と同じく全型に書けるため)", () => {
    declareMessage();
    const result = changeField("d-retype", "member", { type: "long_text" });
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(fieldOf("member")?.unique_message).toBe(MESSAGE);
  });

  test("(U-1) undo で宣言の前に戻る", () => {
    const before = manifestJson();
    declareMessage();
    expect(manifestJson()).not.toBe(before);
    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid, JSON.stringify(undone)).toBe(true);
    expect(manifestJson()).toBe(before);
  });

  /*
   * **【`V23-M2-T02b` / `D-V23-62` / 授権 `ADR-0518` 行73(追加だけ)】要件ドキュメントに文言が1文として出る。**
   * 宣言した項目1つにつき1文。 文言は逐語引用のブロック(`> `)で写す(`data.field_unit` と同じ形)。
   * 陰性対照: 宣言する前の要件ドキュメントには、この文の型が1文も無い(既定値を推測しない)。
   */
  test("(Q-1) 要件ドキュメントに、重複のときに出す文言が1文として出る(宣言する前は0文)", () => {
    const templateOf = () =>
      generateRequirementsDoc(dataRoot, APP_ID).statements.filter(
        (statement) => statement.template === "data.field_unique_message",
      );
    expect(templateOf()).toEqual([]);
    declareMessage();
    const statements = templateOf();
    expect(statements.map((statement) => statement.text)).toEqual([
      `テーブル \`members\` のフィールド \`member\` は、同じ値の行がすでにあるとき、次の文言を出して断ると宣言している:\n> ${MESSAGE}`,
    ]);
    expect(generateRequirementsDoc(dataRoot, APP_ID).markdown).toContain(MESSAGE);
  });
});
