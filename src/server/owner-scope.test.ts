/**
 * 個人スコープ(owner)のサーバ層テスト(V1-M3-T04 / ADR-0016)。
 *
 * 前半は純粋関数(`owner-scope.ts`)の単体テスト、後半は `createServerApp` を使った
 * HTTP 統合テスト。純粋関数は SQL も HTTP も知らないので、真理値表を素早く固定できる。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AuthStore } from "../auth/store.ts";
import type { Role } from "../auth/types.ts";
import type { Field, Table } from "../kernel/index.ts";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
// **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】**
// **予約規約フィールド `st_admin_readable`(運営可視)を廃止したので、`owner-scope.ts` から
// 消えた5つの export をこの import から落とした** —— 逐語で
// `ADMIN_READABLE_FIELD` / `adminReadableField` / `adminReadsAllRows` /
// `READ_HIDDEN_RESERVED_FIELDS` / `projectForRead`。
// **代わりに `roleReadCrossesOwnerScope`(役割 × 対象(表)× 読取)を取る。**
import {
  ANON_RESERVED_FIELDS,
  INBOUND_STRIPPED_RESERVED_FIELDS,
  isAllowedOwnerUpdate,
  isDeleteProtectedRow,
  // **【`V8-M37` / 台帳 `F-G3`】他人を持ち主にした**作成**を断る述語。**
  isOwnerSpoofedOnCreate,
  isOwnerVisible,
  isPublicRow,
  isSharedOwner,
  judgeOwnerScopedOp,
  // **【`V8-M37` / 台帳 `F-G5`】表示名のままの書き戻しを、付け替えと見なさない判定。**
  judgeOwnerUpdateWithDisplay,
  // **【`V8-M27-T04`】撤去した `nonAdminTableAccess` の置き直しの検査が使う。**
  judgeRoleAccess,
  // **【`V10-M27-T01a`(2026-08-25。`ADR-0375`)】**
  // **規則の総数を数えるために、既存の2つの述語を `export` した**(実装は1バイトも
  // 変えていない)。**`declaredRoleIds` / `declaredRoleKinds` は `rules` を1度も見ないので、
  // 「規則を1本も書いていない」を数えられない。**
  manifestRoleDeclarations,
  NO_DIRECT_CREATE_FIELD,
  // **【`V8-M27-T04` / `T-G5`】`nonAdminTableAccess` の import は撤去した**(関数ごと消えた)。
  OWNER_FIELD,
  ownerDisplayName,
  PUBLIC_FIELD,
  personalOwnerField,
  projectForAnonymous,
  projectOwnerDisplay,
  publicField,
  roleReadCrossesOwnerScope,
  roleRulesOf,
  stripInboundPublicFlag,
  stripInboundReservedFields,
  UNDELETABLE_FIELD,
  UNRESOLVED_OWNER_DISPLAY,
  undeletableField,
} from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

// --- P1: 純粋関数 ----------------------------------------------------------------

function tableWith(field: Field): Table {
  return { id: "notes", name: "メモ", fields: [{ id: "title", name: "題", type: "text" }, field] };
}

test("OWNER_FIELD は st_owner", () => {
  expect(OWNER_FIELD).toBe("st_owner");
});

// --- `V10-M27-T01a`: 規則の総数を数えるための2つの述語(公開したこと自体を固定する)-------
//
// **公開したのは `manifestRoleDeclarations` と `roleRulesOf` の2つちょうどである。**
// **実装は1バイトも書き換えていない**(`export ` の2語を足しただけ)。
// **【なぜ公開が要るか】** 既に公開されている `declaredRoleIds` / `declaredRoleKinds` は
// **`rules` を1度も読まない**ので、「規則を1本も書いていない」を数えられない。
// **`comment-visibility.ts` の中に `manifest.app.roles` を読み直す実装を書くと、
// 同ファイルが禁じている「判定の家の2軒目」になる。**

test("V10-M27-T01a: manifestRoleDeclarations は app.roles の要素だけを返し、形が壊れていれば空", () => {
  expect(manifestRoleDeclarations(undefined)).toEqual([]);
  expect(manifestRoleDeclarations(null)).toEqual([]);
  expect(manifestRoleDeclarations({})).toEqual([]);
  expect(manifestRoleDeclarations({ app: {} })).toEqual([]);
  expect(manifestRoleDeclarations({ app: { roles: "owner" } })).toEqual([]);
  // 配列の中の非オブジェクトは落ちる(述語は例外を投げない)。
  expect(manifestRoleDeclarations({ app: { roles: [null, 1, "x", { id: "owner" }] } })).toEqual([
    { id: "owner" },
  ]);
});

test("V10-M27-T01a: roleRulesOf は target が文字列で can が配列の要素だけを返す", () => {
  expect(roleRulesOf({})).toEqual([]);
  expect(roleRulesOf({ rules: "read" })).toEqual([]);
  expect(roleRulesOf({ rules: [] })).toEqual([]);
  expect(roleRulesOf({ rules: [{ target: "app" }, { can: ["read"] }, null] })).toEqual([]);
  expect(roleRulesOf({ rules: [{ target: "app", can: ["write"] }] })).toEqual([
    { target: "app", can: ["write"] },
  ]);
});

test("V10-M27-T01a: 2つを重ねると、そのマニフェストの規則の総数が数えられる", () => {
  const total = (manifest: unknown): number =>
    manifestRoleDeclarations(manifest).reduce(
      (sum, declaration) => sum + roleRulesOf(declaration).length,
      0,
    );
  // 規則ゼロ(`roles` そのものが無い / 役割は在るが `rules` が空)。
  expect(total({ app: { id: "shop" } })).toBe(0);
  expect(total({ app: { roles: [{ id: "owner", rules: [] }, { id: "viewer" }] } })).toBe(0);
  // **陽性対照** —— 規則が在れば 0 にならない。
  expect(
    total({
      app: {
        roles: [
          { id: "owner", rules: [{ target: "app", can: ["write"] }] },
          { id: "viewer", rules: [{ target: "view", view: "cart", can: ["read"] }] },
        ],
      },
    }),
  ).toBe(2);
});

test("personalOwnerField: text 非required の st_owner を個人所有と判定する", () => {
  const field: Field = { id: OWNER_FIELD, name: "所有者", type: "text" };
  const detected = personalOwnerField(tableWith(field));
  expect(detected).toBe(field);
});

test("personalOwnerField: text 非required(required:false 明示)も検出する", () => {
  const field: Field = { id: OWNER_FIELD, name: "所有者", type: "text", required: false };
  expect(personalOwnerField(tableWith(field))).toBe(field);
});

test("personalOwnerField: reference 型の st_owner は個人所有ではない(undefined)", () => {
  const field: Field = {
    id: OWNER_FIELD,
    name: "所有者",
    type: "reference",
    reference_table: "notes",
  };
  expect(personalOwnerField(tableWith(field))).toBeUndefined();
});

test("personalOwnerField: number 型の st_owner は個人所有ではない(undefined)", () => {
  const field: Field = { id: OWNER_FIELD, name: "所有者", type: "number" };
  expect(personalOwnerField(tableWith(field))).toBeUndefined();
});

test("personalOwnerField: required:true の text st_owner は個人所有ではない(undefined)", () => {
  const field: Field = { id: OWNER_FIELD, name: "所有者", type: "text", required: true };
  expect(personalOwnerField(tableWith(field))).toBeUndefined();
});

test("personalOwnerField: st_owner を持たないテーブル(非該当/システム相当)は undefined", () => {
  const table: Table = {
    id: "shared",
    name: "共有",
    fields: [{ id: "title", name: "題", type: "text" }],
  };
  expect(personalOwnerField(table)).toBeUndefined();
});

test("isSharedOwner: null/undefined/空文字 は共有、それ以外は非共有", () => {
  expect(isSharedOwner(null)).toBe(true);
  expect(isSharedOwner(undefined)).toBe(true);
  expect(isSharedOwner("")).toBe(true);
  expect(isSharedOwner("u-1")).toBe(false);
  expect(isSharedOwner(0)).toBe(false);
  expect(isSharedOwner(false)).toBe(false);
});

test("isOwnerVisible: 自分の行 or 共有行だけ見える", () => {
  expect(isOwnerVisible("u-1", "u-1")).toBe(true); // 自分
  expect(isOwnerVisible("u-2", "u-1")).toBe(false); // 他人
  expect(isOwnerVisible(null, "u-1")).toBe(true); // 共有(null)
  expect(isOwnerVisible("", "u-1")).toBe(true); // 共有(空文字)
  expect(isOwnerVisible(undefined, "u-1")).toBe(true); // 共有(undefined)
});

test("isAllowedOwnerUpdate: 現在値が自分のとき", () => {
  const me = "u-1";
  expect(isAllowedOwnerUpdate(me, me)).toBe(true); // 自分→自分(据え置き)
  expect(isAllowedOwnerUpdate(null, me)).toBe(true); // 自分→共有(手放す)
  expect(isAllowedOwnerUpdate("", me)).toBe(true); // 自分→共有(空文字)
  expect(isAllowedOwnerUpdate("u-2", me)).toBe(false); // 自分→他人(付け替え不可)
});

test("isAllowedOwnerUpdate: 現在値が共有(null)のとき", () => {
  expect(isAllowedOwnerUpdate(null, null)).toBe(true); // 共有→共有(据え置き)
  expect(isAllowedOwnerUpdate("u-1", null)).toBe(false); // 共有→自分(私物化 claim 不可)
  expect(isAllowedOwnerUpdate("u-2", null)).toBe(false); // 共有→他人 不可
});

// --- P1-b: op 1件への所有者スコープ判定(V3-M13-T10 / ADR-0067 限定 A5)---------------
//
// **HTTP バッチ経路(`app.ts`)と島の op 経路(`workflow-runner.ts`)が同じ1本を呼ぶ。**
// 判定(create のスタンプ / 可視性を先に見る / 付け替えと私物化の禁止)は**ここにしか無い**。

/** 個人所有テーブル(`st_owner` = text 非required)。 */
const SCOPED_TABLE: Table = {
  id: "note",
  name: "メモ",
  fields: [
    { id: OWNER_FIELD, name: "所有者", type: "text" },
    { id: "body", name: "本文", type: "text" },
  ],
};

/** 個人所有でないテーブル(運営テーブル)。 */
const PLAIN_TABLE: Table = {
  id: "product",
  name: "商品",
  fields: [{ id: "name", name: "名前", type: "text" }],
};

/** 行を1件だけ返す `readRow`。 */
function rowsOf(rows: Record<string, Record<string, unknown>>) {
  return (_tableId: string, recordId: string) => rows[recordId];
}

test("judgeOwnerScopedOp: 個人所有でないテーブルの op は判定対象外(skip)", () => {
  const verdict = judgeOwnerScopedOp({
    table: PLAIN_TABLE,
    op: { op: "create", table: "product", values: { name: "T" } },
    actorId: "u-1",
    readRow: rowsOf({}),
  });
  expect(verdict.kind).toBe("skip");
});

test("judgeOwnerScopedOp: create op は st_owner を actor で必ず上書きする(詐称を遮断)", () => {
  const values: Record<string, unknown> = { body: "x", [OWNER_FIELD]: "u-2" };
  const verdict = judgeOwnerScopedOp({
    table: SCOPED_TABLE,
    op: { op: "create", table: "note", values },
    actorId: "u-1",
    readRow: rowsOf({}),
  });
  expect(verdict.kind).toBe("stamped");
  expect(values[OWNER_FIELD]).toBe("u-1");
});

test("judgeOwnerScopedOp: actor を特定できない実行の create op は拒否する(no_actor)", () => {
  const values: Record<string, unknown> = { body: "x" };
  const verdict = judgeOwnerScopedOp({
    table: SCOPED_TABLE,
    op: { op: "create", table: "note", values },
    actorId: null,
    readRow: rowsOf({}),
  });
  expect(verdict.kind).toBe("no_actor");
  // **1バイトも書き換えない**(共有センチネルを勝手に立てない)。
  expect(OWNER_FIELD in values).toBe(false);
});

test("judgeOwnerScopedOp: 他人の行を狙う update op は不可視(invisible)—— 存在を伏せる", () => {
  const verdict = judgeOwnerScopedOp({
    table: SCOPED_TABLE,
    op: { op: "update", table: "note", target: "r-1", values: { body: "x" } },
    actorId: "u-1",
    readRow: rowsOf({ "r-1": { [OWNER_FIELD]: "u-2", body: "他人" } }),
  });
  expect(verdict).toEqual({ kind: "invisible", tableId: "note", target: "r-1" });
});

test("judgeOwnerScopedOp: 自分の行 / 共有行の update op は許される", () => {
  expect(
    judgeOwnerScopedOp({
      table: SCOPED_TABLE,
      op: { op: "update", table: "note", target: "r-1", values: { body: "x" } },
      actorId: "u-1",
      readRow: rowsOf({ "r-1": { [OWNER_FIELD]: "u-1" } }),
    }).kind,
  ).toBe("allowed");
  expect(
    judgeOwnerScopedOp({
      table: SCOPED_TABLE,
      op: { op: "update", table: "note", target: "r-1", values: { body: "x" } },
      actorId: "u-1",
      readRow: rowsOf({ "r-1": { [OWNER_FIELD]: null } }),
    }).kind,
  ).toBe("allowed");
});

test("judgeOwnerScopedOp: actor が居ない実行でも共有行は書けるが、誰かの行は不可視である", () => {
  expect(
    judgeOwnerScopedOp({
      table: SCOPED_TABLE,
      op: { op: "update", table: "note", target: "r-1", values: { body: "x" } },
      actorId: null,
      readRow: rowsOf({ "r-1": { [OWNER_FIELD]: null } }),
    }).kind,
  ).toBe("allowed");
  expect(
    judgeOwnerScopedOp({
      table: SCOPED_TABLE,
      op: { op: "update", table: "note", target: "r-1", values: { body: "x" } },
      actorId: null,
      readRow: rowsOf({ "r-1": { [OWNER_FIELD]: "u-1" } }),
    }).kind,
  ).toBe("invisible");
});

test("judgeOwnerScopedOp: 付け替え / 私物化(claim)は forbidden", () => {
  expect(
    judgeOwnerScopedOp({
      table: SCOPED_TABLE,
      op: { op: "update", table: "note", target: "r-1", values: { [OWNER_FIELD]: "u-2" } },
      actorId: "u-1",
      readRow: rowsOf({ "r-1": { [OWNER_FIELD]: "u-1" } }),
    }).kind,
  ).toBe("forbidden");
  expect(
    judgeOwnerScopedOp({
      table: SCOPED_TABLE,
      op: { op: "update", table: "note", target: "r-1", values: { [OWNER_FIELD]: "u-1" } },
      actorId: "u-1",
      readRow: rowsOf({ "r-1": { [OWNER_FIELD]: null } }),
    }).kind,
  ).toBe("forbidden");
});

test("judgeOwnerScopedOp: 可視性の判定が付け替えの判定より先である(不可視の行は 403 で漏れない)", () => {
  // 他人の行に対して、同時に付け替えも狙う op。**先に invisible になる**(存在を伏せる)。
  const verdict = judgeOwnerScopedOp({
    table: SCOPED_TABLE,
    op: { op: "update", table: "note", target: "r-1", values: { [OWNER_FIELD]: "u-1" } },
    actorId: "u-1",
    readRow: rowsOf({ "r-1": { [OWNER_FIELD]: "u-2" } }),
  });
  expect(verdict.kind).toBe("invisible");
});

test("judgeOwnerScopedOp: 形が不正な op / 実在しない行 / 未解決テーブルは skip(検証はカーネルの1関門)", () => {
  expect(
    judgeOwnerScopedOp({ table: SCOPED_TABLE, op: null, actorId: "u-1", readRow: rowsOf({}) }),
  ).toEqual({ kind: "skip" });
  expect(
    judgeOwnerScopedOp({
      table: undefined,
      op: { op: "create", table: "ghost", values: {} },
      actorId: "u-1",
      readRow: rowsOf({}),
    }).kind,
  ).toBe("skip");
  expect(
    judgeOwnerScopedOp({
      table: SCOPED_TABLE,
      op: { op: "update", table: "note", target: "missing", values: {} },
      actorId: "u-1",
      readRow: rowsOf({}),
    }).kind,
  ).toBe("skip");
});

// --- P2: 公開規約フィールド(st_public)の純粋関数(V2-M1-T04 / ADR-0034 案(b))-------

test("PUBLIC_FIELD は st_public", () => {
  expect(PUBLIC_FIELD).toBe("st_public");
});

test("publicField: boolean 非required の st_public を公開規約と判定する", () => {
  const field: Field = { id: PUBLIC_FIELD, name: "公開", type: "boolean" };
  expect(publicField(tableWith(field))).toBe(field);
});

test("publicField: boolean 非required(required:false 明示)も検出する", () => {
  const field: Field = { id: PUBLIC_FIELD, name: "公開", type: "boolean", required: false };
  expect(publicField(tableWith(field))).toBe(field);
});

test("publicField: text 型の st_public は公開規約ではない(undefined)", () => {
  const field: Field = { id: PUBLIC_FIELD, name: "公開", type: "text" };
  expect(publicField(tableWith(field))).toBeUndefined();
});

test("publicField: required:true の boolean st_public は公開規約ではない(undefined)", () => {
  const field: Field = { id: PUBLIC_FIELD, name: "公開", type: "boolean", required: true };
  expect(publicField(tableWith(field))).toBeUndefined();
});

test("publicField: st_public を持たないテーブルは undefined", () => {
  const table: Table = {
    id: "shared",
    name: "共有",
    fields: [{ id: "title", name: "題", type: "text" }],
  };
  expect(publicField(table)).toBeUndefined();
});

test("isPublicRow: st_public===true の行だけ公開。false/欠落/truthy 文字列は非公開", () => {
  expect(isPublicRow({ [PUBLIC_FIELD]: true })).toBe(true);
  expect(isPublicRow({ [PUBLIC_FIELD]: false })).toBe(false);
  expect(isPublicRow({})).toBe(false); // 欠落は非公開(既定で公開しない)
  expect(isPublicRow({ [PUBLIC_FIELD]: "true" })).toBe(false); // 厳密比較(truthy 文字列は不可)
  expect(isPublicRow({ [PUBLIC_FIELD]: 1 })).toBe(false);
});

// --- P2-b: 受信 payload から st_public を落とす純粋操作(V4-M27 / D-V4-92 / D-V4-114)-----

test("stripInboundPublicFlag: st_public を破壊的に取り除き、取り除いたら true を返す", () => {
  const values: Record<string, unknown> = { event_id: "evt_1", [PUBLIC_FIELD]: true };
  expect(stripInboundPublicFlag(values)).toBe(true);
  expect(values).not.toHaveProperty(PUBLIC_FIELD);
  expect(values.event_id).toBe("evt_1"); // 他のキーは1つも触らない
});

