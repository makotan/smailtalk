/**
 * **子の表に行を作れる権限の語彙と、適用時の拒否 —— `access_control.permissions[].create_child`**
 * (`V23-M7-T01`。門A = `ADR-0503`(`SC-G22`)を補う `ADR-0542` §Decision 1-1。
 * 決定 `D-V23-182`・`D-V23-191`、計画 §26-6 中6。授権 `ADR-0543`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **設計図の形** —— 権限の要素の7キー目に `create_child`(子の表 ID の配列。`minItems` 1・`uniqueItems`・
 *    要素は `$ref: #/$defs/resource_id`)。 `required` に入れない。 **新しい `$defs` は作らない。**
 * 2. **適用時の拒否5形**(1つずつ) —— 子の表が実在しない / 子の表の `inherit_from` のどれもこの表を指さない /
 *    子の表が付与表・名簿表・グループ表 / `restrictive: true` の要素に書いた / この表自身を書いた。
 * 3. **後から来る差分の拒否**(差分の経路 `applyDiff`) —— 子の表を消す / 子の親の参照の項目を消す /
 *    子の `inherit_from` から外す / 別の宣言が子の表をグループ表として指す / 要素に `restrictive: true` を足す。
 *    **断られたとき定義は1バイトも動かない。** 文面は「先に create_child から外す」ことを伝える。
 * 4. **陰性対照** —— `create_child` を書かない定義は今日どおり通る。
 *
 * **測らないもの(誇張しない)**: 関門の判定(`T03`)。 作成者付与(`T04`)。 付け替え(`T05`)。 画面(`T05b`)。
 * 生成器(`T06`)。 要件書の文(`T07`)。 説明書の件数の文は既存の見張り(`skill-vocabulary-drift`)が見る。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Manifest } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const DEFS = "$defs";
const M = (manifestSchema as unknown as Any)[DEFS] as Any;
const D = (diffSchema as unknown as Any)[DEFS] as Any;

const APP_ID = "cc-vocab";
/** 組織の表(`tables/1`)の権限 `assessor`(`permissions/1`)の `create_child`。 */
const CC = "/app/tables/1/access_control/permissions/1/create_child";
const HINT_MARK = "create_child から子の表を外して";

const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

/** 組織の表の権限。 `assessor` に `createChild` を置く(`undefined` なら書かない)。 */
function orgPermissions(createChild?: unknown, extra: Any = {}): Any[] {
  return [
    { id: "org_admin", name: "管理", read: true, write: true, delete: true },
    {
      id: "assessor",
      name: "評価者",
      read: true,
      write: false,
      delete: false,
      ...extra,
      ...(createChild === undefined ? {} : { create_child: createChild }),
    },
    { id: "org_viewer", name: "閲覧", read: true, write: false, delete: false },
  ];
}

function orgsAccessControl(createChild?: unknown, extra: Any = {}): Any {
  return {
    enabled: true,
    permissions: orgPermissions(createChild, extra),
    creator_permission: "org_admin",
    grant: { table: "org_grants", target: "org", member: "member", permission: "permission" },
    members: { table: "members", account: "account" },
  };
}

function noticesAccessControl(options: { inheritFrom?: string[] | null } = {}): Any {
  return {
    enabled: true,
    permissions: [
      { id: "author", name: "書いた人", read: true, write: true, delete: true },
      { id: "notice_reader", name: "読む人", read: true, write: false, delete: false },
    ],
    creator_permission: "author",
    grant: {
      table: "notice_grants",
      target: "notice",
      member: "member",
      permission: "permission",
    },
    members: { table: "members", account: "account" },
    ...(options.inheritFrom === null ? {} : { inherit_from: options.inheritFrom ?? ["org"] }),
  };
}

type Options = {
  orgs?: Any;
  notices?: Any;
  extraTables?: Any[];
};

