/**
 * **行を相手にした付与の語彙と、適用時の拒否 —— `access_control.grant.principal_row`**
 * (`V23-M6-T01`。門A = `ADR-0502`(`SC-G20`)を補う `ADR-0538` §Decision 1-1。
 * 決定 `D-V23-149`・`D-V23-162`・`D-V23-172`・`D-V23-173`。授権 `ADR-0539`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **設計図の形** —— `grant` の6キー目に `principal_row = { column, table, via }`。 中は3キーで閉じ、
 *    3つとも必須。 `via` は1つ以上の配列。 **新しい `$defs` は作らない。**
 * 2. **適用時の拒否**(`D-V23-149` の8つを1つずつ。`referential-integrity.ts` が畳み込んだ後の定義に対して見る。
 *    `via` が空はスキーマで断る) —— `column` が reference でない / `column` が `table` を指さない /
 *    `table` に `access_control`(enabled)が無い / `table` が守る表そのもの / `via` が空 /
 *    `via` に `table` の権限に無い名前 / `table` の名簿が守る表の名簿と違う / `table` 側の `grant` にも `principal_row`。
 * 3. **後から来る差分の拒否**(`D-V23-162`。差分の経路 `applyDiff`) —— 付与表の相手の列に値のある行が残っているのに
 *    `principal_row` を宣言する(読取専用で DB を見る。自動登録の重複の検査と同じ置き場)/ `principal_row` が指す列を
 *    `remove_field` で消す / 指される表の `access_control` を外す・名簿の表を替える・その付与に `principal_row` を足す。
 *    **断られたとき定義は1バイトも動かない。**
 * 4. **陰性対照** —— `principal_row` を書かない定義・差分は今日どおり通る(値の残る列があっても、列を消しても)。
 *
 * **測らないもの(誇張しない)**: 読取の解決(`T03`)。 付与の書込の断り(`T04`)。 コードとコードの招待(`T05`・`T06`)。
 * 画面(`T06b`)。 生成器(`T09`)。 説明書・要件書の文(説明書の件数の文は既存の見張りが見る)。
 */

import { Database } from "bun:sqlite";
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
import { createRecord } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Manifest } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const DEFS = "$defs";
const M = (manifestSchema as unknown as Any)[DEFS] as Any;
const D = (diffSchema as unknown as Any)[DEFS] as Any;

const APP_ID = "scs";
const PR = "/app/tables/0/access_control/grant/principal_row";

function roles(): Any[] {
  return [
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
    { id: "member", name: "会員" },
  ];
}

/** 守る表(組織)の宣言。 `principalRow` を渡せば `grant` の6キー目に置く。 */
function orgsAccessControl(options: { principalRow?: unknown } = {}): Any {
  return {
    enabled: true,
    permissions: [
      { id: "admin", name: "管理", read: true, write: true, delete: true },
      { id: "reader", name: "参照", read: true, write: false, delete: false },
    ],
    creator_permission: "admin",
    grant: {
      table: "org_grant",
      target: "org",
      member: "member",
      permission: "permission",
      ...(options.principalRow === undefined ? {} : { principal_row: options.principalRow }),
    },
    members: { table: "members", account: "account" },
  };
}

/** 相手の行の表(評価機関)の宣言。 */
function evaluatorsAccessControl(
  options: { enabled?: boolean; membersTable?: string; principalRow?: unknown } = {},
): Any {
  return {
    enabled: options.enabled ?? true,
    permissions: [
      { id: "manager", name: "管理", read: true, write: true, delete: true },
      { id: "staff", name: "所属", read: true, write: false, delete: false },
    ],
    creator_permission: "manager",
    grant: {
      table: "ev_grant",
      target: "ev",
      // 名簿を替えた形では、相手の列も替えた名簿を指す列にする(名簿の食い違いの拒否を混ぜない)。
      member: options.membersTable === undefined ? "member" : "expert_member",
      permission: "permission",
      ...(options.principalRow === undefined ? {} : { principal_row: options.principalRow }),
    },
    members: { table: options.membersTable ?? "members", account: "account" },
  };
}

function goodPrincipalRow(): Any {
  return { column: "evaluator", table: "evaluators", via: ["staff"] };
}

type Options = {
  orgs?: Any;
  /** `null` で評価機関の表から `access_control` を外す。 */
  evaluators?: Any | null;
  orgGrantFields?: Any[];
  evGrantFields?: Any[];
};