test("stripInboundPublicFlag: 値が何であっても取り除く(true 以外も落とす)", () => {
  // **`isPublicRow` の厳密さ(true だけが公開)とは別の話である** —— 落とす側は
  // 「立っているか」を見ない。**`D-V4-114` = 無条件に取り除く。**
  for (const value of [false, "true", 1, null]) {
    const values: Record<string, unknown> = { [PUBLIC_FIELD]: value };
    expect(stripInboundPublicFlag(values)).toBe(true);
    expect(values).not.toHaveProperty(PUBLIC_FIELD);
  }
});

test("stripInboundPublicFlag: キーが無ければ false を返し、1バイトも触らない", () => {
  const values: Record<string, unknown> = { event_id: "evt_2" };
  expect(stripInboundPublicFlag(values)).toBe(false);
  expect(values).toEqual({ event_id: "evt_2" });
});

test("stripInboundPublicFlag: 他の3本の予約規約フィールドは1本も落とさない(塞いでいない)", () => {
  // **塞いでいないことを固定する。** `st_owner` は別の向き(`judgeOwnerScopedOp` が
  // 上書きする)で扱われ、残り3本はこの経路で1ミリも触られない。
  //
  // **【`V8-M20` / `J-G30` / `ADR-0301`】予約規約フィールドは 5本 → 4本。**
  // **旧のテスト名は「他の4本の予約規約フィールドは…」で、`values` と期待値の両方に
  // `[ADMIN_READABLE_FIELD]: true,` が1行ずつ入っていた。**
  // **`ADMIN_READABLE_FIELD` は `owner-scope.ts` から消えたので落とした** ——
  // **見ているもの(この関数が落とすのは `st_public` 1本だけである)は1ミリも変わらない。**
  const values: Record<string, unknown> = {
    [OWNER_FIELD]: "u-1",
    [UNDELETABLE_FIELD]: true,
    [NO_DIRECT_CREATE_FIELD]: true,
    [PUBLIC_FIELD]: true,
  };
  expect(stripInboundPublicFlag(values)).toBe(true);
  expect(values).toEqual({
    [OWNER_FIELD]: "u-1",
    [UNDELETABLE_FIELD]: true,
    [NO_DIRECT_CREATE_FIELD]: true,
  });
});

// --- P2-c: 受信 payload から残る3本も落とす純粋操作(V4-M36 / D-V4-125)-------------------

test("stripInboundReservedFields: 3本を破壊的に取り除き、取り除いた名前を返す(D-V4-125)", () => {
  // **【`V8-M20` / `J-G30` / `ADR-0301`】`INBOUND_STRIPPED_RESERVED_FIELDS` は 4本 → 3本。**
  // **旧: テスト名は「4本を破壊的に取り除き…」で、送る値にも期待値にも
  // `ADMIN_READABLE_FIELD` が1行ずつ在った**(逐語 `expect(...).toEqual([PUBLIC_FIELD,
  // ADMIN_READABLE_FIELD, UNDELETABLE_FIELD, NO_DIRECT_CREATE_FIELD])`)。
  const values: Record<string, unknown> = {
    event_id: "evt_1",
    [PUBLIC_FIELD]: true,
    [UNDELETABLE_FIELD]: true,
    [NO_DIRECT_CREATE_FIELD]: true,
  };
  expect(stripInboundReservedFields(values)).toEqual([
    PUBLIC_FIELD,
    UNDELETABLE_FIELD,
    NO_DIRECT_CREATE_FIELD,
  ]);
  expect(values).toEqual({ event_id: "evt_1" }); // 業務フィールドは1つも触らない
});

test("stripInboundReservedFields: 値が何であっても取り除く(無条件。拒否しない)", () => {
  // **`isDeleteProtectedRow` の厳密さ(true だけが守られる)とは別の話である** ——
  // 落とす側は「立っているか」を見ない(`stripInboundPublicFlag` と同じ向き)。
  for (const value of [false, "true", 1, null]) {
    const values: Record<string, unknown> = { [UNDELETABLE_FIELD]: value };
    expect(stripInboundReservedFields(values)).toEqual([UNDELETABLE_FIELD]);
    expect(values).not.toHaveProperty(UNDELETABLE_FIELD);
  }
});

test("stripInboundReservedFields: st_owner は1バイトも触らない(向きが違う)", () => {
  // **`st_owner` は捨てない** —— `judgeOwnerScopedOp` が system actor で**上書き**する
  // (対応する正しい値が在る)。**捨てると持ち主が空になり、共有センチネル扱いになる。**
  const values: Record<string, unknown> = { [OWNER_FIELD]: "u-1", body: "本文" };
  expect(stripInboundReservedFields(values)).toEqual([]);
  expect(values).toEqual({ [OWNER_FIELD]: "u-1", body: "本文" });
});

test("stripInboundReservedFields: 落とす対象は予約規約4本から st_owner を除いた3本ちょうど", () => {
  // **`ANON_RESERVED_FIELDS`(4本)との差は `st_owner` 1本だけである。** 予約規約
  // フィールドが5本目に増えたとき、この検査が「受信口で落とすかを決めていない」ことを暴く。
  //
  // **【`V8-M20` / `J-G30` / `ADR-0301`】テスト名と上の2行の本数だけを直した** ——
  // **旧: 「予約規約5本から st_owner を除いた4本ちょうど」/「`ANON_RESERVED_FIELDS`(5本)」/
  // 「6本目に増えたとき」。** **`expect()` の本体は1バイトも変えていない**(両集合の関係を
  // 見る形なので、本数が変わっても式は同じである)。
  expect([...INBOUND_STRIPPED_RESERVED_FIELDS].sort()).toEqual(
    ANON_RESERVED_FIELDS.filter((f) => f !== OWNER_FIELD).sort(),
  );
  expect(INBOUND_STRIPPED_RESERVED_FIELDS).not.toContain(OWNER_FIELD);
});

test("projectForAnonymous: 予約規約フィールド(st_owner / st_public)を伏せ、業務フィールドは残す", () => {
  const projected = projectForAnonymous({
    _id: "r1",
    _updated_at: "2026-01-01T00:00:00Z",
    name: "商品A",
    price: 100,
    [OWNER_FIELD]: "u-1",
    [PUBLIC_FIELD]: true,
    secret_memo: "運営メモ", // 注: 業務フィールドは伏せられない(下記の正直な限界)
  });
  // 伏せる: 所有・公開の予約規約フィールド
  expect(projected).not.toHaveProperty(OWNER_FIELD);
  expect(projected).not.toHaveProperty(PUBLIC_FIELD);
  // 残す: 識別・業務フィールド
  expect(projected._id).toBe("r1");
  expect(projected.name).toBe("商品A");
  expect(projected.price).toBe(100);
  // 正直な限界(ADR-0034 §92-2): 案(b)はフィールド単位の「運営専用」印を持たないので、
  // 公開テーブルに載せた業務フィールドは匿名にも出る。伏せられるのは予約規約フィールドだけ。
  expect(projected.secret_memo).toBe("運営メモ");
});

// --- P3: HTTP 統合(createServerApp) ----------------------------------------------

const APP_ID = "notesapp";

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "メモ帳",
      tables: [
        {
          id: "notes", // 個人所有(st_owner text 非required)
          name: "メモ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "announcements", // 共有(st_owner なし)
          name: "お知らせ",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
        },
        {
          id: "refnotes", // 衝突: st_owner が reference 型 → 個人スコープにならない
          name: "参照メモ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "reference", reference_table: "notes" },
          ],
        },
        {
          id: "reqnotes", // 衝突: st_owner が required=true text → 個人スコープにならない
          name: "必須所有メモ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text", required: true },
          ],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
    },
  };
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-owner-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "メモ帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65` / `D-V8-61` / `D-V8-62`】**
  // **旧: `expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);`**
  //
  // **この題材は `app.roles` を1つも持っていない** —— **`D-V8-65` により、役割を1つも
  // 宣言していないアプリは表・画面・ボタンが閉じる。** **足さないと `notes` に1行も作れず、
  // 個人スコープ(`st_owner`)の検査そのものが立たない。**
  // **足すのは `apply-diff.ts` の自動付与とまったく同じ規則である** ——
  // **実アプリが `add_table` を通せば必ず入るものであり、検査のために作った特別な形ではない。**
  //
  // **【この1行が、この下の4本の期待値を反転させた張本人である。隠さない】**
  // **既定3役割はどれも表の `read` を持つ。** **`V8-M20` / `D-V8-35` により
  // 「表の読取を書いた役割は `st_owner` を読取について越える」ので、
  // **既定のままのアプリでは `st_owner` による相互不可視が成り立たなくなった。**
  // **どちらか一方しか選べない** —— **規則を足さなければ誰も行を作れず、足せば互いに見える。**
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

async function versionOf(cookie: string, path: string): Promise<string> {
  const res = await req(cookie, "GET", path);
  const etag = res.headers.get("etag");
  if (etag !== null) {
    return etag;
  }
  return ((await res.json()) as { record: { _updated_at: string } }).record._updated_at;
}

/** テーブルにレコードを1件作り、その _id を返す(POST=スタンプ経由)。 */
async function create(
  cookie: string,
  table: string,
  body: Record<string, unknown>,
): Promise<{ status: number; id?: string; owner?: unknown }> {
  const res = await req(cookie, "POST", `/api/apps/${APP_ID}/tables/${table}/records`, body);
  if (res.status !== 201) {
    return { status: res.status };
  }
  const rec = ((await res.json()) as { record: Record<string, unknown> }).record;
  return { status: 201, id: rec._id as string, owner: rec[OWNER_FIELD] };
}

async function listIds(cookie: string, table: string): Promise<string[]> {
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/tables/${table}/records`);
  const body = (await res.json()) as { records: { _id: string }[] };
  return body.records.map((r) => r._id);
}

const R = (table: string, id?: string) =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

test("(a) A/B が個人テーブルに各自作成 → 一覧・1件とも相互不可視", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });

  const na = await create(a.cookie, "notes", { title: "Aのメモ" });
  const nb = await create(b.cookie, "notes", { title: "Bのメモ" });
  expect(na.status).toBe(201);
  expect(nb.status).toBe(201);
  expect(na.owner).toBe(a.userId);
  expect(nb.owner).toBe(b.userId);

  // 一覧: 各自 自分の行だけ
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-61` / `D-V8-62`(既定3役割への自動付与)×
  // `V8-M20` / `D-V8-35`(表の読取を書いた役割は `st_owner` を読取について越える)。
  // 旧の2行を逐語で残す】**
  // **旧: `expect(await listIds(a.cookie, "notes")).toEqual([na.id as string]);`**
  // **旧: `expect(await listIds(b.cookie, "notes")).toEqual([nb.id as string]);`**
  //
  // **既定3役割には表の `read` が自動で入る。** **「この表を読める」と書いた役割は
  // 誰であっても全員分が見える(`D-V8-35` の逐語)ので、既定のままのアプリでは
  // `st_owner` による相互不可視が成り立たない。** **A も B も2件とも見える。**
  //
  // **【誇張しない。`st_owner` の実装は1バイトも変わっていない】**
  // **スタンプ(上の `owner` の突き合わせ)も、書込・削除側の `AND` も今日どおりである** ——
  // **変わったのは「面が読取を許している人が誰か」だけである。**
  //
  // **【この検査が測れなくなったこと。隠さない】** **規則を1本も足さなければ表ごと閉じる
  // ので、「自分の行だけが見える」状態を HTTP から作る手だては今日1つも無い。**
  // **条件つきの規則(`when: { field: "st_owner", equals_current_user: true }`)を書けば
  // 同じ見え方は作れるが、それは `st_owner` ではなく条件の測定である。**
  const bothIds = [na.id as string, nb.id as string].sort();
  expect((await listIds(a.cookie, "notes")).sort()).toEqual(bothIds);
  expect((await listIds(b.cookie, "notes")).sort()).toEqual(bothIds);

  // 1件: 自分の行は見える
  expect((await req(a.cookie, "GET", R("notes", na.id))).status).toBe(200);
  expect((await req(b.cookie, "GET", R("notes", nb.id))).status).toBe(200);
});

test("(c) 他人の個人行を GET 1件 → 404", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const nb = await create(b.cookie, "notes", { title: "Bのメモ" });
  // **【`V8-M26`。旧の1行を逐語で残す】**
  // **旧: `expect((await req(a.cookie, "GET", R("notes", nb.id))).status).toBe(404);`**
  // **既定3役割の自動付与で A も表の読取を持つので、他人の個人行が単件でも 200 で返る**
  // (上の (a) と同じ理由)。**`ADR-0305` 限定11 の 404(存在秘匿)は、面が読取を
  // 許していない相手に対しては今日も生きている** —— **下の (V3-M8-T01 c) が実測している。**
  expect((await req(a.cookie, "GET", R("notes", nb.id))).status).toBe(200);
});

// --- 【`V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`。期待値を反転させた。旧を逐語で残す】 ---
//
// **旧のテスト名(逐語)**:
//   `test("(d) body に他人 id を st_owner で送って作成 → スタンプで actor.id に矯正", ...)`
// **旧の本体(逐語)**:
//   ```
//   const na = await create(a.cookie, "notes", { title: "偽装", [OWNER_FIELD]: b.userId });
//   expect(na.status).toBe(201);
//   expect(na.owner).toBe(a.userId); // B の id は無視され A に矯正
//   // B からは見えない(A の所有になっている)
//   // **【`V8-M26`。旧の1行を逐語で残す】**
//   // **旧: `expect((await req(b.cookie, "GET", R("notes", na.id))).status).toBe(404);`**
//   // **スタンプ(この検査の主題)は1バイトも変わっていない** —— **`st_owner` は今日も
//   // 要求者の id に矯正される**(上の `expect(na.owner).toBe(a.userId)` が主題である)。
//   // **変わったのは「B から見えるかどうか」だけであり、それは面の既定の話である。**
//   expect((await req(b.cookie, "GET", R("notes", na.id))).status).toBe(200);
//   ```
//
// **根拠**: **`V8-M37` / 軸5 / 台帳 `F-G3` / ユーザ決定 `D-V8-96`(= 「断る」)。**
// **黙って本人に化けさせる(矯正)のをやめ、403 で断るようにした。**
// **`ADR-0016` §却下(iv) の「クライアント送信を信用する経路は最初から作らない」は
// 1ミリも緩んでいない** —— **信用しない上で、黙って捨てるのではなく断るようになった。**
// **【この反転が射程に入れないもの】** **MCP(`src/mcp/tools/write.ts:840`)/ まとめ書込 /
// 受信口の**上書き**は今日どおりである**(`D-V8-90`)—— **そこは1バイトも触っていない。**
test("(d) body に他人 id を st_owner で送って作成 → 403 で断る(旧: スタンプで actor.id に矯正)", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const na = await create(a.cookie, "notes", { title: "偽装", [OWNER_FIELD]: b.userId });
  expect(na.status).toBe(403);
  expect(na.id).toBeUndefined();
});

test("(e) 共有化 PATCH {st_owner:null} → 両者可視", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const na = await create(a.cookie, "notes", { title: "共有予定" });
  const v = await versionOf(a.cookie, R("notes", na.id));
  const patch = await req(a.cookie, "PATCH", R("notes", na.id), { [OWNER_FIELD]: null }, v);
  expect(patch.status).toBe(200);

  // 両者の一覧・1件で見える
  expect(await listIds(a.cookie, "notes")).toContain(na.id as string);
  expect(await listIds(b.cookie, "notes")).toContain(na.id as string);
  expect((await req(b.cookie, "GET", R("notes", na.id))).status).toBe(200);
});

test("(f) 未認証 → 401", async () => {
  expect((await req(undefined, "GET", R("notes"))).status).toBe(401);
  expect((await req(undefined, "POST", R("notes"), { title: "x" })).status).toBe(401);
});

test("更新 spoof: 自分の行を他人 id に付け替える PATCH → 403", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const na = await create(a.cookie, "notes", { title: "自分の" });
  const v = await versionOf(a.cookie, R("notes", na.id));
  const patch = await req(a.cookie, "PATCH", R("notes", na.id), { [OWNER_FIELD]: b.userId }, v);
  expect(patch.status).toBe(403);
});

test("claim: 共有行を PATCH で自分 id に私物化 → 403", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  // A が共有行を作る
  const na = await create(a.cookie, "notes", { title: "共有" });
  const v0 = await versionOf(a.cookie, R("notes", na.id));
  expect(
    (await req(a.cookie, "PATCH", R("notes", na.id), { [OWNER_FIELD]: null }, v0)).status,
  ).toBe(200);
  // B が私物化を試みる
  const v1 = await versionOf(b.cookie, R("notes", na.id));
  const claim = await req(b.cookie, "PATCH", R("notes", na.id), { [OWNER_FIELD]: b.userId }, v1);
  expect(claim.status).toBe(403);
});

test("非個人テーブル(st_owner なし)は全ユーザ全可視・スタンプなし", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const x = await create(a.cookie, "announcements", { title: "全体連絡" });
  expect(x.status).toBe(201);
  // B にも見える
  expect(await listIds(b.cookie, "announcements")).toContain(x.id as string);
  expect((await req(b.cookie, "GET", R("announcements", x.id))).status).toBe(200);
});

test("衝突ガード: st_owner が reference 型のテーブルは個人スコープにならず全可視・非スタンプ", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  // reference 非required なので st_owner を省いて作成できる
  const x = await create(a.cookie, "refnotes", { title: "参照メモ" });
  expect(x.status).toBe(201);
  expect(x.owner ?? null).toBeNull(); // スタンプされていない(actor.id が入らない)
  // B からも見える
  expect(await listIds(b.cookie, "refnotes")).toContain(x.id as string);
  expect((await req(b.cookie, "GET", R("refnotes", x.id))).status).toBe(200);
});

test("衝突ガード: st_owner が required=true text のテーブルは個人スコープにならず全可視・非スタンプ", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  // required なので値を渡す。スタンプされないのでクライアント値が残る。
  const x = await create(a.cookie, "reqnotes", { title: "必須", [OWNER_FIELD]: "任意ラベル" });
  expect(x.status).toBe(201);
  expect(x.owner).toBe("任意ラベル"); // actor.id で上書きされない
  // B からも見える
  expect(await listIds(b.cookie, "reqnotes")).toContain(x.id as string);
  expect((await req(b.cookie, "GET", R("reqnotes", x.id))).status).toBe(200);
});

test("他人の個人行 DELETE → 404", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const nb = await create(b.cookie, "notes", { title: "Bのメモ" });
  const v = await versionOf(b.cookie, R("notes", nb.id));
  // A が B の行を削除しようとしても、可視でないので 404(存在を漏らさない)
  const del = await req(a.cookie, "DELETE", R("notes", nb.id), undefined, v);
  expect(del.status).toBe(404);
  // B からはまだ見える(消えていない)
  expect((await req(b.cookie, "GET", R("notes", nb.id))).status).toBe(200);
});