function manifestWith(options: Options = {}): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "子の表に行を作れる権限",
      tables: [
        {
          id: "members",
          name: "名簿",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "account", name: "アカウント", type: "text" },
          ],
        },
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: options.orgs ?? orgsAccessControl(["org_notices"]),
        },
        {
          id: "org_grants",
          name: "組織の付与",
          fields: [
            ref("org", "orgs"),
            ref("member", "members"),
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["org_admin", "assessor", "org_viewer"],
            },
          ],
        },
        {
          id: "org_notices",
          name: "告知",
          fields: [{ id: "title", name: "件名", type: "text" }, ref("org", "orgs")],
          access_control: options.notices ?? noticesAccessControl(),
        },
        {
          id: "notice_grants",
          name: "告知の付与",
          fields: [
            ref("notice", "org_notices"),
            ref("member", "members"),
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["author", "notice_reader"],
            },
          ],
        },
        { id: "logs", name: "記録", fields: [{ id: "body", name: "本文", type: "text" }] },
        {
          id: "teams",
          name: "班",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        ...(options.extraTables ?? []),
      ],
      views: [{ id: "org-list", type: "list_view", table: "orgs", columns: ["title"] }],
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

function errorsOf(result: { valid: boolean; errors?: ValidationError[] }): ValidationError[] {
  return result.valid ? [] : (result.errors ?? []);
}

/** 罠の汎用文(英語の既定文・`anyOf` の言い訳)と内部記号を1つも含まないこと。 */
function expectPlainJapanese(errors: ValidationError[]): void {
  const text = JSON.stringify(errors);
  expect(text).not.toContain("must ");
  expect(text).not.toContain("anyOf");
  expect(text).not.toContain("詳細不明");
  expect(text).not.toMatch(/ADR-|D-V\d|V\d+-M\d|SC-G/);
}

/** `path` ちょうどの誤りを1つ取り出す(無ければ全体を見せて落ちる)。 */
function hitAt(result: { valid: boolean; errors?: ValidationError[] }, path: string) {
  expect(result.valid).toBe(false);
  const hit = errorsOf(result).find((error) => error.path === path);
  expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
  expectPlainJapanese(hit === undefined ? [] : [hit]);
  return hit as ValidationError;
}

function permissionItemDef(): Any {
  const ac = ((M.table as Any).properties as Any).access_control as Any;
  return (((ac.properties as Any).permissions as Any).items ?? {}) as Any;
}

// ---------------------------------------------------------------------------------------
// (S) 設計図の形
// ---------------------------------------------------------------------------------------