function manifestWith(options: Options = {}): Manifest {
  const evaluatorsAc =
    options.evaluators === undefined ? evaluatorsAccessControl() : options.evaluators;
  return {
    app: {
      id: APP_ID,
      name: "評価",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: options.orgs ?? orgsAccessControl({ principalRow: goodPrincipalRow() }),
        },
        {
          id: "org_grant",
          name: "組織の付与",
          fields: options.orgGrantFields ?? [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "利用者", type: "reference", reference_table: "members" },
            {
              id: "evaluator",
              name: "評価機関",
              type: "reference",
              reference_table: "evaluators",
            },
            { id: "permission", name: "権限", type: "select", options: ["admin", "reader"] },
          ],
        },
        {
          id: "evaluators",
          name: "評価機関",
          fields: [{ id: "title", name: "名前", type: "text" }],
          ...(evaluatorsAc === null ? {} : { access_control: evaluatorsAc }),
        },
        {
          id: "ev_grant",
          name: "評価機関の付与",
          fields: options.evGrantFields ?? [
            { id: "ev", name: "評価機関", type: "reference", reference_table: "evaluators" },
            { id: "member", name: "利用者", type: "reference", reference_table: "members" },
            {
              id: "expert_member",
              name: "専門家",
              type: "reference",
              reference_table: "experts",
            },
            { id: "org_ref", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "permission", name: "権限", type: "select", options: ["manager", "staff"] },
          ],
        },
        {
          id: "members",
          name: "名簿",
          fields: [{ id: "account", name: "アカウント", type: "text" }],
        },
        {
          id: "experts",
          name: "専門家の名簿",
          fields: [{ id: "account", name: "アカウント", type: "text" }],
        },
      ],
      views: [{ id: "org-list", type: "list_view", table: "orgs", columns: ["title"] }],
      roles: roles(),
    },
  } as unknown as Manifest;
}

function withPrincipalRow(principalRow: unknown, extra: Omit<Options, "orgs"> = {}): Manifest {
  return manifestWith({ ...extra, orgs: orgsAccessControl({ principalRow }) });
}

function errorsOf(result: { valid: boolean; errors?: ValidationError[] }): ValidationError[] {
  return result.valid ? [] : (result.errors ?? []);
}

function grantDef(): Any {
  const ac = ((M.table as Any).properties as Any).access_control as Any;
  return ((ac.properties as Any).grant ?? {}) as Any;
}

function principalRowDef(): Any {
  return (((grantDef().properties ?? {}) as Any).principal_row ?? {}) as Any;
}