test("ページネーション: total は要求者が見られる母集合(個人スコープ post-filter・EC-G11 / ADR-0042)", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  for (let i = 0; i < 3; i += 1) {
    expect((await create(a.cookie, "notes", { title: `A${i}` })).status).toBe(201);
  }
  for (let i = 0; i < 2; i += 1) {
    expect((await create(b.cookie, "notes", { title: `B${i}` })).status).toBe(201);
  }

  // A の母集合は自分の3件だけ(DB 全体は5件)。total は post-filter 後の3。
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-61` / `D-V8-62` × `D-V8-35`。旧の期待値を逐語で残す】**
  // **旧: `expect(full.records).toHaveLength(3);` / `expect(full.total).toBe(3);`**
  // **旧: `expect(page.records.map((r) => r.title)).toEqual(["A0", "A1"]);` /
  //        `expect(page.total).toBe(3);`**
  // **旧: `expect(rest.records.map((r) => r.title)).toEqual(["A2"]);` /
  //        `expect(rest.total).toBe(3);`**
  //
  // **既定3役割の自動付与で A も表の読取を持つので、A の母集合は DB 全体の5件になった。**
  // **この検査の主題(`total` が **要求者が見られる母集合** と一致し、ページングが
  // post-filter の**後**に掛かること)は1ミリも壊れていない** —— **母集合の中身が
  // 3件から5件へ変わっただけであり、`total` は今日も見える件数と一致している。**
  const full = (await (await req(a.cookie, "GET", `${R("notes")}?sort=title`)).json()) as {
    records: unknown[];
    total: number;
  };
  expect(full.records).toHaveLength(5);
  expect(full.total).toBe(5);

  // limit=2: post-filter の後にページングされ、先頭2件・total は3のまま。
  const page = (await (await req(a.cookie, "GET", `${R("notes")}?sort=title&limit=2`)).json()) as {
    records: { title: string }[];
    total: number;
  };
  expect(page.records.map((r) => r.title)).toEqual(["A0", "A1"]);
  expect(page.total).toBe(5);

  // offset=2: 残り1件。B の行は母集合に入らない。
  // **【`V8-M26` による訂正。上の1行は1バイトも消していない】** **B の行も母集合に入る。**
  const rest = (await (
    await req(a.cookie, "GET", `${R("notes")}?sort=title&limit=2&offset=2`)
  ).json()) as { records: { title: string }[]; total: number };
  expect(rest.records.map((r) => r.title)).toEqual(["A2", "B0"]);
  expect(rest.total).toBe(5);
});

// --- P4: 運営ロールの読取可視性(V3-M8-T01 / ADR-0061)—— 純粋関数 -----------------
//
// `st_admin_readable`(boolean・非required)を持つテーブル × `owner` ロール × 読取のときだけ
// `isOwnerVisible` の判定を越える(ADR-0061 限定1〜3)。**行の値は判定に使わない**(限定3)。
//
// --- 【`V8-M20` / 台帳 `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】節ごと置き直した ------
//
// **`st_admin_readable` を廃止した。****上の2行は着手前の姿であり、1バイトも書き換えていない。**
// **今日「`st_owner` の絞り込みを読取について越える」ことを決めるのは、面の規則
// (`app.roles[].rules` の「役割 × 対象(表)× 読取」)であり、実装は
// `roleReadCrossesOwnerScope` 1本である。**
//
// **消した検査(逐語。`owner-scope.ts` から export ごと消えたので、書き直しようが無い)**:
//   - `ADMIN_READABLE_FIELD は st_admin_readable`
//   - `adminReadableField: boolean 非required の st_admin_readable を運営可視宣言と判定する`
//   - `adminReadableField: boolean 非required(required:false 明示)も検出する`
//   - `adminReadableField: text 型の st_admin_readable は宣言ではない(undefined)`
//   - `adminReadableField: required:true の boolean st_admin_readable は宣言ではない(undefined)`
//   - `adminReadableField: st_admin_readable を持たないテーブルは undefined`
// **いずれも「その表が宣言つきか」を**フィールドの型と required から**判定するものだった** ——
// **面の規則は表のフィールドを1つも見ない**(見るのは `app.roles[].rules`)ので、
// **同じことを問える形が無い。**
//
// **置き直した検査**: `adminReadsAllRows` の2本 → `roleReadCrossesOwnerScope` の3本(下)。
//
// **【置き直しで意味が変わった点。隠さない】** **`st_admin_readable` は**表単位の宣言**で、
// 越えられる相手は `owner` に固定されていた**(`adminReadsAllRows` は
// `declaredMatchesRoles(["owner"], role)` を持っていた)。**面の規則は誰にでも書ける** ——
// **`roleReadCrossesOwnerScope` は `owner` を1文字も特別扱いしない。**
// **`D-V8-35` が承知で受け入れた代償である**(下の3本目がそれを固定する)。

/** 面の規則だけを持つ最小のマニフェスト(`roleReadCrossesOwnerScope` は表定義を見ない)。 */
function rolesManifest(roles: unknown[]): unknown {
  return { app: { id: "adminvis", name: "面の規則", tables: [], views: [], roles } };
}

/** `orders` の読取(と書込・削除)を `owner` にだけ書いた面。 */
const ORDERS_READ_BY_OWNER = rolesManifest([
  {
    id: "owner",
    name: "持ち主",
    rules: [{ target: "table", table: "orders", can: ["read", "write", "delete"] }],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
]);

test("roleReadCrossesOwnerScope: 表の読取を書いた役割のときだけ true(ロールの真理値表)", () => {
  // **旧: `adminReadsAllRows: 宣言済みテーブル × owner のときだけ true(ロールの真理値表・限定2)`。**
  // **旧の逐語は `expect(adminReadsAllRows(declared, "owner")).toBe(true);` ほか4行だった。**
  const crosses = (roles: Role | readonly Role[] | null): boolean =>
    roleReadCrossesOwnerScope({ manifest: ORDERS_READ_BY_OWNER, roles, table: "orders" });
  expect(crosses("owner")).toBe(true);
  expect(crosses("editor")).toBe(false);
  expect(crosses("viewer")).toBe(false);
  expect(crosses("customer")).toBe(false);
  // **未認証(`null`)は1つも役割を持たないので越えない。**
  // **旧は `adminReadsAllRows(declared, undefined)` を渡していた**(引数の形が違う)。
  expect(crosses(null)).toBe(false);
});

test("roleReadCrossesOwnerScope: 規則を1本も書いていない表は owner でも false(自動で開かない)", () => {
  // **旧: `adminReadsAllRows: 宣言していないテーブルは owner でも false(限定3: 自動で開かない)`。**
  // **旧はフィールドの型 / required が規約から外れた宣言も開かないことを見ていたが、
  // 面の規則は表のフィールドを1つも見ないので、その3行に対応するものは無い。**
  expect(
    roleReadCrossesOwnerScope({ manifest: ORDERS_READ_BY_OWNER, roles: "owner", table: "diaries" }),
  ).toBe(false);
  // **`app.roles` を1つも宣言していないアプリでも false**(管轄外 = 着手前と同一)。
  expect(
    roleReadCrossesOwnerScope({
      manifest: { app: { id: "a", name: "a", tables: [], views: [] } },
      roles: "owner",
      table: "orders",
    }),
  ).toBe(false);
});

test("roleReadCrossesOwnerScope: `owner` を1文字も特別扱いしない(D-V8-35 の代償)", () => {
  // **`D-V8-35` の説明文の逐語**: 「**「この表を読める」と書いた役割は誰であっても全員分が
  // 見えるので、書き方を間違えると、本来自分の分だけ見えるはずだった人に全員分が見えます。
  // 今日はその危険が「運営者だけ」に閉じていました。**」
  // **【禁止の履行】これを「安全である」と読み替えない。**
  const memberReads = rolesManifest([
    { id: "owner", name: "持ち主" },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
    {
      id: "member",
      name: "会員",
      rules: [{ target: "table", table: "orders", can: ["read", "write"] }],
    },
  ]);
  // **運営でない役割が越える。**
  expect(
    roleReadCrossesOwnerScope({ manifest: memberReads, roles: "member", table: "orders" }),
  ).toBe(true);
  // **そして `owner` は越えない**(規則を書いていないため)—— **旧 `adminReadsAllRows` では
  // 起こりえなかった向きである。**
  expect(
    roleReadCrossesOwnerScope({ manifest: memberReads, roles: "owner", table: "orders" }),
  ).toBe(false);
});

test("isOwnerVisible: 第3引数(運営可視)は撤去され、引数は2本になった", () => {
  // **旧: `isOwnerVisible: 第3引数(運営可視)が true なら他人の行も可視。既定は従来どおり`。**
  // **旧の逐語は `expect(isOwnerVisible("u-2", "u-1", true)).toBe(true);` ほか。**
  // **今日、他人の行を越えるかは呼び出し側が `roleReadCrossesOwnerScope` との `OR` で決める**
  // (`app.ts` の一覧・単件の2経路。**この関数は越え方を1つも知らない**)。
  expect(isOwnerVisible.length).toBe(2);
  expect(isOwnerVisible("u-2", "u-1")).toBe(false);
  // 自分の行・共有行は true のまま(退行させない)
  expect(isOwnerVisible("u-1", "u-1")).toBe(true);
  expect(isOwnerVisible(null, "u-1")).toBe(true);
  // **呼び出し側が組む式**(`app.ts` と同じ形)—— 面が読取を許していれば他人の行も通る。
  const crosses = roleReadCrossesOwnerScope({
    manifest: ORDERS_READ_BY_OWNER,
    roles: "owner",
    table: "orders",
  });
  expect(isOwnerVisible("u-2", "u-1") || crosses).toBe(true);
});

test("ANON_RESERVED_FIELDS から st_admin_readable が落ちた(5本 → 4本)", () => {
  // **旧: `ANON_RESERVED_FIELDS に st_admin_readable が入っている(限定10)`。**
  // **旧の逐語は `expect(ANON_RESERVED_FIELDS).toContain(ADMIN_READABLE_FIELD);`。**
  // **【`V8-M20` / `J-G30` / `ADR-0301`】期待値を反転した** —— **綴りは今日、予約規約
  // フィールドではない。**
  expect(ANON_RESERVED_FIELDS).not.toContain("st_admin_readable");
  // 残る4本を1本も落としていない
  expect(ANON_RESERVED_FIELDS).toContain(OWNER_FIELD);
  expect(ANON_RESERVED_FIELDS).toContain(PUBLIC_FIELD);
  expect(ANON_RESERVED_FIELDS).toContain(UNDELETABLE_FIELD);
  expect(ANON_RESERVED_FIELDS).toContain(NO_DIRECT_CREATE_FIELD);
});

test("projectForAnonymous:【V8-M20 の代償】撤去した綴りは匿名応答にそのまま出る", () => {
  // **旧: `projectForAnonymous: st_admin_readable を匿名応答から伏せる(限定10)`。**
  // **旧の逐語は `expect(projected).not.toHaveProperty(ADMIN_READABLE_FIELD);`。**
  //
  // **反転した理由**: **`ADR-0061` 限定10 は「予約規約フィールドを匿名に漏らさない」で
  // あり、`st_admin_readable` はその1本だった。** **`V8-M20` がその1本を廃止したので、
  // **同じ綴りを持つ既存アプリの列は、今日から普通の業務項目として匿名に出る。**
  // **`ADR-0034` §92-2 の逐語(「公開テーブルに載せた業務フィールドは匿名にも出る」)が
  // そのまま当たるようになった、ということである。**
  // **【禁止の履行】これは塞げていない。塞げていないと書く。**
  const projected = projectForAnonymous({
    _id: "r1",
    name: "商品A",
    [OWNER_FIELD]: "u-1",
    [PUBLIC_FIELD]: true,
    st_admin_readable: true,
  });
  expect(projected).toHaveProperty("st_admin_readable");
  // **残る2本は今日どおり伏せる**(撤去は他の3本を1ミリも動かしていない)。
  expect(projected).not.toHaveProperty(OWNER_FIELD);
  expect(projected).not.toHaveProperty(PUBLIC_FIELD);
  expect(projected._id).toBe("r1");
  expect(projected.name).toBe("商品A");
});

// --- P5: 運営ロールの読取可視性(V3-M8-T01 / ADR-0061)—— HTTP 統合 -----------------
//
// P3 と別のアプリ(`adminvis`)を各テストの中で作る。P3 の `manifest()` / `beforeEach` を
// 1バイトも変えないためである(差し戻し条件7: 既存テストを改変しない)。
//
// --- 【`V8-M20` / `J-G30` / `ADR-0301` / `D-V8-35`】フィクスチャの置き直し ---------------
//
// **`orders` を「宣言済み」にしていたのは `st_admin_readable` という**フィールド**だった。**
// **今日それを担うのは面の規則(`app.roles[].rules`)である** —— **表 `orders` の読取を
// `owner` にだけ書いた。** **表定義そのものは1バイトも動かしていない。**
//
// **【`can` に `write` / `delete` も書いてある理由】** **面は対象を名指しした時点で
// 全動詞が allow-list になる** —— **`read` だけ書くと、その表への書込・削除が**誰にも**
// できなくなり、このフィクスチャの `POST` が全部 403 になる。**
//
// **【`editor` / `customer` に条件(`when`)つきの規則を書いた理由。隠さない】**
// **`orders` が管轄内になった以上、規則を1本も持たない役割はその表を読めない**
// (一覧が空・単件404)。**着手前の `editor` / `customer` は「自分の行だけ読める」相手
// だったので、その姿を保つには `when: { field: st_owner, equals_current_user: true }` を
// 書くしかない。** **これは着手前に**書かなくてよかった**ものであり、置き直しで増えた
// 記述である**(`ADR-0301` 限定10 の作法に従って、増えたことを書く)。
// **`viewer` には1本も書いていない** —— **着手前も他人の行を読めなかったが、今日は
// 「自分の行も読めない」に変わっている**(下の (c) のコメントに実測を書いた)。

const ADMIN_APP_ID = "adminvis";

/**
 * `adminvis` の面(`app.roles[].rules`)。**既定3本(`owner` / `editor` / `viewer`)は
 * 消せない**(`referential-integrity.ts` の検査)ので、必ず含めて書く。
 */
const ADMIN_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    // **これが `st_admin_readable` の置き換えである**(台帳 `J-G30` の「代わりに立つのは
    // 役割 × 対象(表)× 読取」)。**`D-V8-35` により、読取についてだけ `st_owner` を越える。**
    rules: [{ target: "table", table: "orders", can: ["read", "write", "delete"] }],
  },
  {
    id: "editor",
    name: "編集者",
    rules: [
      {
        target: "table",
        table: "orders",
        can: ["read", "write", "delete"],
        when: { field: OWNER_FIELD, equals_current_user: true },
      },
    ],
  },
  { id: "viewer", name: "閲覧者" },
  {
    // **【`V8-M26`。台帳 `T-G26a` / ユーザ決定 `D-V8-45`】未ログインに1本だけ規則を書く。**
    //
    // **旧の `ADMIN_ROLES` に `anonymous` の宣言は1つも無かった**(逐語で言えば、
    // `{ id: "viewer", name: "閲覧者" },` の次が `customer` の宣言だった)。
    // **書かなくても匿名公開(`st_public === true`)の行は読めていた** —— **今日は読めない。**
    // **既定が「閉じる」側へ倒れ、その向きが未ログインにも及んだからである**(`T-G26a`)。
    // **【正直に書く。これは `V8-M26` が今日できていたことを1つ止めた実例である】**
    // **匿名公開は、`anonymous` にその表の読取を書かないかぎり今日は1件も返らない。**
    // **`st_public` の絞り込みそのものは1バイトも変わっていない** ——
    // **下の (V3-M8-T02 f) が、この規則を書いたうえで「公開の行だけ」を実測している。**
    id: "anonymous",
    name: "未ログイン",
    rules: [{ target: "table", table: "catalog", can: ["read"] }],
  },
  {
    // **宣言された利用者の種類**(`ADR-0158`)。**`editor` と同じ形で自分の行に絞る。**
    id: "customer",
    name: "購入者",
    rules: [
      {
        target: "table",
        table: "orders",
        can: ["read", "write", "delete"],
        when: { field: OWNER_FIELD, equals_current_user: true },
      },
      // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を足した。**
      //
      // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す一覧系の
      // 画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件になる
      // (単票の口は `detail_view` / `form` を見て 404 になる)。** **`D-V18-26` により、
      // 画面を宣言しているのに「誰に見せるか」を役割の規則に1行も書いていない場合も止まる。**
      //
      // **`adminvis` は `order-list`(`list_view`。表 `orders`)を宣言しながら、
      // `customer` にはその画面の規則を1本も書いていなかった。** **この3本
      // ((V3-M8-T02 a) / (V3-M8-T02 c) / (E-G54 b))が測っているのは `st_owner` の
      // post-filter と項目の射影であって画面の規則ではないので、主張(`expect`)は
      // 1バイトも書き換えていない。**
      // **`owner` / `editor` に足していないのは、実測でその2役割の検査が1本も
      // 赤くなっていないからである**(この2役割は `orders` の一覧を読む検査を持たない)。
      { target: "view", view: "order-list", can: ["read"] },
    ],
  },
];

function adminManifest(): Manifest {
  return {
    app: {
      id: ADMIN_APP_ID,
      name: "運営可視の検査",
      tables: [
        {
          // 宣言済み: 個人所有(st_owner)+ 運営可視(st_admin_readable)
          //
          // **【`V8-M20`】`st_admin_readable` は予約規約フィールドではなくなった** ——
          // **列は残してあるが、今日は**ただの boolean 項目**である**(何も決めない)。
          // **残した理由**: **撤去の代償(この列が読取応答に出るようになったこと)を
          // 下の (E-G54 b) が実測で固定するためである。** **「宣言済み」にしているのは
          // `ADMIN_ROLES` の `owner` の規則 1本だけである。**
          id: "orders",
          name: "注文",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            { id: "st_admin_readable", name: "運営可視", type: "boolean" },
          ],
        },
        {
          // 未宣言: 個人所有だけ(運営にも他人の行は見えない)
          // **`ADMIN_ROLES` に `diaries` の規則を1本も書いていない = 管轄外(全許可)。**
          id: "diaries",
          name: "日記",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          // 匿名公開 + 宣言(匿名応答に st_admin_readable が漏れないことの検査用)
          // **【`V8-M20`】漏れないことではなく、**漏れること**を測る表になった**
          // (下の (V3-M8-T01 g))。**列はただの boolean 項目である。**
          id: "catalog",
          name: "カタログ",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
            { id: "st_admin_readable", name: "運営可視", type: "boolean" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["title"] }],
      roles: ADMIN_ROLES,
    },
  } as unknown as Manifest;
}

type AdminCtx = { dataRoot: string; app: ReturnType<typeof createServerApp> };