describe("(S) 設計図の形", () => {
  test("(S-1) 権限の要素の7キー目に create_child。必須は今日の5つのまま", () => {
    const def = permissionItemDef();
    expect(Object.keys((def.properties ?? {}) as Any)).toEqual([
      "id",
      "name",
      "read",
      "write",
      "delete",
      "restrictive",
      "create_child",
    ]);
    expect(def.required).toEqual(["id", "name", "read", "write", "delete"]);
    expect(def.additionalProperties).toBe(false);
  });

  test("(S-2) create_child は表 ID の配列(1つ以上・重複なし・要素は resource_id)", () => {
    const def = ((permissionItemDef().properties ?? {}) as Any).create_child as Any;
    expect(def?.type).toBe("array");
    expect(def?.minItems).toBe(1);
    expect(def?.uniqueItems).toBe(true);
    expect((def?.items as Any)?.$ref).toBe("#/$defs/resource_id");
  });

  test("(S-3) $defs の名前は増えていない(manifest 31・diff 5)", () => {
    expect(Object.keys(M).length).toBe(31);
    expect(Object.keys(D).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------
// (A) 受け入れ
// ---------------------------------------------------------------------------------------

describe("(A) 受け入れ", () => {
  test("(A-1) 子の表(inherit_from がこの表を指す)を書いた create_child は通る", () => {
    const result = validateManifestFull(manifestWith());
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("(A-2) change_table の access_control でも create_child を書ける(差分の設計図)", () => {
    const result = validateDiff({
      diff_id: "cc-a2",
      intent: "評価者が告知を作れるようにする",
      operations: [
        {
          op: "change_table",
          table: "orgs",
          changes: { access_control: orgsAccessControl(["org_notices"]) },
        },
      ],
    });
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test.each([
    ["空の配列", []],
    ["文字列", "org_notices"],
    ["要素が数", [1]],
    ["要素が ID の形でない", ["Org Notices"]],
  ])("(A-3) %s は設計図で断られる(create_child の中を指す)", (_label, createChild) => {
    const result = validateManifestFull(manifestWith({ orgs: orgsAccessControl(createChild) }));
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expect(
      errors.some((error) => error.path.startsWith(CC)),
      JSON.stringify(errors),
    ).toBe(true);
  });

  test("(A-4) 重複は英語の既定文に落ちない", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsAccessControl(["org_notices", "org_notices"]) }),
    );
    expect(result.valid).toBe(false);
    const errors = errorsOf(result).filter((error) => error.path.startsWith(CC));
    expect(errors.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectPlainJapanese(errors);
  });
});

// ---------------------------------------------------------------------------------------
// (R) 適用時の拒否(5形を1つずつ)
// ---------------------------------------------------------------------------------------

describe("(R) 適用時の拒否", () => {
  test("(R-1) 子の表が実在しないと断る", () => {
    const hit = hitAt(
      validateManifestFull(manifestWith({ orgs: orgsAccessControl(["no_such"]) })),
      `${CC}/0`,
    );
    expect(hit.message).toContain('"no_such"');
    expect(hit.hint ?? "").toContain(HINT_MARK);
  });

  test("(R-2) 子の表の inherit_from がこの表を指さないと断る(宣言の無い表・inherit_from の無い表)", () => {
    const withoutAccess = hitAt(
      validateManifestFull(manifestWith({ orgs: orgsAccessControl(["logs"]) })),
      `${CC}/0`,
    );
    expect(withoutAccess.message).toContain('"logs"');
    expect(withoutAccess.message).toContain("inherit_from");
    const withoutInherit = hitAt(
      validateManifestFull(manifestWith({ notices: noticesAccessControl({ inheritFrom: null }) })),
      `${CC}/0`,
    );
    expect(withoutInherit.message).toContain('"org_notices"');
    expect(withoutInherit.message).toContain("inherit_from");
  });

  test("(R-3) 子の表が付与表・名簿表・グループ表だと断る", () => {
    for (const special of ["org_grants", "members"]) {
      const result = validateManifestFull(manifestWith({ orgs: orgsAccessControl([special]) }));
      expect(result.valid).toBe(false);
      const hits = errorsOf(result).filter(
        (error) => error.path === `${CC}/0` && error.message.includes("付与・名簿・グループ"),
      );
      expect(hits.length, `${special}: ${JSON.stringify(errorsOf(result))}`).toBe(1);
      expectPlainJapanese(hits);
    }
    const asGroup = validateManifestFull(
      manifestWith({
        orgs: { ...orgsAccessControl(["org_notices"]), groups: { table: "org_notices" } },
      }),
    );
    const groupHits = errorsOf(asGroup).filter(
      (error) => error.path === `${CC}/0` && error.message.includes("付与・名簿・グループ"),
    );
    expect(groupHits.length, JSON.stringify(errorsOf(asGroup))).toBe(1);
  });

  test("(R-4) restrictive: true の要素に create_child を書くと断る", () => {
    const hit = hitAt(
      validateManifestFull(
        manifestWith({ orgs: orgsAccessControl(["org_notices"], { restrictive: true }) }),
      ),
      CC,
    );
    expect(hit.message).toContain("restrictive");
    expect(hit.hint ?? "").toContain(HINT_MARK);
  });

  test("(R-5) 要素にこの表自身を書くと断る", () => {
    const hit = hitAt(
      validateManifestFull(manifestWith({ orgs: orgsAccessControl(["orgs"]) })),
      `${CC}/0`,
    );
    expect(hit.message).toContain('"orgs"');
    expect(hit.message).toContain("自身");
  });
});

// ---------------------------------------------------------------------------------------
// (N) 陰性対照: create_child を書かない定義
// ---------------------------------------------------------------------------------------

describe("(N) 陰性対照", () => {
  test("(N-1) create_child を書かない定義は今日どおり通る", () => {
    const result = validateManifestFull(manifestWith({ orgs: orgsAccessControl() }));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("(N-2) create_child を書かなければ、告知の表に inherit_from が無くても・restrictive があっても通る", () => {
    for (const options of [
      { orgs: orgsAccessControl(), notices: noticesAccessControl({ inheritFrom: null }) },
      { orgs: orgsAccessControl(undefined, { restrictive: true }) },
    ]) {
      const result = validateManifestFull(manifestWith(options));
      expect(errorsOf(result), JSON.stringify(options)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------
// (G) 宣言のあるアプリに後から来る差分
// ---------------------------------------------------------------------------------------

function diffOf(operations: unknown[], diffId: string): unknown {
  return { diff_id: diffId, intent: "子の表に行を作れる権限", operations };
}

async function freshApp(initial: Manifest): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-create-child-vocab-"));
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, "子の表に行を作れる権限", { app_id: APP_ID });
  store.close();
  const applied = applyManifest(dataRoot, APP_ID, initial);
  if (!applied.valid) {
    throw new Error(`テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied)}`);
  }
  return dataRoot;
}

describe("(G) 宣言のあるアプリに後から来る差分", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await freshApp(manifestWith());
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  function current(): string {
    return JSON.stringify(readCurrentManifest(dataRoot, APP_ID));
  }

  /** 断られ、定義が動かず、create_child の位置に「先に外す」の文面が出ること。 */
  function refusedAtCreateChild(operations: unknown[], diffId: string, path: string): void {
    const before = current();
    const result = applyDiff(dataRoot, APP_ID, diffOf(operations, diffId));
    expect(result.valid).toBe(false);
    expect(current()).toBe(before);
    const hits = errorsOf(result).filter((error) => error.path === path);
    expect(hits.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectPlainJapanese(hits);
    expect(hits.some((error) => (error.hint ?? "").includes(HINT_MARK))).toBe(true);
  }

  test("(G-1) 子の表を消す差分は断られる", () => {
    refusedAtCreateChild(
      [
        { op: "remove_table", table: "notice_grants" },
        { op: "remove_table", table: "org_notices" },
      ],
      "cc-g1",
      `${CC}/0`,
    );
  });

  test("(G-2) 子の親の参照の項目を消す差分は断られる", () => {
    refusedAtCreateChild(
      [{ op: "remove_field", table: "org_notices", field: "org" }],
      "cc-g2",
      `${CC}/0`,
    );
  });

  test("(G-3) 子の inherit_from から外す差分は断られる", () => {
    refusedAtCreateChild(
      [
        {
          op: "change_table",
          table: "org_notices",
          changes: { access_control: noticesAccessControl({ inheritFrom: null }) },
        },
      ],
      "cc-g3",
      `${CC}/0`,
    );
  });

  test("(G-4) 別の宣言が後から子の表をグループ表として指す差分は断られる", () => {
    refusedAtCreateChild(
      [
        {
          op: "change_table",
          table: "orgs",
          changes: {
            access_control: {
              ...orgsAccessControl(["org_notices"]),
              groups: { table: "org_notices" },
            },
          },
        },
      ],
      "cc-g4",
      `${CC}/0`,
    );
  });

  test("(G-5) 要素に restrictive: true を足す差分は断られる", () => {
    refusedAtCreateChild(
      [
        {
          op: "change_table",
          table: "orgs",
          changes: { access_control: orgsAccessControl(["org_notices"], { restrictive: true }) },
        },
      ],
      "cc-g5",
      CC,
    );
  });

  test("(G-6 陰性対照) create_child から先に外せば、同じ子の表の inherit_from を外す差分は通る", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      diffOf(
        [
          { op: "change_table", table: "orgs", changes: { access_control: orgsAccessControl() } },
          {
            op: "change_table",
            table: "org_notices",
            changes: { access_control: noticesAccessControl({ inheritFrom: null }) },
          },
        ],
        "cc-g6",
      ),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