/** 罠の汎用文(識別子の規約の汎用 hint・英語の既定文・`anyOf` の言い訳)と内部記号を1つも含まないこと。 */
function expectPlainJapanese(errors: ValidationError[]): void {
  const text = JSON.stringify(errors);
  expect(text).not.toContain("book-tracker");
  expect(text).not.toContain("識別子の規約に合いません");
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

// ---------------------------------------------------------------------------------------
// (S) 設計図の形
// ---------------------------------------------------------------------------------------

describe("(S) 設計図の形", () => {
  test("(S-1) grant の6キー目に principal_row。必須は今日の3つのまま", () => {
    const def = grantDef();
    expect(Object.keys((def.properties ?? {}) as Any)).toEqual([
      "table",
      "target",
      "member",
      "group",
      "permission",
      "principal_row",
    ]);
    expect(def.required).toEqual(["table", "target", "permission"]);
    expect(def.additionalProperties).toBe(false);
  });

  test("(S-2) principal_row は column / table / via の3キーで閉じ、3つとも必須。via は1つ以上の配列", () => {
    const def = principalRowDef();
    expect(def.type).toBe("object");
    expect(Object.keys((def.properties ?? {}) as Any)).toEqual(["column", "table", "via"]);
    expect(def.required).toEqual(["column", "table", "via"]);
    expect(def.additionalProperties).toBe(false);
    const via = ((def.properties ?? {}) as Any).via as Any;
    expect(via?.type).toBe("array");
    expect(via?.minItems).toBe(1);
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
  test("(A-1) 3キーをそろえた principal_row は通る", () => {
    const result = validateManifestFull(withPrincipalRow(goodPrincipalRow()));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("(A-2) via を2つ書いても通る", () => {
    const result = validateManifestFull(
      withPrincipalRow({ column: "evaluator", table: "evaluators", via: ["staff", "manager"] }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("(A-3) change_table の access_control でも principal_row を書ける(差分の設計図)", () => {
    const result = validateDiff({
      diff_id: "pr-a3",
      intent: "評価機関を相手にした付与を宣言する",
      operations: [
        {
          op: "change_table",
          table: "orgs",
          changes: { access_control: orgsAccessControl({ principalRow: goodPrincipalRow() }) },
        },
      ],
    });
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test.each([
    ["column が無い", { table: "evaluators", via: ["staff"] }],
    ["table が無い", { column: "evaluator", via: ["staff"] }],
    ["via が無い", { column: "evaluator", table: "evaluators" }],
    ["4キー目", { ...goodPrincipalRow(), depth: 2 }],
    ["via が文字列", { column: "evaluator", table: "evaluators", via: "staff" }],
    ["principal_row が文字列", "evaluators"],
  ])("(A-4) %s は設計図で断られる(principal_row の中を指す)", (_label, principalRow) => {
    const result = validateManifestFull(withPrincipalRow(principalRow));
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expect(
      errors.some((error) => error.path.startsWith(PR)),
      JSON.stringify(errors),
    ).toBe(true);
    expectPlainJapanese(errors.filter((error) => error.path.startsWith(PR)));
  });

  test("(A-5) 4キー目は allowed_values に3キーを示して断る", () => {
    const hit = hitAt(
      validateManifestFull(withPrincipalRow({ ...goodPrincipalRow(), depth: 2 })),
      PR,
    );
    expect(hit.message).toContain('"depth"');
    expect(hit.allowed_values).toEqual(["column", "table", "via"]);
  });
});

// ---------------------------------------------------------------------------------------
// (T) 文面が罠の汎用文にならない
// ---------------------------------------------------------------------------------------

describe("(T) 文面", () => {
  test("(T-1) via の要素が権限名の形に合わないと、権限名の書き方を言う(識別子の汎用 hint に落ちない)", () => {
    const result = validateManifestFull(
      withPrincipalRow({ column: "evaluator", table: "evaluators", via: ["Staff-1"] }),
    );
    expect(result.valid).toBe(false);
    const errors = errorsOf(result).filter((error) => error.path === `${PR}/via/0`);
    expect(errors.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectPlainJapanese(errors);
    const text = JSON.stringify(errors);
    expect(text).toContain("アンダースコア");
    expect(text).toContain("32");
  });

  test("(T-2) via の重複は英語の既定文に落ちない", () => {
    const result = validateManifestFull(
      withPrincipalRow({ column: "evaluator", table: "evaluators", via: ["staff", "staff"] }),
    );
    expect(result.valid).toBe(false);
    const errors = errorsOf(result).filter((error) => error.path.startsWith(`${PR}/via`));
    expect(errors.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectPlainJapanese(errors);
  });
});

// ---------------------------------------------------------------------------------------
// (R) 適用時の拒否(D-V23-149 の8つを1つずつ)
// ---------------------------------------------------------------------------------------

describe("(R) 適用時の拒否", () => {
  test("(R-1) column が付与表の reference 項目でないと断る", () => {
    const result = validateManifestFull(
      withPrincipalRow(goodPrincipalRow(), {
        orgGrantFields: [
          { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
          { id: "member", name: "利用者", type: "reference", reference_table: "members" },
          { id: "evaluator", name: "評価機関", type: "text" },
          { id: "permission", name: "権限", type: "select", options: ["admin", "reader"] },
        ],
      }),
    );
    const hit = hitAt(result, `${PR}/column`);
    expect(hit.message).toContain('"evaluator"');
  });

  test("(R-2) column が table を指していないと断る", () => {
    const result = validateManifestFull(
      withPrincipalRow(goodPrincipalRow(), {
        orgGrantFields: [
          { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
          { id: "member", name: "利用者", type: "reference", reference_table: "members" },
          { id: "evaluator", name: "評価機関", type: "reference", reference_table: "experts" },
          { id: "permission", name: "権限", type: "select", options: ["admin", "reader"] },
        ],
      }),
    );
    const hit = hitAt(result, `${PR}/column`);
    expect(hit.message).toContain('"evaluators"');
  });

  test("(R-3) table に access_control が無いと断る(enabled: false も同じ)", () => {
    for (const evaluators of [null, evaluatorsAccessControl({ enabled: false })]) {
      const result = validateManifestFull(withPrincipalRow(goodPrincipalRow(), { evaluators }));
      const hit = hitAt(result, `${PR}/table`);
      expect(hit.message).toContain('"evaluators"');
      expect(`${hit.message}${hit.hint ?? ""}`).toContain("access_control");
    }
  });

  test("(R-4) table が守る表そのものだと断る", () => {
    const result = validateManifestFull(
      withPrincipalRow(
        { column: "evaluator", table: "orgs", via: ["reader"] },
        {
          orgGrantFields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "利用者", type: "reference", reference_table: "members" },
            { id: "evaluator", name: "相手の組織", type: "reference", reference_table: "orgs" },
            { id: "permission", name: "権限", type: "select", options: ["admin", "reader"] },
          ],
        },
      ),
    );
    const hit = hitAt(result, `${PR}/table`);
    expect(hit.message).toContain("この表そのもの");
  });

  test("(R-5) via が空だと断る(設計図の段で、via を指す)", () => {
    const result = validateManifestFull(
      withPrincipalRow({ column: "evaluator", table: "evaluators", via: [] }),
    );
    expect(result.valid).toBe(false);
    const errors = errorsOf(result).filter((error) => error.path.startsWith(`${PR}/via`));
    expect(errors.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectPlainJapanese(errors);
  });

  test("(R-6) via に table の権限に無い名前があると断り、相手の表の権限を allowed_values に示す", () => {
    const result = validateManifestFull(
      withPrincipalRow({ column: "evaluator", table: "evaluators", via: ["staff", "admin"] }),
    );
    const hit = hitAt(result, `${PR}/via/1`);
    expect(hit.message).toContain('"admin"');
    expect(hit.allowed_values).toEqual(["manager", "staff"]);
  });

  test("(R-7) table の名簿(members.table)が守る表の名簿と違うと断る", () => {
    const result = validateManifestFull(
      withPrincipalRow(goodPrincipalRow(), {
        evaluators: evaluatorsAccessControl({ membersTable: "experts" }),
      }),
    );
    const hit = hitAt(result, `${PR}/table`);
    expect(hit.message).toContain("名簿");
  });

  test("(R-8) table 側の grant にも principal_row があると断る(たどれるのは1段)", () => {
    const result = validateManifestFull(
      withPrincipalRow(goodPrincipalRow(), {
        evaluators: evaluatorsAccessControl({
          principalRow: { column: "org_ref", table: "orgs", via: ["reader"] },
        }),
      }),
    );
    const hit = hitAt(result, `${PR}/table`);
    expect(hit.message).toContain("1段");
  });
});

// ---------------------------------------------------------------------------------------
// (N) 陰性対照: principal_row を書かない定義
// ---------------------------------------------------------------------------------------

describe("(N) 陰性対照", () => {
  test("(N-1) principal_row を書かない定義は今日どおり通る(相手の列にあたる reference があっても)", () => {
    const result = validateManifestFull(manifestWith({ orgs: orgsAccessControl() }));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("(N-2) principal_row を書かなければ、評価機関の表に access_control が無くても・名簿が違っても通る", () => {
    for (const evaluators of [null, evaluatorsAccessControl({ membersTable: "experts" })]) {
      const result = validateManifestFull(manifestWith({ orgs: orgsAccessControl(), evaluators }));
      expect(errorsOf(result), JSON.stringify(evaluators)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------
// (F) 差分の経路(D-V23-162 の適用時の拒否)
// ---------------------------------------------------------------------------------------

function diffOf(operations: unknown[], diffId: string): unknown {
  return { diff_id: diffId, intent: "行を相手にした付与", operations };
}

async function freshApp(initial: Manifest): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "gp-principal-row-vocab-"));
  const store = KernelMetaStore.open(dataRoot);
  createApp(store, "評価", { app_id: APP_ID });
  store.close();
  const applied = applyManifest(dataRoot, APP_ID, initial);
  if (!applied.valid) {
    throw new Error(`テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied)}`);
  }
  return dataRoot;
}

function current(dataRoot: string): string {
  return JSON.stringify(readCurrentManifest(dataRoot, APP_ID));
}

/** 付与表に、相手の列に値のある行を1行入れる。 */
function seedPrincipalValue(dataRoot: string): void {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const manifest = readCurrentManifest(dataRoot, APP_ID);
    const ev = createRecord(db, manifest, "evaluators", { title: "評価機関A" });
    const org = createRecord(db, manifest, "orgs", { title: "組織A" });
    if (!ev.ok || !org.ok) {
      throw new Error(JSON.stringify({ ev, org }));
    }
    const grant = createRecord(db, manifest, "org_grant", {
      org: org.value._id,
      evaluator: ev.value._id,
      permission: "reader",
    });
    if (!grant.ok || grant.value.evaluator !== ev.value._id) {
      throw new Error(`相手の列に値を入れられませんでした: ${JSON.stringify(grant)}`);
    }
  } finally {
    db.close();
  }
}

const declarePrincipalRow = {
  op: "change_table",
  table: "orgs",
  changes: { access_control: orgsAccessControl({ principalRow: goodPrincipalRow() }) },
};

describe("(F) 宣言の無いアプリに宣言を足す差分", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await freshApp(manifestWith({ orgs: orgsAccessControl() }));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("(F-1) 相手の列に値の入った行が残っていると、宣言の差分全体が断られ、件数が出る。定義は動かない", () => {
    seedPrincipalValue(dataRoot);
    const before = current(dataRoot);
    const result = applyDiff(dataRoot, APP_ID, diffOf([declarePrincipalRow], "pr-f1"));
    const hit = hitAt(result, PR);
    expect(hit.message).toContain('"org_grant"');
    expect(hit.message).toContain("1 件");
    expect(current(dataRoot)).toBe(before);
  });

  test("(F-2) 相手の列が空なら宣言の差分は通る", () => {
    const result = applyDiff(dataRoot, APP_ID, diffOf([declarePrincipalRow], "pr-f2"));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
    const manifest = readCurrentManifest(dataRoot, APP_ID) as unknown as Any;
    const orgs = ((manifest.app as Any).tables as Any[])[0] as Any;
    expect(((orgs.access_control as Any).grant as Any).principal_row).toEqual(goodPrincipalRow());
  });

  test("(F-3 陰性対照) 値の残る列があっても、宣言を足さない差分は今日どおり通る・その列も消せる", () => {
    seedPrincipalValue(dataRoot);
    const added = applyDiff(
      dataRoot,
      APP_ID,
      diffOf(
        [{ op: "add_field", table: "orgs", field: { id: "memo", name: "メモ", type: "text" } }],
        "pr-f3a",
      ),
    );
    expect(errorsOf(added)).toEqual([]);
    const removed = applyDiff(
      dataRoot,
      APP_ID,
      diffOf([{ op: "remove_field", table: "org_grant", field: "evaluator" }], "pr-f3b"),
    );
    expect(errorsOf(removed)).toEqual([]);
    expect(removed.valid).toBe(true);
  });
});

describe("(G) 宣言のあるアプリに後から来る差分", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await freshApp(manifestWith());
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  function refused(operations: unknown[], diffId: string): ValidationError[] {
    const before = current(dataRoot);
    const result = applyDiff(dataRoot, APP_ID, diffOf(operations, diffId));
    expect(result.valid).toBe(false);
    expect(current(dataRoot)).toBe(before);
    const errors = errorsOf(result);
    expectPlainJapanese(errors);
    return errors;
  }

  test("(G-1) principal_row が指す列を remove_field で消す差分は断られる", () => {
    const errors = refused(
      [{ op: "remove_field", table: "org_grant", field: "evaluator" }],
      "pr-g1",
    );
    expect(
      errors.some((error) => error.path.startsWith(PR)),
      JSON.stringify(errors),
    ).toBe(true);
  });

  test("(G-2) 指される表の access_control を外す差分は断られる", () => {
    const errors = refused(
      [
        {
          op: "change_table",
          table: "evaluators",
          changes: { access_control: evaluatorsAccessControl({ enabled: false }) },
        },
      ],
      "pr-g2",
    );
    expect(
      errors.some((error) => error.path === `${PR}/table`),
      JSON.stringify(errors),
    ).toBe(true);
  });

  test("(G-3) 指される表の名簿の表を替える差分は断られる", () => {
    const errors = refused(
      [
        {
          op: "change_table",
          table: "evaluators",
          changes: { access_control: evaluatorsAccessControl({ membersTable: "experts" }) },
        },
      ],
      "pr-g3",
    );
    expect(
      errors.some((error) => error.path === `${PR}/table` && error.message.includes("名簿")),
      JSON.stringify(errors),
    ).toBe(true);
  });

  test("(G-4) 指される表の付与に principal_row を足す差分は断られる(2段になる)", () => {
    const errors = refused(
      [
        {
          op: "change_table",
          table: "evaluators",
          changes: {
            access_control: evaluatorsAccessControl({
              principalRow: { column: "org_ref", table: "orgs", via: ["reader"] },
            }),
          },
        },
      ],
      "pr-g4",
    );
    expect(
      errors.some((error) => error.path.endsWith("/grant/principal_row/table")),
      JSON.stringify(errors),
    ).toBe(true);
  });

  test("(G-5 陰性対照) 宣言に関わらない差分は通る", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      diffOf(
        [
          {
            op: "add_field",
            table: "evaluators",
            field: { id: "memo", name: "メモ", type: "text" },
          },
        ],
        "pr-g5",
      ),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