/** `adminvis` アプリを一時 dataRoot に作り、fn に渡す(後始末つき)。 */
async function withAdminApp(fn: (ctx: AdminCtx) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gp-adminvis-"));
  try {
    const store = KernelMetaStore.open(root);
    try {
      createApp(store, "運営可視の検査", { app_id: ADMIN_APP_ID });
    } finally {
      store.close();
    }
    // **【`V8-M26`】`orders` には1本も足さない** —— **`ADMIN_ROLES` が手で書いた規則
    // (`owner` は無条件 / `editor` と `customer` は「持ち主が自分」の条件つき)が
    // この題材の主題そのものだからである。**
    // **`diaries`(未宣言の対照)と `catalog`(匿名公開)には、既定3役割の規則を足す** ——
    // **足さないと運営者すら1行も作れず、対照群そのものを作れない。**
    // **【この選択が (V3-M8-T01 b) と (V3-M8-T02 h) の期待値を反転させた。隠さない】**
    // **`diaries` は「面の規則を1本も書いていない表」の対照群だったが、既定が閉じた今日、
    // その状態は「誰も1行も作れない表」を意味する** —— **対照群として使えない。**
    // **実アプリでは `add_table` を通した時点で自動付与が入るので、「未宣言の表」は
    // 今日ほぼ存在しない。** **既定の規則が入った `diaries` は、`orders` と同じく
    // 運営者に他人の行が見える表になった**(`D-V8-35` の越え方)。
    // **`customer` と `anonymous` には自動では1本も入らない**(既定3役割ではない)。
    // **旧: `expect(applyManifest(root, ADMIN_APP_ID, adminManifest()).valid).toBe(true);`**
    expect(
      applyManifest(
        root,
        ADMIN_APP_ID,
        withDefaultRoleRules(adminManifest(), { skipTables: ["orders"] }),
      ).valid,
    ).toBe(true);
    await fn({ dataRoot: root, app: createServerApp({ dataRoot: root }) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function areq(
  ctx: AdminCtx,
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(ctx.app.request(new Request(`http://localhost${path}`, init)));
}

const AR = (table: string, id?: string) =>
  `/api/apps/${ADMIN_APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

async function acreate(
  ctx: AdminCtx,
  cookie: string,
  table: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await areq(ctx, cookie, "POST", AR(table), body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

async function alist(
  ctx: AdminCtx,
  cookie: string,
  table: string,
): Promise<{ ids: string[]; total: number }> {
  const res = await areq(ctx, cookie, "GET", AR(table));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { _id: string }[]; total: number };
  return { ids: body.records.map((r) => r._id), total: body.total };
}

test("(V3-M8-T01 a) 宣言済みテーブル: owner は他人の個人行を一覧でも単件でも読める", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    const listed = await alist(ctx, admin.cookie, "orders");
    expect(listed.ids.sort()).toEqual([own, theirs].sort());
    expect(listed.total).toBe(2);
    expect((await areq(ctx, admin.cookie, "GET", AR("orders", theirs))).status).toBe(200);
  });
});

test("(V3-M8-T01 b) 未宣言テーブル: owner でも他人の個人行は1件も読めない(自動で開かない)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const theirs = await acreate(ctx, buyer.cookie, "diaries", { title: "購入者の日記" });

    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65` / `D-V8-61` / `D-V8-62`。
    // 旧の3行を逐語で残す】**
    // **旧: `expect(listed.ids).toEqual([]);`**
    // **旧: `expect(listed.total).toBe(0);`**
    // **旧: `expect((await areq(ctx, admin.cookie, "GET", AR("diaries", theirs))).status).toBe(404);`**
    //
    // **この検査の主題は「規則を1本も書いていない表は**自動で開かない**」だった。**
    // **`V8-M26` はその前提を2段階でひっくり返した**:
    //
    //  1. **規則を1本も書いていない表は「開かない」ではなく「閉じる」になった**
    //     (`D-V8-45` / `D-V8-65`)—— **その表では誰も1行も作れない。**
    //  2. **その埋め合わせに、既定3役割へ表の規則が自動で入るようになった**
    //     (`D-V8-61` / `D-V8-62`)—— **`add_table` を通した実アプリに「未宣言の表」は
    //     もう残らない。** **そして表の読取を持つ役割は `st_owner` を越える(`D-V8-35`)。**
    //
    // **したがって「未宣言テーブル」という対照群を作る手だてが今日は無い。**
    // **この題材は 2. の側(既定の規則が入った表)に置き直してあり、運営者には
    // 他人の個人行が見える。** **1. の側(閉じたまま)は
    // `src/server/role-rules-enforcement.test.ts` の (A)(E) が測っている。**
    const listed = await alist(ctx, admin.cookie, "diaries");
    expect(listed.ids).toEqual([theirs]);
    expect(listed.total).toBe(1);
    expect((await areq(ctx, admin.cookie, "GET", AR("diaries", theirs))).status).toBe(200);
  });
});

test("(V3-M8-T01 c) 宣言済みテーブルでも editor / viewer には他人の行が見えない(限定2)", async () => {
  await withAdminApp(async (ctx) => {
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const other = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "other" });
    const viewer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "viewer", username: "peek" });
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    // editor: 他人の行は一覧に出ず、単件は 404
    expect((await alist(ctx, other.cookie, "orders")).ids).toEqual([]);
    expect((await areq(ctx, other.cookie, "GET", AR("orders", theirs))).status).toBe(404);
    // viewer: 同じ
    expect((await alist(ctx, viewer.cookie, "orders")).ids).toEqual([]);
    expect((await areq(ctx, viewer.cookie, "GET", AR("orders", theirs))).status).toBe(404);
  });
});

test("(V3-M8-T01 d) 条件(when)を書いていない表の規則は、行の値を1つも見ない", async () => {
  // **旧: `test("(V3-M8-T01 d) 行の値(st_admin_readable=false)は判定に使わない(限定3)")`。**
  // **旧の本体は `[ADMIN_READABLE_FIELD]: false` を書いた行を作り、それでも運営から見える
  // (= 書けるが効かない値)ことを固定していた。**
  //
  // **置き直し(`V8-M20` / `J-G30` / `D-V8-35`)**: **`ADR-0061` 限定3 の「宣言は表単位で、
  // 行の値は判定に使わない」に対応するのは、今日は「条件(`when`)を書かない規則は行を
  // 1つも見ない」である**(`owner` の規則には `when` を書いていない)。
  // **行に何を書いても答えが変わらないことを、同じ形で測る。**
  // **【意味が変わった点。隠さない】** **旧は「行の値を見ない」が**仕様の限定**だったが、
  // 今日は「`when` を書けば行ごとに変わる」** —— **見ないことは既定であって、禁止ではない。**
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const hidden = await acreate(ctx, buyer.cookie, "orders", {
      title: "隠したいつもりの注文",
      // **撤去した綴りは、今日はただの boolean 項目である**(何も決めない)。
      st_admin_readable: false,
    });
    // 行に何を書いても運営から見える(表の規則は行を見ていない)
    expect((await alist(ctx, admin.cookie, "orders")).ids).toEqual([hidden]);
    expect((await areq(ctx, admin.cookie, "GET", AR("orders", hidden))).status).toBe(200);
  });
});

test("(V3-M8-T01 e) 読めても書けない: owner の PATCH / DELETE は他人の行に対し 404 のまま", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    // 読めることを先に確かめる(可視性を通ったうえで書込が別判定で弾かれる順序)
    const read = await areq(ctx, admin.cookie, "GET", AR("orders", theirs));
    expect(read.status).toBe(200);
    const version = read.headers.get("etag") as string;

    expect(
      (await areq(ctx, admin.cookie, "PATCH", AR("orders", theirs), { title: "改" }, version))
        .status,
    ).toBe(404);
    expect(
      (await areq(ctx, admin.cookie, "DELETE", AR("orders", theirs), undefined, version)).status,
    ).toBe(404);
    // 購入者から見て行は消えても変わってもいない
    const still = await areq(ctx, buyer.cookie, "GET", AR("orders", theirs));
    expect(still.status).toBe(200);
    expect(((await still.json()) as { record: { title: string } }).record.title).toBe(
      "購入者の注文",
    );
  });
});

// --- 【`V8-M37` / 台帳 `F-G3` / ユーザ決定 `D-V8-96`。期待値を反転させた。旧を逐語で残す】 ---
//
// **旧のテスト名(逐語)**:
//   `test("(V3-M8-T01 f) 宣言済みテーブルでも POST の owner スタンプは変わらない(書込を開かない)", ...)`
// **旧の期待(逐語)**:
//   ```
//   expect(res.status).toBe(201);
//   const rec = ((await res.json()) as { record: Record<string, unknown> }).record;
//   expect(rec[OWNER_FIELD]).toBe(admin.userId); // 運営自身に矯正される
//   ```
//
// **この検査の主題(宣言が書込を1ミリも開かないこと)は1ミリも変わっていない** ——
// **運営は今日も他人名義の行を作れない。** **変わったのは断り方だけである**
// (黙って自分名義に矯正する → 403 で断る)。
test("(V3-M8-T01 f) 宣言済みテーブルでも他人名義の POST は通らない(旧: 黙って矯正 / 今日: 403)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const res = await areq(ctx, admin.cookie, "POST", AR("orders"), {
      title: "他人名義のつもり",
      [OWNER_FIELD]: buyer.userId,
    });
    expect(res.status).toBe(403);
    // **書かなければ今日どおり自分名義で作れる**(閉じすぎていないことを同じ題材で見る)。
    const plain = await areq(ctx, admin.cookie, "POST", AR("orders"), { title: "自分の注文" });
    expect(plain.status).toBe(201);
    const rec = ((await plain.json()) as { record: Record<string, unknown> }).record;
    expect(rec[OWNER_FIELD]).toBe(admin.userId);
  });
});

test("(V3-M8-T01 g)【V8-M20 の代償】撤去した綴りは匿名公開応答にそのまま現れる", async () => {
  // **旧: `test("(V3-M8-T01 g) 匿名公開応答に st_admin_readable が現れない(限定10)")`。**
  // **旧の逐語は `expect(body.records[0]).not.toHaveProperty(ADMIN_READABLE_FIELD);` と
  // `expect(one.record).not.toHaveProperty(ADMIN_READABLE_FIELD);` の2行だった。**
  //
  // **反転した理由**: **`ADR-0061` 限定10 は「予約規約フィールドを匿名に漏らさない」であり、
  // `st_admin_readable` はその1本だった。** **`V8-M20` / `J-G30` がその1本を廃止したので、
  // 同じ綴りの列は今日、普通の業務項目として匿名に出る。**
  // **検査は消していない** —— 同じ要求に対する期待値を、伏せる側から出る側へ入れ替えた。
  // **【禁止の履行】これは塞げていない穴である。塞げていないと書く。**
  // **【今日これを伏せる手だて】** **面の項目の規則(`target: "field"`)を書けば匿名から
  // 落とせる。** **ただし、書かなければ落ちない**(既定は「出す」= `ADR-0071` 限定7)——
  // **着手前は宣言を書かなくても落ちていた。**
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const id = await acreate(ctx, admin.cookie, "catalog", {
      title: "公開商品",
      [PUBLIC_FIELD]: true,
      st_admin_readable: true,
    });
    const listed = await areq(ctx, undefined, "GET", AR("catalog"));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { records: Record<string, unknown>[] };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toHaveProperty("st_admin_readable");
    // **残る予約規約フィールドは今日どおり伏せる**(撤去は他の3本を1ミリも動かしていない)。
    expect(body.records[0]).not.toHaveProperty(PUBLIC_FIELD);
    const single = await areq(ctx, undefined, "GET", AR("catalog", id));
    expect(single.status).toBe(200);
    const one = (await single.json()) as { record: Record<string, unknown> };
    expect(one.record).toHaveProperty("st_admin_readable");
    expect(one.record).not.toHaveProperty(PUBLIC_FIELD);
  });
});

test("(V3-M8-T01 h) 一覧の total も運営の母集合になる(ページングの母数がずれない)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    for (let i = 0; i < 2; i += 1) {
      await acreate(ctx, admin.cookie, "orders", { title: `A${i}` });
    }
    for (let i = 0; i < 3; i += 1) {
      await acreate(ctx, buyer.cookie, "orders", { title: `B${i}` });
    }
    const page = (await (
      await areq(ctx, admin.cookie, "GET", `${AR("orders")}?sort=title&limit=2`)
    ).json()) as { records: { title: string }[]; total: number };
    expect(page.records.map((r) => r.title)).toEqual(["A0", "A1"]);
    expect(page.total).toBe(5);
    // 購入者側の母集合は自分の3件のまま(分離が緩まない)
    const buyerPage = (await (
      await areq(ctx, buyer.cookie, "GET", `${AR("orders")}?sort=title`)
    ).json()) as { records: { title: string }[]; total: number };
    expect(buyerPage.total).toBe(3);
  });
});

// =====================================================================================
// **【`V8-M27-T04` / `T-G5`。判定ごと撤去された。旧のテスト名と旧の期待値を逐語で残す】**
//
// **旧のテスト名**:
//   `(V3-M8-T01 i) nonAdminTableAccess は面の規則で1ミリも動かない(引数に役割も面も取らない)`
// **さらにその前のテスト名**:
//   `(V3-M8-T01 i) nonAdminTableAccess は st_admin_readable で1ミリも動かない(限定11)`
//
// **旧の期待値(逐語)**:
//   expect(nonAdminTableAccess.length).toBe(1);
//   expect(nonAdminTableAccess(adminOnly)).toBe("denied");
//   expect(nonAdminTableAccess(scoped)).toBe("scoped");
//
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **`nonAdminTableAccess` は撤去された** —— **この検査が守っていた性質(「表単位の可否は
// ロールも面も見ずに、表の作りだけで決まる」)は、その層ごと無くなった。**
// **今日、表単位の可否を決めるのは面(`judgeRoleAccess`)であり、そちらは
// **役割も面の規則も受け取る**(= 旧の性質は今日は成り立たない。**反転させる先が
// 「引数を取るようになった」という別の関数なので、下の1本に置き換えた**)。
// =====================================================================================
test("(V3-M8-T01 i の置き直し) 表単位の可否は今日 `judgeRoleAccess` が決め、役割と面を受け取る", () => {
  // **旧が「1つしか受け取らない」ことで構造保証していた性質の、今日の対応物である。**
  // **`judgeRoleAccess` は宣言(面)と役割を受け取る** —— **旧の `nonAdminTableAccess` が
  // 構造的に受け取れなかったものを、今日の判定は受け取る。**
  const adminOnly: Table = {
    id: "adminonly",
    name: "運営専用",
    fields: [
      { id: "title", name: "題", type: "text" },
      // **撤去した綴りは、今日はただの boolean 項目である**(判定は元から見ていない)。
      { id: "st_admin_readable", name: "運営可視", type: "boolean" },
    ],
  };
  const scoped: Table = {
    id: "orders",
    name: "注文",
    fields: [
      { id: OWNER_FIELD, name: "所有者", type: "text" },
      { id: "st_admin_readable", name: "運営可視", type: "boolean" },
    ],
  };
  const manifest = {
    app: {
      id: "x",
      name: "x",
      tables: [adminOnly, scoped],
      views: [],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [{ target: "table", table: "orders", can: ["read"] }],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  };
  // **旧が `"denied"` を返していた表**(規約を1つも持たない)は、**規則が無い**ので今日も閉じる。
  // **ただし理由が違う** —— **表の作りではなく、規則が書かれていないことによる。**
  expect(
    judgeRoleAccess({
      manifest,
      roles: ["owner"],
      target: { target: "table", table: "adminonly" },
      verb: "read",
    }),
  ).toEqual({ allowed: false, governed: true, blockedBy: "role", conditional: false });
  // **旧が `"scoped"` を返していた表**は、**規則を1本書けば今日は開く**
  // (**旧は `st_owner` の有無だけで決まっており、規則は1ミリも効かなかった**)。
  expect(
    judgeRoleAccess({
      manifest,
      roles: ["owner"],
      target: { target: "table", table: "orders" },
      verb: "read",
    }).allowed,
  ).toBe(true);
  // **同じ表でも、規則を持たない役割には閉じる** —— **旧の判定では役割で答えが割れなかった。**
  expect(
    judgeRoleAccess({
      manifest,
      roles: ["viewer"],
      target: { target: "table", table: "orders" },
      verb: "read",
    }).allowed,
  ).toBe(false);
});

test("(V3-M8-T01 j) st_admin_readable は非テスト製品コードにコメントとしてしか残っていない", async () => {
  // ADR-0061 限定4(判定を `owner-scope.ts` に集約する / ADR-0033 §Consequences「2箇所に散らさ
  // ない」)の機械的な固定。**テストと文書は対象外**(判定はしていないため)。
  //
  // --- 【`V8-M20` / `J-G30` / `ADR-0301`】この検査の**見るもの**を置き直した ---------------
  //
  // **旧のテスト名**: `(V3-M8-T01 j) st_admin_readable は owner-scope.ts 以外の非テスト製品
  // コードに現れない(限定4)`。**旧の期待値は逐語
  // `expect(hits).toEqual([join("src", "kernel", "referential-integrity.ts")]);` だった。**
  //
  // **消さずに置き直した理由**: **限定4 が守っていたのは「この綴りを見て何かを決める場所を
  // 1箇所に閉じる」である。** **`V8-M20` はその判定を1バイトも残さずに撤去した** ——
  // **`ADMIN_READABLE_FIELD` / `adminReadableField` / `adminReadsAllRows` は `owner-scope.ts`
  // からも消えており、今日この綴りが非テスト製品コードに残っているのは**5ファイルの
  // コメント**だけである**(`owner-scope.ts` / `app.ts` / `apply-diff.ts` /
  // `referential-integrity.ts` / `requirements-doc.ts`。いずれも撤去の経緯を書いた行)。
  //
  // **そこで、期待値を「今日のコメントの在り処の列挙」に更新するのはやめた** ——
  // **それは不変条件ではなく現状の写しであり、経緯を1行書き足すたびに赤くなるからである。**
  // **代わりに「**コメント以外に現れない**」を見る。** **これは今日も生きた不変条件であり、
  // 誰かがこの綴りを判定として書き戻したら赤くなる**(`owner-scope.ts` も除外しない ——
  // **判定は1箇所にすら残っていない**)。
  //
  // **【この検査の限界。誇張しない】** **行頭がコメント記号かどうかしか見ていない** ——
  // 行末に付けたコメント(`const x = 1; // st_admin_readable`)は「コメント以外」に数える。
  // **ブロックコメントの中の非 `*` 始まりの行も同じである。** **厳しい側に倒してある。**
  const roots = ["src", "web/src"];
  const hits: string[] = [];
  for (const root of roots) {
    // **走査は絶対パスで行い、報告は公開単位の根からの相対に戻す。**
    const entries = await readdir(join(PRODUCT_ROOT, root), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith(".test.ts")) {
        continue;
      }
      const absolute = join(entry.parentPath, entry.name);
      const path = relative(PRODUCT_ROOT, absolute);
      const source = await readFile(absolute, "utf-8");
      if (!source.includes("st_admin_readable")) {
        continue;
      }
      for (const [index, line] of source.split("\n").entries()) {
        if (!line.includes("st_admin_readable")) {
          continue;
        }
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
          continue;
        }
        hits.push(`${path}:${index + 1}`);
      }
    }
  }
  expect(hits).toEqual([]);
});

test("(V3-M8-T01 k / V4-M4-T04 / V4-M10-T04 / V8-M20) 予約規約フィールドは4本で止まっている", async () => {
  // **3 → 4 に更新した。根拠は `docs/adr/0073-row-state-delete-protection.md`**(`B-G8` の
  // 門A本審査 = 限定採用。`ADR-0061` 限定9 が要求した「門A の新規審査 + 同格の個別 ADR」を
  // 満たしている = `ADR-0073` §4)。**5本目には改めて門A の新規審査 + 同格の個別 ADR が要る。**
  // ここは「4本を超えていない」ことだけを見る歯止めであり、**仕組みではない**
  // (`ADR-0061` §限界1 / `ADR-0073` §限界9: 5本目にすることは物理的に可能である)。
  //
  // **【`ADR-0061` 限定9 の検査式をそのまま使わない】**(`ADR-0073` 限定2 の逐語)——
  // 素朴な `grep -c "^export const .*_FIELD"` は今日 5 を返す。`ANON_RESERVED_FIELDS` と
  // `READ_HIDDEN_RESERVED_FIELDS`(予約規約フィールドの**一覧**であって予約規約フィールド
  // ではない)を数えてしまうためである。**下の正規表現は `= "st_..."` を要求している。**
  // **【`V8-M20`】`READ_HIDDEN_RESERVED_FIELDS` は撤去された。****今日その位置に居るのは
  // `INBOUND_STRIPPED_RESERVED_FIELDS` である** —— **素朴な `grep` が数え過ぎるという
  // 上の指摘は、一覧の名前が入れ替わっただけで今日も真である。**
  const source = await readFile(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts"), "utf-8");
  const fields = [...source.matchAll(/^export const ([A-Z_]+_FIELD) = "(st_[a-z_]+)";$/gm)].map(
    (m) => m[2] as string,
  );
  // **【V4-M10-T04 / E-G49 / ADR-0077 による更新】** **4 → 5 に更新した。** `ADR-0073`
  // 限定2 / `ADR-0061` 限定9 が要求した「門A の新規審査 + 同格の個別 ADR」を、`ADR-0077` が
  // 両方満たしている(審査記録 = `docs/plan/v4/records/v4-m7-gate-a-direct-create.md` /
  // 個別 ADR = `docs/adr/0077-direct-create-suppression.md`)。
  // **6本目には改めて門A の新規審査 + 同格の個別 ADR が要る**(`ADR-0077` 限定2)。
  //
  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` による更新。旧値をここに残す】**
  // **5 → 4 に更新した。** **旧の期待値は逐語で**
  // `["st_owner", "st_public", "st_admin_readable", "st_undeletable", "st_no_direct_create"]`
  // **であり、テスト名は「予約規約フィールドは5本で止まっている(ADR-0077 限定2)」だった。**
  // **`st_admin_readable` は `ADR-0301` の手続き(判定値 = 廃止)で1本だけ撤去された** ——
  // **これは「増えていない」ではなく**減った**方向の更新である。**
  // **【禁止の履行】これを成果として書かない**(`ADR-0301` 限定10)。
  // **5本目(= 今日の4本を超える1本)には、今日も門A の新規審査 + 同格の個別 ADR が要る。**
  expect(fields).toEqual(["st_owner", "st_public", "st_undeletable", "st_no_direct_create"]);
});

// --- P5-c: 削除不可規約(st_undeletable)の純粋判定(V4-M4-T04 / ADR-0073)---------------

/** 宣言フィールドの有無を作り分けるための表(上の `tableWith` は必ず1本足すので別に用意する)。 */
function tableWithFields(fields: Table["fields"]): Table {
  return { id: "notes", name: "メモ", fields };
}

test("undeletableField: st_undeletable(boolean 非required)を持つ表だけが宣言済み(限定1)", () => {
  expect(
    undeletableField(
      tableWithFields([
        { id: "body", name: "本文", type: "text" },
        { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
      ]),
    ),
  ).toBeDefined();
  // 型違い / required 違いは非該当(`publicField` と同型。**`V8-M20` までは
  // `adminReadableField` も同型だったが、そちらは撤去された**)。
  expect(
    undeletableField(tableWithFields([{ id: UNDELETABLE_FIELD, name: "削除不可", type: "text" }])),
  ).toBeUndefined();
  expect(
    undeletableField(
      tableWithFields([
        { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean", required: true },
      ]),
    ),
  ).toBeUndefined();
  // 宣言の無い表は undefined = 今日どおり消せる(限定4)。
  expect(
    undeletableField(tableWithFields([{ id: "body", name: "本文", type: "text" }])),
  ).toBeUndefined();
});

test("isDeleteProtectedRow: **厳密に true の行だけ**が守られる(既定は消せる = 限定4)", () => {
  const declared = tableWithFields([
    { id: "body", name: "本文", type: "text" },
    { id: UNDELETABLE_FIELD, name: "削除不可", type: "boolean" },
  ]);
  const plain = tableWithFields([{ id: "body", name: "本文", type: "text" }]);

  expect(isDeleteProtectedRow(declared, { [UNDELETABLE_FIELD]: true })).toBe(true);
  expect(isDeleteProtectedRow(declared, { [UNDELETABLE_FIELD]: false })).toBe(false);
  expect(isDeleteProtectedRow(declared, {})).toBe(false);
  // truthy な値に倒さない(既定を「消せる」へ倒す = 最小性。`isPublicRow` と同じ厳密さ)。
  expect(isDeleteProtectedRow(declared, { [UNDELETABLE_FIELD]: "true" })).toBe(false);
  expect(isDeleteProtectedRow(declared, { [UNDELETABLE_FIELD]: 1 })).toBe(false);
  // **宣言の無い表は、値が立っていても守られない**(表に在ることが宣言である)。
  expect(isDeleteProtectedRow(plain, { [UNDELETABLE_FIELD]: true })).toBe(false);
});

// --- P6: ADR-0016 §6 の表示名解決(V3-M8-T03 / ADR-0061 限定7)—— 純粋関数 -----------
//
// **`st_owner` の生 id(`_auth_users.id` = 不透明なランダム。ADR-0014 §4)を応答に出さない。**
// 解決は**サーバ責務**である(ADR-0016 §6 逐語「この join はカーネルの仕事ではなくサーバの
// 仕事である」)。ここは SQL も HTTP も知らない純粋部分だけを固定する —— 実際に
// `_auth_users` を読むのは `app.ts` 側で、掛ける先は**限定1 が開いた読取2経路の運営可視の
// ときだけ**である(限定7)。

test("(V3-M8-T03 P1) UNRESOLVED_OWNER_DISPLAY は空でない固定文字列(生 id を出さないための置換値)", () => {
  expect(typeof UNRESOLVED_OWNER_DISPLAY).toBe("string");
  expect(UNRESOLVED_OWNER_DISPLAY.length).toBeGreaterThan(0);
});

test("(V3-M8-T03 P2) ownerDisplayName: display_name があればそれ、null/空なら username", () => {
  expect(ownerDisplayName("表示名", "user1")).toBe("表示名");
  expect(ownerDisplayName(null, "user1")).toBe("user1");
  expect(ownerDisplayName(undefined, "user1")).toBe("user1");
  expect(ownerDisplayName("", "user1")).toBe("user1");
});

test("(V3-M8-T03 P3) projectOwnerDisplay: 解決できる id は表示名になり、他のキーは1つも動かない", () => {
  const names = new Map([["u-1", "購入者A"]]);
  const projected = projectOwnerDisplay(
    { _id: "r1", title: "注文", [OWNER_FIELD]: "u-1", amount: 300 },
    names,
    "u-actor",
  );
  expect(projected[OWNER_FIELD]).toBe("購入者A");
  expect(projected._id).toBe("r1");
  expect(projected.title).toBe("注文");
  expect(projected.amount).toBe(300);
  expect(Object.keys(projected).sort()).toEqual(["_id", "amount", OWNER_FIELD, "title"].sort());
});

test("(V3-M8-T03 P4) projectOwnerDisplay: 解決できない id は生 id を出さず UNRESOLVED_OWNER_DISPLAY", () => {
  const projected = projectOwnerDisplay(
    { _id: "r1", [OWNER_FIELD]: "u-missing" },
    new Map(),
    "u-actor",
  );
  expect(projected[OWNER_FIELD]).toBe(UNRESOLVED_OWNER_DISPLAY);
  expect(projected[OWNER_FIELD]).not.toBe("u-missing");
});

test("(V3-M8-T03 P5) projectOwnerDisplay: 共有センチネル(null / undefined / 空文字)はそのまま", () => {
  const names = new Map([["u-1", "購入者A"]]);
  expect(projectOwnerDisplay({ [OWNER_FIELD]: null }, names, "u-actor")[OWNER_FIELD]).toBe(null);
  expect(projectOwnerDisplay({ [OWNER_FIELD]: "" }, names, "u-actor")[OWNER_FIELD]).toBe("");
  expect(projectOwnerDisplay({ [OWNER_FIELD]: undefined }, names, "u-actor")[OWNER_FIELD]).toBe(
    undefined,
  );
});

test("(V3-M8-T03 P6) projectOwnerDisplay: st_owner キーを持たない行は1バイトも動かない", () => {
  const row = { _id: "r1", title: "共有メモ" };
  expect(projectOwnerDisplay(row, new Map([["u-1", "購入者A"]]), "u-actor")).toEqual(row);
});

test("(V3-M8-T03 P7) projectOwnerDisplay: 元の行を破壊しない(新しいオブジェクトを返す)", () => {
  const row: Record<string, unknown> = { _id: "r1", [OWNER_FIELD]: "u-1" };
  const projected = projectOwnerDisplay(row, new Map([["u-1", "購入者A"]]), "u-actor");
  expect(row[OWNER_FIELD]).toBe("u-1");
  expect(projected).not.toBe(row);
});

test("(V3-M8-T03 P8) projectOwnerDisplay: _updated_at を1バイトも動かさない(ETag / CAS に混ざらない)", () => {
  const projected = projectOwnerDisplay(
    { _id: "r1", [OWNER_FIELD]: "u-1", _updated_at: "2026-07-30T00:00:00.000Z" },
    new Map([["u-1", "購入者A"]]),
    "u-actor",
  );
  expect(projected._updated_at).toBe("2026-07-30T00:00:00.000Z");
});

// --- P6-b: 表示名解決の HTTP 統合(V3-M8-T03)--------------------------------------
//
// **掛ける先は ADR-0061 限定1 が開いた読取2経路 × 運営可視のときだけである**(限定7)。
// 既存経路(購入者が自分の行を読む / 未宣言テーブル / 書込応答)には掛けない —— それを
// 「掛かっていないこと」の側からも検査する。

/** display_name つきのユーザ + セッションを直接作る(`seedSession` は display_name を取らない)。 */
function seedNamedSession(
  dataRoot: string,
  appId: string,
  opts: { username: string; displayName: string | null; role: Role },
): { cookie: string; userId: string } {
  const store = AuthStore.openForApp(dataRoot, appId);
  try {
    const user = store.createUser({
      username: opts.username,
      displayName: opts.displayName,
      role: opts.role,
    });
    const session = store.createSession(user.id, 3600);
    return { cookie: `st_session=${session.id}`, userId: user.id };
  } finally {
    store.close();
  }
}

/** 一覧応答を生の JSON 文字列と records の両方で受け取る(生 id の混入を本文全体で見るため)。 */
async function alistBody(
  ctx: AdminCtx,
  cookie: string,
  table: string,
): Promise<{ text: string; records: Record<string, unknown>[] }> {
  const res = await areq(ctx, cookie, "GET", AR(table));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, records: (JSON.parse(text) as { records: Record<string, unknown>[] }).records };
}

test("(V3-M8-T03 a) 宣言済み × owner の一覧: 他人の st_owner が表示名になり、生 id が本文に1文字も現れない", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });
    await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    const listed = await alistBody(ctx, admin.cookie, "orders");
    expect(listed.records.length).toBe(2);
    // **他人の行だけが表示名になる。** 運営自身の行は生 id のまま —— ADR-0016 §6 が防ぐのは
    // 「他人の id の露出」であり、actor 自身の id は他人ではない(2026-07-30 の差し戻し。(k)/(l))。
    //
    // --- 【`V8-M37` / 台帳 `F-G5`。期待値を入れ替えた。旧を逐語で残す】 ---
    // **旧(逐語)**:
    //   ```
    //   expect(listed.records.map((r) => r[OWNER_FIELD]).sort()).toEqual(
    //     [admin.userId, "購入者A"].sort(),
    //   );
    //   ```
    // **上の2行のコメントも旧の説明である。1バイトも消していない。**
    // **今日は自分の行も表示名になる** —— **同じ行が、見る人によって別の形で返るのを
    // やめた**(`F-G5`)。
    expect(listed.records.map((r) => r[OWNER_FIELD]).sort()).toEqual(["購入者A", "運営者"].sort());
    // **他人の生の不透明 id は応答本文のどこにも現れない。**
    expect(listed.text).not.toContain(buyer.userId);
    // **自分の生 id も、今日は現れない。**
    expect(listed.text).not.toContain(admin.userId);
  });
});

test("(V3-M8-T03 b) 宣言済み × owner の単件: 他人の行の st_owner が表示名になり、生 id が現れない", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    const res = await areq(ctx, admin.cookie, "GET", AR("orders", theirs));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect((JSON.parse(text) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      "購入者A",
    );
    expect(text).not.toContain(buyer.userId);
  });
});

test("(V3-M8-T03 c) display_name が無いユーザは username に解決される(ADR-0016 §6 の「または username」)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer-no-display",
      displayName: null,
      role: "editor",
    });
    await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    const listed = await alistBody(ctx, admin.cookie, "orders");
    expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual(["buyer-no-display"]);
    expect(listed.text).not.toContain(buyer.userId);
  });
});

test("(V3-M8-T03 d) 該当ユーザが消えている行は、生 id ではなく UNRESOLVED_OWNER_DISPLAY になる", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });
    // 購入者を `_auth_users` から消す(退会相当)。行の st_owner だけが残る。
    // **パスは `src/kernel/storage-paths.ts` から import せず、ここで組む** —— カーネルからの
    // 値 import を1件も増やさないため(ADR-0009 限定2 / Δ8。実際に赤で踏んだ)。
    const raw = new Database(join(ctx.dataRoot, "apps", ADMIN_APP_ID, "app.sqlite"));
    try {
      raw.query(`DELETE FROM "_auth_users" WHERE "id" = ?`).run(buyer.userId);
    } finally {
      raw.close();
    }

    const listed = await alistBody(ctx, admin.cookie, "orders");
    expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual([UNRESOLVED_OWNER_DISPLAY]);
    expect(listed.text).not.toContain(buyer.userId);
    const single = await areq(ctx, admin.cookie, "GET", AR("orders", theirs));
    expect(single.status).toBe(200);
    expect(((await single.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      UNRESOLVED_OWNER_DISPLAY,
    );
  });
});

test("(V3-M8-T03 e) 共有行(st_owner=null)は、解決が走るページの中でも null のまま", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    // **同じページに解決対象の行を1件混ぜる** —— そうしないと「解決を走らせない」最適化の
    // せいで、共有行の扱いそのものを検査したことにならない(V3-M8-T03 の赤⑥ で実測)。
    await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "共有化する注文" });
    const got = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    const version = got.headers.get("etag") as string;
    expect(
      (await areq(ctx, admin.cookie, "PATCH", AR("orders", own), { [OWNER_FIELD]: null }, version))
        .status,
    ).toBe(200);

    const listed = await alistBody(ctx, admin.cookie, "orders");
    expect(listed.records.map((r) => r[OWNER_FIELD]).sort()).toEqual([null, "購入者A"].sort());
    // 単件でも同じ(共有行は解決を通らない)。
    const single = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(((await single.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      null,
    );
  });
});

test("(V3-M8-T03 e2) 解決対象の id が1つも無いページでは `_auth_users` を1度も読まない", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "共有化する注文" });
    const got = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(
      (
        await areq(
          ctx,
          admin.cookie,
          "PATCH",
          AR("orders", own),
          { [OWNER_FIELD]: null },
          got.headers.get("etag") as string,
        )
      ).status,
    ).toBe(200);

    const listSpy = spyOn(AuthStore.prototype, "listUsers");
    try {
      const listed = await alistBody(ctx, admin.cookie, "orders");
      expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual([null]);
      expect(listSpy.mock.calls.length).toBe(0);
    } finally {
      listSpy.mockRestore();
    }
  });
});

// --- 【`V8-M37` / 台帳 `F-G5`。(f) / (g) の期待値を入れ替えた。旧を逐語で残す】 -----------
//
// **旧のテスト名(逐語)**:
//   `test("(V3-M8-T03 f) 既存経路には掛からない: 購入者が自分の行を読むと st_owner は自分の生 id のまま", ...)`
//   `test("(V3-M8-T03 g) 未宣言テーブルでは owner でも解決が掛からない(自分の行の生 id がそのまま出る)", ...)`
// **旧の期待(逐語)**:
//   ```
//   expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual([buyer.userId]);
//   const single = await areq(ctx, buyer.cookie, "GET", AR("orders", own));
//   expect(((await single.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
//     buyer.userId,
//   );
//   ```
//   ```
//   expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual([admin.userId]);
//   ```
//
// **【この入れ替えで分かったこと。実測なので書く】**
// **この2本を緑にしていたのは「整形が掛かる先が狭いこと」ではなく、
// `projectOwnerDisplay` の `rowOwner === actorId` の枝**だった** ——
// **`F-G5` がその枝を落としただけで、どちらも表示名になった。**
// **すなわち整形の引き金(`roleCrossesOwner`)は、`diaries`(旧文の「未宣言テーブル」)でも
// 今日は真である**(`V8-M26` の既定の規則が入ったため)。**旧のテスト名が言う
// 「既存経路には掛からない」「解決が掛からない」は、今日の実装を説明していない。**
// **`ADR-0061` 限定7 の射程(整形を掛ける経路を1つも増やさない)は今日も守られている** ——
// **`F-G5` は `resolveOwnerDisplays` を呼ぶ場所を1箇所も増やしていない。**
test("(V3-M8-T03 f) 購入者が自分の行を読むと st_owner は表示名になる(旧: 自分の生 id のまま)", async () => {
  await withAdminApp(async (ctx) => {
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    const own = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    const listed = await alistBody(ctx, buyer.cookie, "orders");
    expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual(["購入者A"]);
    const single = await areq(ctx, buyer.cookie, "GET", AR("orders", own));
    expect(((await single.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      "購入者A",
    );
  });
});

test("(V3-M8-T03 g) diaries でも自分の行が表示名になる(旧: 自分の行の生 id がそのまま出る)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    await acreate(ctx, admin.cookie, "diaries", { title: "運営自身の日記" });

    const listed = await alistBody(ctx, admin.cookie, "diaries");
    expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual(["運営者"]);
  });
});

test("(V3-M8-T03 h) ETag は表示名解決の影響を受けない(_updated_at と一致し、その版で PATCH が通る)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer-etag",
      displayName: "購入者A",
      role: "editor",
    });
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });

    // **解決が掛かった行**で、ETag が整形前の `_updated_at` と一致することを見る。
    const resolved = await areq(ctx, admin.cookie, "GET", AR("orders", theirs));
    expect(resolved.status).toBe(200);
    const resolvedEtag = resolved.headers.get("etag");
    const resolvedRecord = ((await resolved.json()) as { record: Record<string, unknown> }).record;
    expect(resolvedRecord[OWNER_FIELD]).toBe("購入者A"); // 解決は掛かっている
    expect(resolvedEtag).toBe(resolvedRecord._updated_at as string); // 版は整形の影響を受けていない

    // 自分の行の版で PATCH が通る(CAS が壊れていない)。
    const got = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(got.status).toBe(200);
    const etag = got.headers.get("etag");
    const record = ((await got.json()) as { record: Record<string, unknown> }).record;
    expect(etag).toBe(record._updated_at as string);
    const patched = await areq(
      ctx,
      admin.cookie,
      "PATCH",
      AR("orders", own),
      { title: "改題" },
      etag as string,
    );
    expect(patched.status).toBe(200);
  });
});

test("(V3-M8-T03 i) 書込経路を1つも開いていない: POST 応答は解決されず、他人の行の PATCH / DELETE は 404 のまま", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    // POST(書込)の応答は整形しない —— 表示名解決は読取2経路だけである(限定7)。
    const created = await areq(ctx, admin.cookie, "POST", AR("orders"), { title: "運営の注文" });
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD],
    ).toBe(admin.userId);
    // 読めるが直せない(D-M8-2)。表示名解決は書込認可に1ミリも波及していない。
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });
    const got = await areq(ctx, admin.cookie, "GET", AR("orders", theirs));
    expect(got.status).toBe(200);
    const version = got.headers.get("etag") as string;
    expect(
      (await areq(ctx, admin.cookie, "PATCH", AR("orders", theirs), { title: "×" }, version))
        .status,
    ).toBe(404);
    expect(
      (await areq(ctx, admin.cookie, "DELETE", AR("orders", theirs), undefined, version)).status,
    ).toBe(404);
  });
});

test("(V3-M8-T03 j) N+1 になっていない: 行数・所有者数によらず `_auth_users` の一括読取は1回", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    // 5人の購入者が各3行 = 15行(所有者5人)。
    for (let u = 0; u < 5; u += 1) {
      const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
        username: `buyer-${u}`,
        displayName: `購入者${u}`,
        role: "editor",
      });
      for (let r = 0; r < 3; r += 1) {
        await acreate(ctx, buyer.cookie, "orders", { title: `注文 ${u}-${r}` });
      }
    }

    const listSpy = spyOn(AuthStore.prototype, "listUsers");
    const findSpy = spyOn(AuthStore.prototype, "findUserById");
    try {
      const listed = await alistBody(ctx, admin.cookie, "orders");
      expect(listed.records.length).toBe(15);
      // 行ごとの引き当て(N+1)をしていない —— `findUserById` はセッション解決の1回だけ。
      expect(findSpy.mock.calls.length).toBe(1);
      // 一括解決: `listUsers` は1リクエストにつき1回だけ(行数15・所有者5に依らない)。
      expect(listSpy.mock.calls.length).toBe(1);
    } finally {
      listSpy.mockRestore();
      findSpy.mockRestore();
    }
  });
});

// --- P7: メインの差し戻し(2026-07-30)—— actor 自身の id は置き換えない -------------
//
// **T03 の初版は `adminReadable` が真のとき、行の所有者が actor 自身であっても表示名に
// 置き換えていた。** その結果、**宣言済みテーブルでだけ「運営が自分の行を読んで丸ごと書き戻すと
// 403」という退行**が生じていた(`isAllowedOwnerUpdate` が表示名を他人 id への付け替えと見なす)。
// **メインが実測で見つけ、差し戻した。** ADR-0016 §6 が防ぐのは**他人**の id の露出であり、
// actor 自身の id を置き換える理由は §6 に無い。**以下はその再発を止める検査である。**

// --- 【`V8-M37` / 台帳 `F-G5`。(P9) の期待値を入れ替えた。旧を逐語で残す】 ---------------
//
// **上の段落(2026-07-30 の差し戻しの説明)を1バイトも消していない。**
// **旧のテスト名(逐語)**:
//   `test("(V3-M8-T03 P9) projectOwnerDisplay: actor 自身の id は1バイトも触らない", ...)`
// **旧の期待(逐語)**:
//   ```
//   expect(projectOwnerDisplay({ [OWNER_FIELD]: "u-me" }, names, "u-me")[OWNER_FIELD]).toBe("u-me");
//   ```
//
// **`F-G5` はその差し戻しを戻した(= 自分の行も表示名にする)。**
// **上の段落が名指しした退行(自分の行を丸ごと書き戻すと 403)は、本単位で実際に再現した** ——
// **塞いだのは `judgeOwnerUpdateWithDisplay` であり、(l) がその実測である。**
test("(V3-M8-T03 P9) projectOwnerDisplay: actor 自身の id も表示名になる(旧: 1バイトも触らない)", () => {
  const names = new Map([
    ["u-me", "自分"],
    ["u-other", "他人"],
  ]);
  expect(projectOwnerDisplay({ [OWNER_FIELD]: "u-me" }, names, "u-me")[OWNER_FIELD]).toBe("自分");
  expect(projectOwnerDisplay({ [OWNER_FIELD]: "u-other" }, names, "u-me")[OWNER_FIELD]).toBe(
    "他人",
  );
});

// --- 【`V8-M37` / 台帳 `F-G5`。(k) の期待値を入れ替えた。旧を逐語で残す】 ----------------
//
// **旧のテスト名(逐語)**:
//   `test("(V3-M8-T03 k) 宣言済みテーブルでも、運営が読む自分の行の st_owner は生 id のまま", ...)`
// **旧の期待(逐語)**:
//   ```
//   // 一覧: 自分の行は生 id のまま / 他人の行だけが表示名になる。
//   const listed = await alistBody(ctx, admin.cookie, "orders");
//   expect(listed.records.map((r) => r[OWNER_FIELD]).sort()).toEqual(
//     [admin.userId, "購入者A"].sort(),
//   );
//   expect(listed.text).not.toContain(buyer.userId);
//   // 単件も同じ。
//   const single = await areq(ctx, admin.cookie, "GET", AR("orders", own));
//   expect(((await single.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
//     admin.userId,
//   );
//   ```
test("(V3-M8-T03 k) 運営が読む自分の行も表示名になる(旧: 生 id のまま)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });
    await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    // 一覧: 自分の行も他人の行も表示名になる(**見る人で形が変わらない**)。
    const listed = await alistBody(ctx, admin.cookie, "orders");
    expect(listed.records.map((r) => r[OWNER_FIELD]).sort()).toEqual(["購入者A", "運営者"].sort());
    expect(listed.text).not.toContain(buyer.userId);
    expect(listed.text).not.toContain(admin.userId);
    // 単件も同じ。
    const single = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(((await single.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      "運営者",
    );
  });
});

test("(V3-M8-T03 l) 運営は宣言済みテーブルの自分の行を、読んだ内容のまま書き戻せる(403 にならない)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    await acreate(ctx, buyerSeedForWriteBack(ctx).cookie, "orders", { title: "購入者の注文" });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });

    const got = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(got.status).toBe(200);
    const etag = got.headers.get("etag") as string;
    const record = ((await got.json()) as { record: Record<string, unknown> }).record;
    // **読んだ record をそのまま body に載せる**(システム列だけ外す)。`st_owner` は含める ——
    // ここが表示名になっていると `isAllowedOwnerUpdate` が偽になり 403 になる(差し戻しの本体)。
    const body: Record<string, unknown> = { ...record };
    for (const key of ["_id", "_created_at", "_updated_at"]) {
      delete body[key];
    }
    const patched = await areq(ctx, admin.cookie, "PATCH", AR("orders", own), body, etag);
    expect(patched.status).toBe(200);
    // --- 【`V8-M37` / 台帳 `F-G5`。期待値を入れ替えた。旧を逐語で残す】 ---
    // **旧(逐語)**: `expect(body[OWNER_FIELD]).toBe(admin.userId);`
    // **今日は読んだ時点で表示名になっているので、送る body も表示名である** ——
    // **`F-G5` の退行が実際に起きたのはここであり、`judgeOwnerUpdateWithDisplay` が塞いだ。**
    expect(body[OWNER_FIELD]).toBe("運営者");
    // **保存された値は、表示名ではなく元の id に戻っている**(次の読取で「不明なユーザ」に
    // 化けていないことを、表示名が返ることで見る)。
    const after = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(((await after.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      "運営者",
    );
  });
});

/** (l) 用: 解決が実際に走るページにするため、他人の行を1件作るユーザ。 */
function buyerSeedForWriteBack(ctx: AdminCtx): { cookie: string; userId: string } {
  return seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
    username: "buyer-writeback",
    displayName: "購入者W",
    role: "editor",
  });
}

// --- 【`V8-M37` / 台帳 `F-G5`。(m) の期待値を入れ替えた。旧を逐語で残す】 ----------------
//
// **旧のテスト名(逐語)**:
//   `test("(V3-M8-T03 m) 自分の行だけのページでは `_auth_users` を1度も読まない", ...)`
// **旧の期待(逐語)**:
//   ```
//   expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual([admin.userId, admin.userId]);
//   expect(listSpy.mock.calls.length).toBe(0);
//   ```
//
// **【これは代償である。隠さない】** **自分の行しか無いページでも `_auth_users` を
// 1回読むようになった。** **`F-G5` が自分の行も表示名にした以上、写像を作らずに済ませる
// 道は無い**(作らないと自分の id が「不明なユーザ」に化ける)。
// **一括読取が1回であること(N+1 でないこと)は1ミリも変わっていない** ——
// **(V3-M8-T03 j) が今日もそれを測っている。**
// **「共有行だけのページでは今日も開かない」ことは (V3-M8-T03 i) が測っている。**
test("(V3-M8-T03 m) 自分の行だけのページでも `_auth_users` を1回読む(旧: 1度も読まない)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文1" });
    await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文2" });

    const listSpy = spyOn(AuthStore.prototype, "listUsers");
    try {
      const listed = await alistBody(ctx, admin.cookie, "orders");
      expect(listed.records.map((r) => r[OWNER_FIELD])).toEqual(["運営者", "運営者"]);
      expect(listSpy.mock.calls.length).toBe(1);
    } finally {
      listSpy.mockRestore();
    }
  });
});

// --- P7: 購入者間分離の非退行と、書込側が開いていないことの検査(V3-M8-T02)-----------
//
// **本節は製品コードを1バイトも変更しない**(`v3-m8.md` §2 T02 完了条件10)。**既存テストを
// 1本も削除・改変せず、追加だけで達成する**(差し戻し条件7)。
//
// 固定するのは4点で、いずれも **T01(読取可視性)/ T01b(バッチの owner ガード)/ T03
// (表示名解決)が既に固定した検査と重ならない形**にしている:
//   (1) **購入者どうし**の可視性が、宣言の有無で1ミリも変わらないこと(ADR-0061 限定表の
//       「購入者どうしの分離 = 1ミリも緩まない」の当て先)。既存の T01 (b)/(c) は
//       「運営から見て」「他人の行が見えない」を見ており、**購入者2人が各自の行だけを見る**
//       ことと、**宣言済み / 未宣言で結果が同一である**ことは見ていない。
//   (2) `customer` / 匿名に宣言が1ミリも効かないこと(限定11 / 限定10 の裏側)。既存の
//       T01 (g)/(i) は「予約フィールドが匿名に漏れない」「`nonAdminTableAccess` が動かない」
//       までで、**HTTP 経路で customer と匿名のふるまいが変わらない**ことは見ていない。
//   (3) **見えるが直せない**を、`PATCH` / `DELETE` / **`/batch`** の3経路**同時に**、
//       同一の1行について見ること(`v3-m8.md` §2a-4 (6))。既存の T01 (e) は PATCH/DELETE
//       だけ、`batch/owner 9` は batch だけで、**「見える集合」と「直せる集合」の差**を
//       1つの行の上で並べた検査は無い。
//   (4) **見えることと直せることが別の判定で決まる**ことを、真理値表(宣言済み / 未宣言 ×
//       4経路)と純粋関数の引数の形で示すこと。T01b §7-3 完了条件4 が固定したのは
//       **書込側の中での順序**(可視性 → 付け替え)であり、**読取と書込が別判定である**
//       ことではない。
//
// 使うアプリは P5 の `adminvis`(`orders` = 宣言済み / `diaries` = 未宣言 / `catalog` =
// 公開 + 宣言)。**`adminManifest()` を1バイトも変更していない。**

/** `adminvis` アプリへバッチ書込を POST する(V3-M8-T02。§2a-4 (6) で射程に入った)。 */
function abatch(ctx: AdminCtx, cookie: string, ops: unknown): Promise<Response> {
  return areq(ctx, cookie, "POST", `/api/apps/${ADMIN_APP_ID}/batch`, { ops });
}

/** その行の版(ETag)を、**その行が見える cookie** で取る(If-Match 必須。ADR-0017)。 */
async function aversion(ctx: AdminCtx, cookie: string, table: string, id: string): Promise<string> {
  const res = await areq(ctx, cookie, "GET", AR(table, id));
  expect(res.status).toBe(200);
  return res.headers.get("etag") as string;
}

/** 2人の購入者が同じテーブルに1件ずつ持つときの、互いの可視性の実測。 */
async function separation(
  ctx: AdminCtx,
  table: string,
  a: { cookie: string },
  b: { cookie: string },
): Promise<{
  aListLen: number;
  aTotal: number;
  bListLen: number;
  bTotal: number;
  aSeesOwn: boolean;
  bSeesOwn: boolean;
  aSeesB: number;
  bSeesA: number;
}> {
  const ra = await acreate(ctx, a.cookie, table, { title: "Aの行" });
  const rb = await acreate(ctx, b.cookie, table, { title: "Bの行" });
  const la = await alist(ctx, a.cookie, table);
  const lb = await alist(ctx, b.cookie, table);
  return {
    aListLen: la.ids.length,
    aTotal: la.total,
    bListLen: lb.ids.length,
    bTotal: lb.total,
    aSeesOwn: la.ids.includes(ra),
    bSeesOwn: lb.ids.includes(rb),
    aSeesB: (await areq(ctx, a.cookie, "GET", AR(table, rb))).status,
    bSeesA: (await areq(ctx, b.cookie, "GET", AR(table, ra))).status,
  };
}

test("(V3-M8-T02 a) 宣言済みテーブル: 購入者 A の行は購入者 B に1件も見えない(customer どうし)", async () => {
  await withAdminApp(async (ctx) => {
    const a = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerA" });
    const b = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerB" });
    expect(await separation(ctx, "orders", a, b)).toEqual({
      aListLen: 1,
      aTotal: 1,
      bListLen: 1,
      bTotal: 1,
      aSeesOwn: true,
      bSeesOwn: true,
      aSeesB: 404,
      bSeesA: 404,
    });
  });
});

test("(V3-M8-T02 b) 未宣言テーブル: 購入者 A の行は購入者 B に1件も見えない(customer どうし)", async () => {
  await withAdminApp(async (ctx) => {
    const a = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerA" });
    const b = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerB" });
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。旧の期待値を逐語で残す】**
    // **旧:**
    // ```
    // expect(await separation(ctx, "diaries", a, b)).toEqual({
    //   aListLen: 1, aTotal: 1, bListLen: 1, bTotal: 1,
    //   aSeesOwn: true, bSeesOwn: true, aSeesB: 404, bSeesA: 404,
    // });
    // ```
    //
    // **`customer`(宣言された利用者の種類)は自動付与の対象外である** ——
    // **自動で規則が入るのは既定3役割(`owner` / `editor` / `viewer`)だけであり、
    // `apply-diff.ts` も `withDefaultRoleRules` も `customer` に1本も足さない。**
    // **その結果、`customer` は規則を書いていない表に1行も作れなくなった**(403)。
    // **「A の行が B に1件も見えない」という結論そのものは今日も成り立つ** ——
    // **ただし理由が個人スコープ(`st_owner`)から面の既定へ移り、**自分の行すら
    // 作れない・見えない**という強い形になった。**
    // **【正直に書く】これは `V8-M26` が今日できていたことを止めた実例である。**
    expect((await areq(ctx, a.cookie, "POST", AR("diaries"), { title: "Aの行" })).status).toBe(403);
    expect((await areq(ctx, b.cookie, "POST", AR("diaries"), { title: "Bの行" })).status).toBe(403);
    const la = await alist(ctx, a.cookie, "diaries");
    expect({ ids: la.ids, total: la.total }).toEqual({ ids: [], total: 0 });
  });
});

test("(V3-M8-T02 c) 宣言の有無で購入者どうしの可視性が1ミリも変わらない(同一手順の結果が一致)", async () => {
  await withAdminApp(async (ctx) => {
    const a = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerA" });
    const b = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerB" });
    // 同じ2人が、宣言済み(orders)と未宣言(diaries)で同じ手順を踏む。
    const declared = await separation(ctx, "orders", a, b);
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。旧の2行を逐語で残す】**
    // **旧: `const undeclared = await separation(ctx, "diaries", a, b);`**
    // **旧: `expect(declared).toEqual(undeclared);`**(**T01 が開いた宣言は、購入者どうしの
    // 可視性に1ミリも影響しない**)
    //
    // **今日は「同じ手順」を踏めない** —— **`customer` の規則を書いていない `diaries` では
    // 作成が 403 で止まり、`separation` の1行目で落ちる。**
    // **したがって「宣言の有無で変わらない」はもう書けない** —— **変わる。**
    // **宣言済み(`orders`。`customer` に条件つきの規則が在る)側の見え方は
    // 着手前と1バイトも同じである** —— **下の突き合わせがそれを固定している。**
    expect(declared).toEqual({
      aListLen: 1,
      aTotal: 1,
      bListLen: 1,
      bTotal: 1,
      aSeesOwn: true,
      bSeesOwn: true,
      aSeesB: 404,
      bSeesA: 404,
    });
    expect((await areq(ctx, a.cookie, "POST", AR("diaries"), { title: "Aの行" })).status).toBe(403);
  });
});

test("(V3-M8-T02 d) 宣言済みテーブル: editor どうしも各自の行だけを見る(自分の行は見える)", async () => {
  await withAdminApp(async (ctx) => {
    // T01 (c) は「他人の行が見えない(一覧が空)」までを見ている。ここは **2人が各自1件ずつ
    // 持つ状態**で、自分の行だけが見えること(= 分離であって全遮断ではないこと)を見る。
    const a = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "userA" });
    const b = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "userB" });
    expect(await separation(ctx, "orders", a, b)).toEqual({
      aListLen: 1,
      aTotal: 1,
      bListLen: 1,
      bTotal: 1,
      aSeesOwn: true,
      bSeesOwn: true,
      aSeesB: 404,
      bSeesA: 404,
    });
  });
});

test("(V3-M8-T02 e) customer の可視・書込範囲は宣言済みテーブルでも1ミリも変わらない(限定11)", async () => {
  await withAdminApp(async (ctx) => {
    const a = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerA" });
    const b = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer", username: "buyerB" });
    const theirs = await acreate(ctx, b.cookie, "orders", { title: "Bの注文" });
    const version = await aversion(ctx, b.cookie, "orders", theirs);

    // 読取: 他人の行は 404(存在も伏せる)
    expect((await areq(ctx, a.cookie, "GET", AR("orders", theirs))).status).toBe(404);
    // 書込: 他人の行は PATCH / DELETE とも 404
    expect(
      (await areq(ctx, a.cookie, "PATCH", AR("orders", theirs), { title: "改" }, version)).status,
    ).toBe(404);
    expect(
      (await areq(ctx, a.cookie, "DELETE", AR("orders", theirs), undefined, version)).status,
    ).toBe(404);
    // --- 【`V8-M37` / 台帳 `F-G3` / `D-V8-96`。期待値を反転させた。旧を逐語で残す】 ---
    //
    // **旧のコメント(逐語)**: `// POST は自分名義にスタンプされる(他人 id を送っても矯正)`
    // **旧の期待(逐語)**:
    //   ```
    //   const created = await areq(ctx, a.cookie, "POST", AR("orders"), {
    //     title: "Aの注文",
    //     [OWNER_FIELD]: b.userId,
    //   });
    //   expect(created.status).toBe(201);
    //   expect(
    //     ((await created.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD],
    //   ).toBe(a.userId);
    //   ```
    //
    // **この検査の主題(customer の書込範囲が宣言で1ミリも動かないこと)は変わっていない。**
    // **他人名義の POST は今日 403 で断られ、書かない POST は今日どおり自分名義になる。**
    expect(
      (
        await areq(ctx, a.cookie, "POST", AR("orders"), {
          title: "Aの注文",
          [OWNER_FIELD]: b.userId,
        })
      ).status,
    ).toBe(403);
    const created = await areq(ctx, a.cookie, "POST", AR("orders"), { title: "Aの注文" });
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD],
    ).toBe(a.userId);
    // バッチは従来どおりロール門で 403(customer は書込ロールではない)
    //
    // --- 【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧の期待値を逐語で残す】 ---
    //
    // **旧(逐語)**: `).toBe(403);` —— **上のコメント「バッチは従来どおりロール門で 403
    // (customer は書込ロールではない)」も旧の説明である。1バイトも消していない。**
    //
    // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38` / `D-V8-71`。**
    // **まとめ書き込みの `hasAdminWriteRole`(「運営の予約3ロールか否か」)を撤去した** ——
    // **`customer` はもうロール門で止まらない。** **今日その要求を止めているのは、
    // 他人の行が見えないこと(個人スコープ)そのものであり、応答は 404 である。**
    // **【この検査の主題は1ミリも変わっていない】** —— **「他人の行は触れない」は今日も真で、
    // 止める層が「ロールの綴り」から「その行が見えないこと」に移っただけである。**
    // **`st_owner` は1バイトも触っていない。**
    expect(
      (
        await abatch(ctx, a.cookie, [
          { op: "update", table: "orders", target: theirs, values: { title: "改" } },
        ])
      ).status,
    ).toBe(404);
  });
});

test("(V3-M8-T02 f) 匿名公開の挙動は宣言済みテーブルでも1ミリも変わらない(st_public===true の行だけ)", async () => {
  await withAdminApp(async (ctx) => {
    // `catalog` は st_public と st_admin_readable を両方持つ。**宣言は匿名の窓を1ミリも広げない。**
    // **【`V8-M20` / `J-G30`】`st_admin_readable` は今日ただの boolean 項目である** ——
    // **`ADMIN_READABLE_FIELD` が消えたので、綴りを直に書いている。**
    // **この検査が測っているもの(公開行だけが匿名に出る)は1ミリも変わっていない。**
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const open = await acreate(ctx, admin.cookie, "catalog", {
      title: "公開商品",
      [PUBLIC_FIELD]: true,
      st_admin_readable: true,
    });
    const closed = await acreate(ctx, admin.cookie, "catalog", {
      title: "非公開商品",
      [PUBLIC_FIELD]: false,
      st_admin_readable: true,
    });

    const listed = await areq(ctx, undefined, "GET", AR("catalog"));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { records: { _id: string }[]; total: number };
    expect(body.records.map((r) => r._id)).toEqual([open]);
    expect(body.total).toBe(1);
    expect((await areq(ctx, undefined, "GET", AR("catalog", open))).status).toBe(200);
    expect((await areq(ctx, undefined, "GET", AR("catalog", closed))).status).toBe(404);
    // 書込窓も開いていない(匿名 POST は 401 のまま)
    expect((await areq(ctx, undefined, "POST", AR("catalog"), { title: "匿名投稿" })).status).toBe(
      401,
    );
  });
});

test("(V3-M8-T02 g) 見えるが直せない: 同一の1行に対し PATCH / DELETE / batch が3経路とも弾かれる", async () => {
  await withAdminApp(async (ctx) => {
    // **§2a-4 (6)**: T01b がバッチ経路を変更したので、T02 は `/batch` も射程に入れる。
    // T01 (e) は PATCH / DELETE、`batch/owner 9` は batch を個別に固定しているが、
    // **同一の行について「見える集合」と「直せる集合」の差**を並べたのはここが最初である。
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    // (1) 可視性を先に通る —— 一覧にも単件にも出る。
    expect((await alist(ctx, admin.cookie, "orders")).ids).toEqual([theirs]);
    const read = await areq(ctx, admin.cookie, "GET", AR("orders", theirs));
    expect(read.status).toBe(200);
    const version = read.headers.get("etag") as string;

    // (2) そのうえで、書込は3経路とも別判定で弾かれる。
    expect(
      (await areq(ctx, admin.cookie, "PATCH", AR("orders", theirs), { title: "改" }, version))
        .status,
    ).toBe(404);
    expect(
      (await areq(ctx, admin.cookie, "DELETE", AR("orders", theirs), undefined, version)).status,
    ).toBe(404);
    expect(
      (
        await abatch(ctx, admin.cookie, [
          { op: "update", table: "orders", target: theirs, values: { title: "改" } },
        ])
      ).status,
    ).toBe(404);

    // (3) 3経路を通したあとも、行は1バイトも変わっていない(購入者から見て)。
    const still = await areq(ctx, buyer.cookie, "GET", AR("orders", theirs));
    expect(still.status).toBe(200);
    expect(((await still.json()) as { record: { title: string } }).record.title).toBe(
      "購入者の注文",
    );
  });
});

/** 運営ロールから他人の行への4経路(読取1 + 書込3)の応答コードを実測する。 */
async function adminProbe(
  ctx: AdminCtx,
  admin: { cookie: string },
  buyer: { cookie: string },
  table: string,
): Promise<{ get: number; patch: number; delete: number; batch: number }> {
  const theirs = await acreate(ctx, buyer.cookie, table, { title: "購入者の行" });
  const version = await aversion(ctx, buyer.cookie, table, theirs);
  return {
    get: (await areq(ctx, admin.cookie, "GET", AR(table, theirs))).status,
    patch: (await areq(ctx, admin.cookie, "PATCH", AR(table, theirs), { title: "改" }, version))
      .status,
    delete: (await areq(ctx, admin.cookie, "DELETE", AR(table, theirs), undefined, version)).status,
    batch: (
      await abatch(ctx, admin.cookie, [
        { op: "update", table, target: theirs, values: { title: "改" } },
      ])
    ).status,
  };
}

test("(V3-M8-T02 h) 見えることと直せることは別の判定: 宣言で動くのは読取だけで、書込3経路は同一", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner", username: "admin" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    const declared = await adminProbe(ctx, admin, buyer, "orders");
    const undeclared = await adminProbe(ctx, admin, buyer, "diaries");

    expect(declared).toEqual({ get: 200, patch: 404, delete: 404, batch: 404 });
    // **【`V8-M26`。ユーザ決定 `D-V8-61` / `D-V8-62`。旧の2行を逐語で残す】**
    // **旧: `expect(undeclared).toEqual({ get: 404, patch: 404, delete: 404, batch: 404 });`**
    // **旧: `expect(declared.get).not.toBe(undeclared.get);`**(**読取だけが宣言で動く**)
    //
    // **`diaries` にも既定3役割の規則が入るようになったので、運営者の読取は
    // `orders`(手で宣言した表)と同じ 200 になった** —— **「宣言の有無」で読取が
    // 変わらなくなった。**
    // **この検査のもう一方の主題(**書込3経路は宣言の有無によらず 404 のまま** =
    // 書込認可が可視性の判定結果を1ミリも参照していないこと)は今日も生きており、
    // 下の突き合わせがそれを固定している。**
    expect(undeclared).toEqual({ get: 200, patch: 404, delete: 404, batch: 404 });
    // **読取だけが宣言で動く。**
    // **【`V8-M26` による訂正。上の1行と下の1行は1バイトも消していない】**
    // **既定の規則が両方の表に入った今日、読取は**どちらも**通る。**
    expect(declared.get).toBe(undeclared.get);
    // **書込3経路は宣言の有無によらず同じ** = 書込認可は可視性の判定結果を1ミリも参照していない。
    expect([declared.patch, declared.delete, declared.batch]).toEqual([
      undeclared.patch,
      undeclared.delete,
      undeclared.batch,
    ]);
  });
});

test("(V3-M8-T02 i) 判定の構造: 面は読取の OR の片側にしか入らず、書込側の判定関数には届かない", () => {
  // **旧: `test("(V3-M8-T02 i) 判定の構造: 宣言は読取判定の第3引数にしか入らず、書込側の
  // 判定関数には届かない")`。** **旧の逐語は**
  // `expect(isOwnerVisible(other, me, adminReadsAllRows(declared, "owner"))).toBe(true);` /
  // `expect(isOwnerVisible(other, me, adminReadsAllRows(undeclared, "owner"))).toBe(false);`
  // **の2行だった**(`declared` / `undeclared` は `st_admin_readable` の有無で作り分けた `Table`)。
  //
  // **置き直し(`V8-M20` / `J-G30` / `D-V8-35`)**: **越えるかどうかを決めるのは表の
  // フィールドではなく面の規則になり、`isOwnerVisible` の第3引数は撤去された。**
  // **今日の形は `app.ts` が組む `isOwnerVisible(...) || roleReadCrossesOwnerScope(...)` である。**
  // **見ているもの(読取だけが面で動き、書込の判定関数には面が構造的に届かない)は同じ。**
  const me = "u-admin";
  const other = "u-buyer";
  const crosses = (table: string): boolean =>
    roleReadCrossesOwnerScope({ manifest: ORDERS_READ_BY_OWNER, roles: "owner", table });

  // 読取経路が組む形: 面が読取を許した表でだけ owner 軸を越える。
  expect(isOwnerVisible(other, me) || crosses("orders")).toBe(true);
  expect(isOwnerVisible(other, me) || crosses("diaries")).toBe(false);
  // 書込経路が渡す形(`OR` を組まない): 面を1ミリも見ない。
  expect(isOwnerVisible(other, me)).toBe(false);
  // **`isOwnerVisible` は面を引数に取れない** = 越え方を構造的に知らない(引数は2本)。
  expect(isOwnerVisible.length).toBe(2);
  // 付け替えの判定は Table も Role も面も引数に取らない = 構造的に届かない。
  expect(isAllowedOwnerUpdate.length).toBe(2);
  expect(isAllowedOwnerUpdate(other, other)).toBe(true);
  expect(isAllowedOwnerUpdate(me, other)).toBe(false);
});

test("(V3-M8-T02 j) editor には宣言が1ミリも効かない: 読めず、書けない(4経路)", async () => {
  await withAdminApp(async (ctx) => {
    const editor = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "editorX" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    expect(await adminProbe(ctx, editor, buyer, "orders")).toEqual({
      get: 404,
      patch: 404,
      delete: 404,
      batch: 404,
    });
  });
});

test("(V3-M8-T02 k) viewer には宣言が1ミリも効かない: 読めず、書込はロール門で 403(可視性より前)", async () => {
  await withAdminApp(async (ctx) => {
    const viewer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "viewer", username: "peek" });
    const buyer = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "editor", username: "buyer" });
    // viewer は書込ロールでないので、書込3経路は**可視性を見る前に** 403 で落ちる
    // (= 「見える / 直せる」が別判定であることの、もう一方向の現れ)。
    expect(await adminProbe(ctx, viewer, buyer, "orders")).toEqual({
      get: 404,
      patch: 403,
      delete: 403,
      batch: 403,
    });
  });
});

// --- P5: 「書けるが効かない値」を応答に残さない(E-G54 / V4-M6)-----------------------
//
// **`ADR-0061` 限定3 は「宣言はテーブル単位で、行の値は判定に使わない」と定めており、その帰結
// として `st_admin_readable` は「書けるが効かない値」になる**(同 §限界3 が承知で採ったと記録
// している)。実地では `order` の全9行が NULL のまま運営に9件とも見えており、**この値を見て
// 「運営可視 false だから隠せる」と読み違える余地が残っていた**(02 §5-9 `E-G54`)。
//
// **ここで直すのは「読取応答に宣言フィールドを出さない」側だけである。** **行の値を判定に使う
// 側(限定3 の解除)には1バイトも手を付けていない** —— そちらは `ADR-0061` §3a-3 が「門A の
// 本審査を新規に行う」と定めた線であり、`V4-M0` の `B-G2` と同じ場所である(04 §3-7 #10)。

// --- 【`V8-M20` / `J-G30` / `ADR-0301`】この節の 3本のうち 2本を消した ------------------
//
// **消した検査(`test()` の逐語)**:
//   - `projectForRead: 運営可視の宣言フィールドを伏せ、他のフィールドは1つも触らない(E-G54)`
//   - `projectForRead: 宣言フィールドを持たない行は、同じ内容の新しい行になる(E-G54)`
//
// **消した理由**: **`projectForRead` は `owner-scope.ts` から撤去された。**
// **この2本が測っていたのは「**書けるが効かない値**(= `st_admin_readable`)を読取応答から
// 落とす」ことであり、`E-G54` の言う「効かない値」は今日1つも存在しない** ——
// **面の規則は「書けるが効かない」を作らない**(規則を書いた対象は実際に効く)。
// **したがって、置き直せる先が無い。**
//
// **【消したことで測らなくなったもの。誇張しない】** **読取応答の射影が「元の行を破壊せず、
// 対象以外のキーを1つも触らない」という性質は、今日は `projectForRoleFields`(面の項目の
// 規則)が担っており、その検査は `src/server/field-audience-projection.test.ts` に在る。**
// **本ファイルからは、その性質を見る検査が1本も無くなった。**
//
// **3本目(`READ_HIDDEN_RESERVED_FIELDS は運営可視の宣言1本だけである(E-G54 / V4-M4-T04)`)は
// 消していない** —— **`READ_HIDDEN_RESERVED_FIELDS` を見る1行だけを落とし、
// 同じ検査に入っていた `ANON_RESERVED_FIELDS` の全量の照合を残した**(下)。

test("ANON_RESERVED_FIELDS は予約規約フィールド4本ちょうどである(V8-M20 / J-G30)", () => {
  // **旧のテスト名**: `READ_HIDDEN_RESERVED_FIELDS は運営可視の宣言1本だけである(E-G54 / V4-M4-T04)`。
  // **旧はこの位置に `expect([...READ_HIDDEN_RESERVED_FIELDS]).toEqual([ADMIN_READABLE_FIELD]);`
  // を持っていた** —— **その export ごと撤去されたので、1行を落として名前を付け替えた。**
  //
  // **`st_no_direct_create` もここには足さない** —— 効く値ではないが(行の値は判定に使わない)、
  // **伏せてよいのは「行の値が判定に一切使われない」ものだけ**という基準に照らすと足せる余地が
  // ある。**足していないのは `ADR-0077` の限定表が求めていないからである**(限定7 が求めたのは
  // `ANON_RESERVED_FIELDS` への追加だけ)。**限定表の外を実装しない。**
  // **匿名に伏せる集合は 4 → 5 本になった**(`ADR-0077` 限定7。`ADR-0061` 限定10 /
  // `ADR-0073` 限定7 と同じ作法)。
  //
  // **【`V8-M20` / `J-G30` / `ADR-0301`】期待値を 5本 → 4本に更新した。**
  // **旧値は逐語で `[OWNER_FIELD, PUBLIC_FIELD, ADMIN_READABLE_FIELD, UNDELETABLE_FIELD,
  // NO_DIRECT_CREATE_FIELD]`(`st_admin_readable` を3番目に含んでいた)。**
  // **【禁止の履行】減ったことを成果として書かない**(`ADR-0301` 限定10)。
  expect([...ANON_RESERVED_FIELDS]).toEqual([
    OWNER_FIELD,
    PUBLIC_FIELD,
    UNDELETABLE_FIELD,
    NO_DIRECT_CREATE_FIELD,
  ]);
});

// --- P5-b: 宣言フィールドが読取応答に出ないこと(E-G54 / V4-M6)—— HTTP 統合 -----------

test("(E-G54 a) owner の読取2経路(一覧・単件)の射影は、版・st_owner・業務項目を1つも触らない", async () => {
  // **旧: `test("(E-G54 a) owner の読取2経路(一覧・単件)に st_admin_readable が1件も出ない")`。**
  // **旧の逐語は `expect(listBody.records[0]).not.toHaveProperty(ADMIN_READABLE_FIELD);` と
  // `expect(record).not.toHaveProperty(ADMIN_READABLE_FIELD);` の2行だった。**
  // **`V8-M20` / `J-G30` がその1本を廃止したので、2行を落とし、この検査に残る性質
  // (射影が版・`st_owner`・業務項目を1ミリも動かさないこと)へ名前を寄せた。**
  // **同じ綴りが今日どう出るかは (V3-M8-T01 g) と (E-G54 b) が測っている。**
  await withAdminApp(async (ctx) => {
    const { cookie: buyer } = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer" });
    const { cookie: owner } = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner" });
    const id = await acreate(ctx, buyer, "orders", { title: "客の注文" });

    const list = await areq(ctx, owner, "GET", AR("orders"));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { records: Record<string, unknown>[] };
    expect(listBody.records).toHaveLength(1);
    // 表示名解決(限定7)も版も1ミリも動いていない。
    expect(listBody.records[0]?.title).toBe("客の注文");
    expect(listBody.records[0]).toHaveProperty(OWNER_FIELD);

    const single = await areq(ctx, owner, "GET", AR("orders", id));
    expect(single.status).toBe(200);
    // **ETag(版)は射影の影響を受けない** —— 受けると CAS が壊れる。
    expect(single.headers.get("etag")).toBeTruthy();
    const { record } = (await single.json()) as { record: Record<string, unknown> };
    expect(record._updated_at).toBe(single.headers.get("etag"));
  });
});

test("(E-G54 b)【V8-M20 の代償】本人(customer)の読取にも出る。書ける事実は変わっていない", async () => {
  // **旧: `test("(E-G54 b) 本人(customer)の読取にも出ない。書ける事実は変わっていない")`。**
  // **旧の逐語は `expect(body.records[0]).not.toHaveProperty(ADMIN_READABLE_FIELD);`。**
  //
  // **反転した理由**: **`E-G54`(`V4-M6`)が塞いだのは「**書けるが効かない値**を読取応答に
  // 残さない」であり、その射影(`projectForRead`)は `V8-M20` が撤去した。**
  // **今日この綴りは「書けて、何も決めない、そして応答に出る」項目である** ——
  // **`E-G54` が読み違えの余地として挙げた形が、そのまま戻ってきている。**
  // **【禁止の履行】塞げていない。塞げていないと書く。**
  await withAdminApp(async (ctx) => {
    const { cookie: buyer } = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "customer" });
    // **値を書くこと自体は今日もできる**(「書けるが効かない」の前半は消えていない)。
    const created = await areq(ctx, buyer, "POST", AR("orders"), {
      title: "自分の注文",
      st_admin_readable: false,
    });
    expect(created.status).toBe(201);

    const list = await areq(ctx, buyer, "GET", AR("orders"));
    const body = (await list.json()) as { records: Record<string, unknown>[] };
    expect(body.records[0]).toHaveProperty("st_admin_readable");
  });
});

test("(E-G54 c) 匿名公開読取は、残る予約規約フィールドを今日どおり伏せる", async () => {
  // **旧: `test("(E-G54 c) 匿名公開読取は着手前と1バイトも変わらない(限定10 を触っていない)")`。**
  // **旧の逐語は先頭に `expect(body.records[0]).not.toHaveProperty(ADMIN_READABLE_FIELD);` を
  // 持っていた。** **`V8-M20` がその1本を廃止したので落とした** ——
  // **「着手前と1バイトも変わらない」はもう書けないので、テスト名も直した**(反転した側は
  // (V3-M8-T01 g) が測っている)。**残る2本は今日も伏せられている。**
  await withAdminApp(async (ctx) => {
    const { cookie: owner } = seedSession(ctx.dataRoot, ADMIN_APP_ID, { role: "owner" });
    await acreate(ctx, owner, "catalog", { title: "公開品", [PUBLIC_FIELD]: true });

    const anon = await areq(ctx, undefined, "GET", AR("catalog"));
    expect(anon.status).toBe(200);
    const body = (await anon.json()) as { records: Record<string, unknown>[] };
    expect(body.records[0]).not.toHaveProperty(PUBLIC_FIELD);
    expect(body.records[0]).not.toHaveProperty(OWNER_FIELD);
  });
});

// =====================================================================================
// **`F-G3`(`V8-M37` / 軸5 / 門外)—— 他人を持ち主にした作成を、黙って上書きせず**拒否**する**
//
// **着手前の実測(`docs/plan/v8/records/v8-m35-prestate-m33.md` §C-7)**: **3形すべて 201。**
// **(7a) 他人の利用者ID → 201(応答は自分のID。警告0文字)/ (7b) 書かない → 201 /
//   (7c) 空文字 → 201。**
//
// **本単位が変えるのは (7a) の1形だけである**(ユーザ決定 `D-V8-96` = 「断る」)。
// **(7b) / (7c) / `null` は1バイトも変えない** —— **閉じすぎない。**
//
// **`null` と空文字を通す根拠は、更新側の既存の述語である** ——
// **`isSharedOwner`(`null` / `undefined` / 空文字を共有センチネルとみなす)を
// `isAllowedOwnerUpdate` がそのまま許しており、作成側の述語も同じ `isAllowedOwnerUpdate` を
// 呼ぶ。** **「共有にする」は詐称ではない、という更新側の読みを作成側でも採る。**
//
// **射程は HTTP の作成の口だけである** —— **MCP(`src/mcp/tools/write.ts`)/ まとめ書込 /
// 受信口は1バイトも触っていない**(ユーザ決定 `D-V8-90`)。
// =====================================================================================

test("(F-G3 P1) 作成側の述語: 他人の id だけを真(詐称)とし、書かない・空文字・null・自分の id は偽", () => {
  const me = "u-me";
  // **書いていない** → 判定の対象外(偽 = 詐称ではない)。
  expect(isOwnerSpoofedOnCreate({ title: "x" }, me)).toBe(false);
  // **空文字 / null / undefined**(共有センチネル)→ 更新側と同じく通す。
  expect(isOwnerSpoofedOnCreate({ [OWNER_FIELD]: "" }, me)).toBe(false);
  expect(isOwnerSpoofedOnCreate({ [OWNER_FIELD]: null }, me)).toBe(false);
  expect(isOwnerSpoofedOnCreate({ [OWNER_FIELD]: undefined }, me)).toBe(false);
  // **自分の id** → 通す(閉じすぎない)。
  expect(isOwnerSpoofedOnCreate({ [OWNER_FIELD]: me }, me)).toBe(false);
  // **他人の id** → 断る(これが本単位の1形)。
  expect(isOwnerSpoofedOnCreate({ [OWNER_FIELD]: "u-other" }, me)).toBe(true);
  expect(isOwnerSpoofedOnCreate({ [OWNER_FIELD]: "someone-else" }, me)).toBe(true);
});

test("(F-G3 P2) 作成側の述語は、更新側の `isAllowedOwnerUpdate` と同じ答えを返す(現在値=自分)", () => {
  const me = "u-me";
  for (const sent of ["", null, me, "u-other"] as unknown[]) {
    expect(isOwnerSpoofedOnCreate({ [OWNER_FIELD]: sent }, me)).toBe(
      !isAllowedOwnerUpdate(sent, me),
    );
  }
});

test("(F-G3 7a) 他人の利用者IDを持ち主にした作成は 403 で断られ、1行も作られない", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const before = await listIds(a.cookie, "notes");
  const res = await req(a.cookie, "POST", R("notes"), { title: "偽装", [OWNER_FIELD]: b.userId });
  expect(res.status).toBe(403);
  expect(await listIds(a.cookie, "notes")).toEqual(before);
});

test("(F-G3 7a') 実在しない利用者IDでも同じく 403(相手が実在するかを1度も見ない)", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const res = await req(a.cookie, "POST", R("notes"), {
    title: "偽装",
    [OWNER_FIELD]: "someone-else",
  });
  expect(res.status).toBe(403);
});

test("(F-G3 7b) 持ち主を1バイトも書かない作成は、今日どおり 201 で本人の行になる", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const created = await create(a.cookie, "notes", { title: "書かない" });
  expect(created.status).toBe(201);
  expect(created.owner).toBe(a.userId);
});

test("(F-G3 7c) 持ち主に空文字を送った作成は、今日どおり 201 で本人の行になる", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const created = await create(a.cookie, "notes", { title: "空文字", [OWNER_FIELD]: "" });
  expect(created.status).toBe(201);
  expect(created.owner).toBe(a.userId);
});

test("(F-G3 7c') 持ち主に null を送った作成も、今日どおり 201 で本人の行になる", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const created = await create(a.cookie, "notes", { title: "null", [OWNER_FIELD]: null });
  expect(created.status).toBe(201);
  expect(created.owner).toBe(a.userId);
});

test("(F-G3 7d) 自分の利用者IDを送った作成は 201(閉じすぎない)", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const created = await create(a.cookie, "notes", { title: "自分", [OWNER_FIELD]: a.userId });
  expect(created.status).toBe(201);
  expect(created.owner).toBe(a.userId);
});

test("(F-G3 文面) 断りの文面に内部の綴りを1文字も出さない", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  const res = await req(a.cookie, "POST", R("notes"), { title: "偽装", [OWNER_FIELD]: b.userId });
  expect(res.status).toBe(403);
  const text = await res.text();
  // **予約規約フィールドの綴り・述語名・審査単位の記号を1文字も出さない。**
  for (const forbidden of ["st_owner", "OWNER_FIELD", "isOwnerSpoofedOnCreate", "F-G3"]) {
    expect(text).not.toContain(forbidden);
  }
  // **相手の利用者IDも出さない**(誰の id を送ったかを応答で確かめられるようにしない)。
  expect(text).not.toContain(b.userId);
});

test("(F-G3 射程) 個人所有でない表は1ミリも変わらない(required / reference / 列なし)", async () => {
  const a = seedSession(dataRoot, APP_ID, { role: "owner", username: "alice" });
  const b = seedSession(dataRoot, APP_ID, { role: "editor", username: "bob" });
  // `reqnotes` は `st_owner` が required=true → 個人所有テーブルではない(素通り)。
  expect(
    (await create(a.cookie, "reqnotes", { title: "必須", [OWNER_FIELD]: b.userId })).status,
  ).toBe(201);
  // `announcements` は `st_owner` を持たない(素通り)。
  expect((await create(a.cookie, "announcements", { title: "お知らせ" })).status).toBe(201);
});

// =====================================================================================
// **`F-G5`(`V8-M37` / 軸5 / 門外)—— 持ち主の表示値が「相手」で変わるのを揃える**
//
// **着手前の実測(`docs/plan/v8/records/v8-m35-prestate-m33.md` §C-5)の逐語**:
// **「見る人がその行の持ち主なら利用者ID、持ち主でないならログイン名で返る。」**
// **原因は `projectOwnerDisplay` の `rowOwner === actorId` の枝である。**
//
// **採った道(審査)**: **道 (i) = その枝を落とし、自分の行も表示名に置き換える。**
// **道 (ii)(`roleCrossesOwner` の引き金を広げる)は採らない** ——
// **`ADR-0061` 限定7(既存経路には掛けない)と正面から当たるためである。**
//
// **doc が名指ししていた退行(運営が自分の行を丸ごと書き戻すと 403)は実測で再現した。**
// **`src/server/` の中だけで、書き戻し1形にだけ効く述語を足して塞いだ** ——
// **`isAllowedOwnerUpdate` は1バイトも触っていない**(`ADR-0079` 限定5)。
// =====================================================================================

test("(F-G5 P1) projectOwnerDisplay: 自分の行も表示名になる(旧: 自分の id は1バイトも触らない)", () => {
  const names = new Map([
    ["u-me", "自分"],
    ["u-other", "他人"],
  ]);
  expect(projectOwnerDisplay({ [OWNER_FIELD]: "u-me" }, names, "u-me")[OWNER_FIELD]).toBe("自分");
  expect(projectOwnerDisplay({ [OWNER_FIELD]: "u-other" }, names, "u-me")[OWNER_FIELD]).toBe(
    "他人",
  );
  // **見る人が誰であっても、同じ行は同じ値で返る**(これが本単位の1本の線である)。
  expect(projectOwnerDisplay({ [OWNER_FIELD]: "u-me" }, names, "u-other")[OWNER_FIELD]).toBe(
    "自分",
  );
});

test("(F-G5 P2) 書き戻しの述語: 現在の持ち主の表示名は通し、他人への付け替えは1つも通さない", () => {
  const back = (next: unknown, current: unknown, display: string | undefined): boolean =>
    judgeOwnerUpdateWithDisplay({ [OWNER_FIELD]: next }, current, () => display);
  // **既存の持ち主の表示名 = 何も変えない書き戻し** → 通す。
  expect(back("運営者", "u-admin", "運営者")).toBe(true);
  // **更新側の既存の答えは1つも動かない。**
  expect(back("u-admin", "u-admin", "運営者")).toBe(true); // 据え置き
  expect(back(null, "u-admin", "運営者")).toBe(true); // 共有化
  expect(back("", "u-admin", "運営者")).toBe(true); // 共有化(空文字)
  // **他人への付け替えは、id でも表示名でも1つも通らない。**
  expect(back("u-buyer", "u-admin", "運営者")).toBe(false);
  expect(back("購入者A", "u-admin", "運営者")).toBe(false);
  // **表示名が解決できないとき(そのユーザが消えている)は、今日どおり付け替え扱い。**
  expect(back("運営者", "u-admin", undefined)).toBe(false);
  // **空文字の表示名で「共有行を私物化」できない**(共有行の現在値は `null`)。
  expect(back("誰か", null, undefined)).toBe(false);
  expect(back(UNRESOLVED_OWNER_DISPLAY, "u-admin", undefined)).toBe(false);
  // **`st_owner` を送っていない更新は判定の対象外。**
  expect(judgeOwnerUpdateWithDisplay({ title: "改" }, "u-admin", () => "運営者")).toBe(true);
});

test("(F-G5 P2b) 表示名で通したときは、保存される値が現在の持ち主の id に戻る", () => {
  const values: Record<string, unknown> = { title: "改", [OWNER_FIELD]: "運営者" };
  expect(judgeOwnerUpdateWithDisplay(values, "u-admin", () => "運営者")).toBe(true);
  // **表示名がそのまま保存されると、次の読取で「不明なユーザ」に化ける。**
  expect(values[OWNER_FIELD]).toBe("u-admin");
  expect(values.title).toBe("改");
  // **据え置き / 共有化で通したときは1バイトも触らない。**
  const asis: Record<string, unknown> = { [OWNER_FIELD]: null };
  expect(judgeOwnerUpdateWithDisplay(asis, "u-admin", () => "運営者")).toBe(true);
  expect(asis[OWNER_FIELD]).toBe(null);
  // **断ったときも1バイトも触らない。**
  const denied: Record<string, unknown> = { [OWNER_FIELD]: "購入者A" };
  expect(judgeOwnerUpdateWithDisplay(denied, "u-admin", () => "運営者")).toBe(false);
  expect(denied[OWNER_FIELD]).toBe("購入者A");
});

test("(F-G5 P3) 書き戻しの述語は、表示名を引く関数を必要なときにしか呼ばない", () => {
  let calls = 0;
  const display = (): string | undefined => {
    calls += 1;
    return "運営者";
  };
  // 据え置き / 共有化は、更新側の既存の述語だけで答えが出る。
  expect(judgeOwnerUpdateWithDisplay({ [OWNER_FIELD]: "u-admin" }, "u-admin", display)).toBe(true);
  expect(judgeOwnerUpdateWithDisplay({ [OWNER_FIELD]: null }, "u-admin", display)).toBe(true);
  expect(judgeOwnerUpdateWithDisplay({ title: "改" }, "u-admin", display)).toBe(true);
  expect(calls).toBe(0);
  // 答えが出ないときだけ引く。
  expect(judgeOwnerUpdateWithDisplay({ [OWNER_FIELD]: "運営者" }, "u-admin", display)).toBe(true);
  expect(calls).toBe(1);
});

test("(F-G5 h1) 運営が読む一覧は、自分の行も他人の行も同じ形(表示名)で返る", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });
    await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });

    const listed = await alistBody(ctx, admin.cookie, "orders");
    expect(listed.records.map((r) => r[OWNER_FIELD]).sort()).toEqual(["購入者A", "運営者"].sort());
    // **生の不透明 id は、自分のぶんも含めて本文に1文字も現れない。**
    expect(listed.text).not.toContain(buyer.userId);
    expect(listed.text).not.toContain(admin.userId);
  });
});

test("(F-G5 h2) 運営は自分の行を、読んだ内容のまま書き戻せる(表示名になっても 403 にしない)", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });

    const got = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(got.status).toBe(200);
    const etag = got.headers.get("etag") as string;
    const record = ((await got.json()) as { record: Record<string, unknown> }).record;
    expect(record[OWNER_FIELD]).toBe("運営者");
    const body: Record<string, unknown> = { ...record };
    for (const key of ["_id", "_created_at", "_updated_at"]) {
      delete body[key];
    }
    const patched = await areq(ctx, admin.cookie, "PATCH", AR("orders", own), body, etag);
    expect(patched.status).toBe(200);
    // **持ち主は1バイトも動いていない**(表示名を書き戻しても中身は元の id のまま)。
    const after = await areq(ctx, admin.cookie, "GET", AR("orders", own));
    expect(((await after.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      "運営者",
    );
  });
});

test("(F-G5 h3) 書き戻しの穴で他人へ付け替えられない —— 他人の表示名も他人の id も 403", async () => {
  await withAdminApp(async (ctx) => {
    const admin = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "admin",
      displayName: "運営者",
      role: "owner",
    });
    const buyer = seedNamedSession(ctx.dataRoot, ADMIN_APP_ID, {
      username: "buyer",
      displayName: "購入者A",
      role: "editor",
    });
    const own = await acreate(ctx, admin.cookie, "orders", { title: "運営自身の注文" });

    // **他人の表示名で付け替えようとする**(本単位が開けた形の、いちばん近い誤用)。
    const byName = await areq(
      ctx,
      admin.cookie,
      "PATCH",
      AR("orders", own),
      { [OWNER_FIELD]: "購入者A" },
      await aversion(ctx, admin.cookie, "orders", own),
    );
    expect(byName.status).toBe(403);
    // **他人の生 id でも今日どおり 403。**
    const byId = await areq(
      ctx,
      admin.cookie,
      "PATCH",
      AR("orders", own),
      { [OWNER_FIELD]: buyer.userId },
      await aversion(ctx, admin.cookie, "orders", own),
    );
    expect(byId.status).toBe(403);
    // **自分の表示名を、他人の行へ書き込むこともできない**(逆向きの付け替え)。
    // **【実測。応答は 403 ではなく 404 である】** —— **他人の行への `PATCH` は、
    // 付け替えの判定より**前**に立つ可視性の関門で 404 になる**(存在を伏せる。
    // `v7-m0.md` §5-4 (vi) の関門順序)。**本単位はその順序を1バイトも動かしていない。**
    const theirs = await acreate(ctx, buyer.cookie, "orders", { title: "購入者の注文" });
    const onTheirs = await areq(
      ctx,
      admin.cookie,
      "PATCH",
      AR("orders", theirs),
      { [OWNER_FIELD]: "運営者" },
      await aversion(ctx, buyer.cookie, "orders", theirs),
    );
    expect(onTheirs.status).toBe(404);
    // **行の持ち主は1バイトも動いていない。**
    const still = await areq(ctx, buyer.cookie, "GET", AR("orders", theirs));
    expect(((await still.json()) as { record: Record<string, unknown> }).record[OWNER_FIELD]).toBe(
      "購入者A",
    );
  });
});
