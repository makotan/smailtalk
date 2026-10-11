/**
 * **マイページをアプリ単位で宣言する —— `workspace.my_page` と、`set_workspace` の直下のキーごとの置き換え**
 * (`V22-M3-T01`。[`ADR-0488`](../../../../docs/adr/0488-workspace-my-page-and-partial-set-workspace.md)。
 * 門A = `MP-G1` / `MP-G2` / `MP-G4`(限定採用)。ユーザの決定 `D-V22-4` / `D-V22-17` / `D-V22-18` /
 * `D-V22-21` / `D-V22-23`。授権 `ADR-0489`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **設計図の形** —— `workspace` の中は `navigation` と `my_page` の2キー(`ADR-0488` 限定1)。
 *    `my_page` は `open_after_login` / `tables` / `views` の3キーで閉じ、**`minProperties` を持たない**
 *    (`{}` は「既定どおり置く」)。 `tables` は `exclude` / `include` の2キーで `minProperties 1`、
 *    `include` の要素は `table` / `owner_field` の2キー。 配列は空を許さない(限定2)。
 *    `set_workspace` の分岐の器は `minProperties 1` で、2つのキーの値はどちらも「manifest 側への `$ref`」か
 *    `null`(限定3・4)。 op 19 / 操作の器 11 / アプリ直下 10 / `$defs` 31・5 は動かない(限定5)。
 * 2. **受理と、設計図が断る形** —— `{}` を断り、日本語で「何も変えない指示」と言う。 `anyOf` の片側の
 *    言い訳(`null` でない・`anyOf` に合わない)を利用者に見せない。
 * 3. **畳み込んだ後の検査** —— 実在しない表・列・画面 / 重複 / `exclude` と `include` の両方 /
 *    `include` した表の持ち主が既に自動で分かる / `exclude` した表の持ち主が自動では分からない /
 *    `owner_field` が `text` でない・`required` である / `views` に `detail_view`。
 * 4. **連鎖** —— `remove_table` / `remove_field` / `remove_view` / `change_field`(と `set_roles`)で
 *    指し先が消える・壊れる差分は、差分全体を断り、「同じ差分で `set_workspace` も直す」と案内する。
 * 5. **畳み込み(`D-V22-21`)** —— 直下のキーごとに置き換え、書かなかったキーは残す / `null` でそのキーを消す /
 *    すべて消えると `workspace` キーごと消え、定義は宣言前と1バイトも違わない / 純粋関数。
 * 6. **適用・元に戻す・要件定義書** —— `{}` の適用を断る / undo で前の宣言に戻る / 要件定義書は
 *    宣言があるときだけ1文。
 * 7. **`myPageTables`(`src/shared/my-page.ts`)** —— (i) `st_owner` の表 / (ii) 読取の規則の `when` に
 *    `not` の下にない `equals_current_user` の葉がある表 / (iii) `include` / `exclude` で外す。
 *    (i) の判定が `owner-scope.ts` の `personalOwnerField` と一致すること(`ADR-0488` 限定12)。
 *    **【`V22-M3-T01`。`ADR-0490` / `ADR-0492` を重ねて読む】** (ii) は `owner-scope.ts` の末尾の
 *    export 1本(`myPageSelfConditionFields`)と非 export の補助1本が判定し、`my-page.ts` は規則を読まない
 *    (限定12''。`my-page.ts` は `st_owner` も綴らないので、(i) の出どころの印は `"personal"` と書く)。
 *    **`not` の下の「自分」は数えない**(`ADR-0492` §Decision 1 の行1)。 **深さ64を越えた枝は数えない。**
 * 8. **`ADR-0492` §Decision 1-1 の検査(`T02` の完了条件)** —— 「列名の集合が空でない ⇒ 同じ条件で
 *    `conditionNamesCurrentUser` が真」を、`and` / `or` / `not` / 入れ子の `not` / 深さ64を越える木 /
 *    葉が `equals_current_user: false` の6形(と深さ64ちょうどの境目)で見る。 **2本とも非 export なので、
 *    検査のためだけに export を足さない** —— `conditionNamesCurrentUser` の真偽は、それだけが保護の理由に
 *    なる土台で export 済みの `anonymousTableReadable` が偽になることで読む(`anonymousTableProtections` の
 *    `self_condition` の1本が `conditionNamesCurrentUser` を呼ぶ)。 逆向きは成り立たない(`not` の下・深さ超え)。
 *
 * **測らないもの(誇張しない)**:
 * 1. **サーバの `?my_page=1`**(`T04`)。 **画面**(`T05`)。 **生成器**(`T06`)。 **AI へ配る説明文**(`T03`)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { anonymousTableReadable, personalOwnerField } from "../server/owner-scope.ts";
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { generateRequirementsDoc } from "./requirements-doc.ts";
import type { Manifest, Operation, Table } from "./types.ts";
import { DIFF_OPS } from "./types.ts";
import { undo } from "./undo.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const DEFS = "$defs";
const M = (manifestSchema as unknown as Any)[DEFS] as Any;
const D = (diffSchema as unknown as Any)[DEFS] as Any;

const MY_PAGE_REF =
  "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/workspace/properties/my_page";
const NAVIGATION_REF =
  "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/app/properties/workspace/properties/navigation";

function appWorkspace(): Any {
  return (((M.app as Any).properties as Any).workspace ?? {}) as Any;
}

function myPageDef(): Any {
  return (((appWorkspace().properties ?? {}) as Any).my_page ?? {}) as Any;
}

function setWorkspaceContainer(): Any {
  const branch = ((D.operation as Any).allOf as Any[]).find(
    (b) => ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const === "set_workspace",
  ) as Any;
  return (((branch.then as Any).properties as Any).workspace ?? {}) as Any;
}

/** 既定3役割 + `staff`(`tickets` を「担当が自分」で読む。`null` なら規則を持たない)+ `member`。 */
function roles(staffRules: unknown[] | null = [ticketRule()]): Any[] {
  return [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
      ],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
    staffRules === null
      ? { id: "staff", name: "係" }
      : { id: "staff", name: "係", rules: staffRules },
    { id: "member", name: "会員" },
  ];
}

/** `tickets` を「担当(`assignee`)が自分、または担当が空」の行だけ読む規則((ii) の表)。 */
function ticketRule(): Any {
  return {
    target: "table",
    table: "tickets",
    can: ["read"],
    when: {
      or: [
        { field: "assignee", equals_current_user: true },
        { field: "assignee", is_empty: true },
      ],
    },
  };
}

/**
 * - `tasks` —— `st_owner`(text・必須でない)を持つ = (i)
 * - `tickets` —— `staff` の読取の規則に `assignee` の「自分」 = (ii)
 * - `memos` —— 持ち主が自動では分からない。 `writer`(text)/ `code`(text・必須)/ `count`(number)
 * - `notes` —— 持ち主の列を持たない
 */
function baseManifest(): Manifest {
  return {
    app: {
      id: "desk",
      name: "窓口",
      tables: [
        {
          id: "tasks",
          name: "作業",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "st_owner", name: "持ち主", type: "text" },
          ],
        },
        {
          id: "tickets",
          name: "問い合わせ",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "assignee", name: "担当", type: "text" },
          ],
        },
        {
          id: "memos",
          name: "メモ",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "writer", name: "書いた人", type: "text" },
            { id: "code", name: "番号", type: "text", required: true },
            { id: "count", name: "回数", type: "number" },
          ],
        },
        {
          id: "notes",
          name: "お知らせ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
      ],
      views: [
        { id: "task-list", type: "list_view", table: "tasks", columns: ["title"] },
        { id: "ticket-form", type: "form", table: "tickets", fields: ["title"] },
        { id: "memo-list", type: "list_view", table: "memos", columns: ["body"] },
        { id: "memo-detail", type: "detail_view", table: "memos", fields: ["body"] },
        { id: "note-list", type: "list_view", table: "notes", columns: ["body"] },
      ],
      roles: roles(),
    },
  } as unknown as Manifest;
}

function diffOf(operations: unknown[], diffId = "mp-1", intent = "マイページを置く"): unknown {
  return { diff_id: diffId, intent, operations };
}

function setWorkspace(workspace: unknown): Any {
  return { op: "set_workspace", workspace };
}

function fold(current: Manifest, operations: unknown[]): Manifest {
  const result = foldOperations(current, operations as Operation[]);
  if (!result.valid) {
    throw new Error(`畳み込みが失敗しました: ${JSON.stringify(result.errors)}`);
  }
  return result.manifest;
}

function workspaceOf(manifest: Manifest): Any | undefined {
  return (manifest.app as unknown as Any).workspace as Any | undefined;
}

function withWorkspace(manifest: Manifest, workspace: unknown): Manifest {
  const copy = structuredClone(manifest) as unknown as Any;
  (copy.app as Any).workspace = workspace;
  return copy as unknown as Manifest;
}

type ErrorLike = { path: string; message: string; allowed_values?: unknown[]; hint?: string };

function errorsOf(result: { valid: boolean }): ErrorLike[] {
  return result.valid ? [] : ((result as unknown as { errors: ErrorLike[] }).errors ?? []);
}

/** 畳み込んだ後の定義を、適用と同じ `"incoming"` で検証する。 */
function validateFolded(current: Manifest, operations: unknown[]): ErrorLike[] {
  return errorsOf(validateManifestFull(fold(current, operations)));
}

/** `my_page` の下を指す誤りだけ(他の検査の誤りを混ぜない)。 */
function myPageErrors(errors: ErrorLike[]): ErrorLike[] {
  return errors.filter((e) => e.path.startsWith("/app/workspace/my_page"));
}

type MyPageTable = { table: string; ownerFields: string[]; source: string };

/** 実装前でも他の検査を走らせるため、`src/shared/my-page.ts` は検査の中で読み込む。 */
async function loadMyPageTables(): Promise<(manifest: Manifest) => MyPageTable[]> {
  const mod = (await import("../shared/my-page.ts")) as unknown as {
    myPageTables: (manifest: Manifest) => MyPageTable[];
  };
  return mod.myPageTables;
}

// =====================================================================================
// 1. 設計図の形(ADR-0488 限定1〜5)
// =====================================================================================

describe("(1) 設計図の形 —— `workspace.my_page` と `set_workspace` の器", () => {
  test("限定1: `workspace` の中は `navigation` と `my_page` の2キー(この順)で閉じ、空の器は許さない", () => {
    const ws = appWorkspace();
    expect(ws.additionalProperties).toBe(false);
    expect(ws.minProperties).toBe(1);
    // **【2026-09-30。`V23-M5-T02` / 授権 `ADR-0533` 行8】`workspace` の3つ目のキー `invitations`(自分宛ての招待の受け取り画面。`ADR-0532` 限定1)を末尾に足した。 旧の期待(逐語): `expect(Object.keys((ws.properties ?? {}) as Any)).toEqual(["navigation", "my_page"]);` 新しい値はスキーマを python で読んで得た。**
    expect(Object.keys((ws.properties ?? {}) as Any)).toEqual([
      "navigation",
      "my_page",
      "invitations",
    ]);
  });

  test("限定2: `my_page` は3キーで閉じ、`minProperties` を持たない(`{}` は既定どおり置く)", () => {
    const mp = myPageDef();
    expect(mp.type).toBe("object");
    expect(mp.additionalProperties).toBe(false);
    expect("minProperties" in mp).toBe(false);
    const props = (mp.properties ?? {}) as Any;
    expect(Object.keys(props)).toEqual(["open_after_login", "tables", "views"]);
    expect((props.open_after_login as Any).type).toBe("boolean");
    const views = props.views as Any;
    expect(views.type).toBe("array");
    expect(views.minItems).toBe(1);
  });

  test("限定2: `tables` は `exclude` / `include` の2キーで `minProperties 1`、配列は空を許さない、`include` の要素は2キー", () => {
    const tables = ((myPageDef().properties ?? {}) as Any).tables as Any;
    expect(tables.type).toBe("object");
    expect(tables.additionalProperties).toBe(false);
    expect(tables.minProperties).toBe(1);
    const props = (tables.properties ?? {}) as Any;
    expect(Object.keys(props)).toEqual(["exclude", "include"]);
    expect((props.exclude as Any).minItems).toBe(1);
    const include = props.include as Any;
    expect(include.minItems).toBe(1);
    const item = include.items as Any;
    expect(item.type).toBe("object");
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["table", "owner_field"]);
    expect(Object.keys((item.properties ?? {}) as Any)).toEqual(["table", "owner_field"]);
  });

  test("限定3・4: `set_workspace` の器は `minProperties 1`・2キーで閉じ、値はどちらも manifest 側への `$ref` か `null`", () => {
    const container = setWorkspaceContainer();
    expect(container.type).toBe("object");
    expect(container.additionalProperties).toBe(false);
    expect(container.minProperties).toBe(1);
    const props = (container.properties ?? {}) as Any;
    // **【2026-09-30。`V23-M5-T02` / 授権 `ADR-0533` 行9】`workspace` の3つ目のキー `invitations`(自分宛ての招待の受け取り画面。`ADR-0532` 限定1)を末尾に足した。 旧の期待(逐語): `expect(Object.keys(props)).toEqual(["navigation", "my_page"]);` 新しい値はスキーマを python で読んで得た。**
    expect(Object.keys(props)).toEqual(["navigation", "my_page", "invitations"]);
    expect((props.navigation as Any).anyOf).toEqual([{ $ref: NAVIGATION_REF }, { type: "null" }]);
    expect((props.my_page as Any).anyOf).toEqual([{ $ref: MY_PAGE_REF }, { type: "null" }]);
  });

  test("限定5: op 19 / 操作の器 11 / アプリ直下 10 / `$defs` 31・5 は動かない", () => {
    expect(DIFF_OPS).toHaveLength(19);
    expect(DIFF_OPS[18]).toBe("set_workspace");
    expect(Object.keys((D.operation as Any).properties as Any)).toHaveLength(11);
    expect(Object.keys((M.app as Any).properties as Any)).toHaveLength(10);
    expect(Object.keys(M)).toHaveLength(31);
    expect(Object.keys(D)).toHaveLength(5);
  });
});

// =====================================================================================
// 2. 差分の受理と、設計図が断る形
// =====================================================================================

describe("(2) `set_workspace` の受理(直下のキーごと)", () => {
  test.each([
    ["マイページだけ(既定どおり置く)", { my_page: {} }],
    ["ログイン直後に開く", { my_page: { open_after_login: true } }],
    [
      "全部のキー",
      {
        my_page: {
          open_after_login: false,
          tables: { exclude: ["tasks"], include: [{ table: "memos", owner_field: "writer" }] },
          views: ["ticket-form", "memo-list"],
        },
      },
    ],
    ["メニューの位置だけ(マイページは書かない)", { navigation: { placement: "top" } }],
    ["両方", { navigation: { placement: "top" }, my_page: {} }],
    ["メニューの位置を消す", { navigation: null }],
    ["マイページを消す", { my_page: null }],
    ["片方を置き片方を消す", { navigation: { placement: "side" }, my_page: null }],
    ["両方を消す", { navigation: null, my_page: null }],
  ])("%s", (_label, workspace) => {
    const result = validateDiff(diffOf([setWorkspace(workspace)]));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("(2) 設計図が断る形", () => {
  test("空の `{}` は断り、何も変えない指示であることと、`null` で消す書き方を日本語で言う", () => {
    const result = validateDiff(diffOf([setWorkspace({})]));
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/operations/0/workspace");
    expect(errors[0]?.message).toContain("何も変えない");
    expect(errors[0]?.hint ?? "").toContain("null");
    expect(errors[0]?.hint ?? "").toContain("navigation");
    expect(errors[0]?.hint ?? "").toContain("my_page");
  });

  test("`workspace` の3つ目のキーは断り、`navigation` と `my_page` を示す", () => {
    const result = validateDiff(diffOf([setWorkspace({ my_page: {}, notifications: {} })]));
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.message.includes("notifications"));
    expect(error).toBeDefined();
    // **【2026-09-30。`V23-M5-T02` / 授権 `ADR-0533` 行10】`workspace` の3つ目のキー `invitations`(自分宛ての招待の受け取り画面。`ADR-0532` 限定1)を末尾に足した。 旧の期待(逐語): `expect(error?.allowed_values).toEqual(["navigation", "my_page"]);` 新しい値はスキーマを python で読んで得た。**
    expect(error?.allowed_values).toEqual(["navigation", "my_page", "invitations"]);
  });

  test("`my_page` の4つ目のキーは断り、3キーを示す", () => {
    const result = validateDiff(diffOf([setWorkspace({ my_page: { sections: [] } })]));
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.message.includes("sections"));
    expect(error).toBeDefined();
    expect(error?.allowed_values).toEqual(["open_after_login", "tables", "views"]);
  });

  test("`tables` の3つ目のキー・`include` の要素の3つ目のキーは断る", () => {
    const tablesExtra = validateDiff(
      diffOf([setWorkspace({ my_page: { tables: { exclude: ["tasks"], order: [] } } })]),
    );
    expect(errorsOf(tablesExtra).find((e) => e.message.includes("order"))?.allowed_values).toEqual([
      "exclude",
      "include",
    ]);
    const itemExtra = validateDiff(
      diffOf([
        setWorkspace({
          my_page: { tables: { include: [{ table: "memos", owner_field: "writer", limit: 5 }] } },
        }),
      ]),
    );
    expect(errorsOf(itemExtra).find((e) => e.message.includes("limit"))?.allowed_values).toEqual([
      "table",
      "owner_field",
    ]);
  });

  test.each([
    ["空の tables", { tables: {} }],
    ["空の exclude", { tables: { exclude: [] } }],
    ["空の include", { tables: { include: [] } }],
    ["空の views", { views: [] }],
    ["owner_field の無い include の要素", { tables: { include: [{ table: "memos" }] } }],
    ["真偽値でない open_after_login", { open_after_login: "yes" }],
  ])("%s は断る", (_label, myPage) => {
    expect(validateDiff(diffOf([setWorkspace({ my_page: myPage })])).valid).toBe(false);
  });

  test("`anyOf` の片側の言い訳(`null` でない・`anyOf` に合わない)を出さない —— 位置の値の誤りは1件だけ", () => {
    const result = validateDiff(diffOf([setWorkspace({ navigation: { placement: "bottom" } })]));
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expect(errors.map((e) => e.path)).toEqual(["/operations/0/workspace/navigation/placement"]);
    expect(errors[0]?.allowed_values).toEqual(["side", "top"]);
  });

  test("`my_page` の中の誤りも1件だけ(`anyOf` の言い訳を出さない)", () => {
    const result = validateDiff(diffOf([setWorkspace({ my_page: { views: [] } })]));
    expect(result.valid).toBe(false);
    expect(errorsOf(result).map((e) => e.path)).toEqual(["/operations/0/workspace/my_page/views"]);
  });

  test("アプリの定義に直接書いた `workspace: { my_page: {} }` は通り、空の `workspace` は今日どおり断る", () => {
    expect(errorsOf(validateManifestFull(withWorkspace(baseManifest(), { my_page: {} })))).toEqual(
      [],
    );
    expect(validateManifestFull(withWorkspace(baseManifest(), {})).valid).toBe(false);
  });

  test("アプリの定義に `null` のキーは書けない(`null` は差分の中だけの「消す」)", () => {
    expect(validateManifestFull(withWorkspace(baseManifest(), { my_page: null })).valid).toBe(
      false,
    );
  });
});

// =====================================================================================
// 3. 畳み込んだ後の検査(ADR-0488 §Decision 1 の 3)
// =====================================================================================

describe("(3) 畳み込んだ後の検査 —— 受ける形", () => {
  test("自動で分かる表を外し、分からない表を text の列で足し、form / list_view を並べる形は通る", () => {
    const errors = validateFolded(baseManifest(), [
      setWorkspace({
        my_page: {
          open_after_login: true,
          tables: { exclude: ["tasks"], include: [{ table: "memos", owner_field: "writer" }] },
          views: ["ticket-form", "memo-list"],
        },
      }),
    ]);
    expect(errors).toEqual([]);
  });

  test("(ii) の表(`tickets`)も外せる", () => {
    expect(
      validateFolded(baseManifest(), [
        setWorkspace({ my_page: { tables: { exclude: ["tickets"] } } }),
      ]),
    ).toEqual([]);
  });
});

describe("(3) 畳み込んだ後の検査 —— 断る形", () => {
  function reject(myPage: unknown): ErrorLike[] {
    const errors = validateFolded(baseManifest(), [setWorkspace({ my_page: myPage })]);
    expect(errors.length).toBeGreaterThan(0);
    // `my_page` の外の誤りを混ぜない(この検査の土台は他に誤りを持たない)。
    expect(myPageErrors(errors)).toEqual(errors);
    return errors;
  }

  test("`exclude` に実在しない表 → 外せる表(自動で持ち主が分かる表)を示す", () => {
    const errors = reject({ tables: { exclude: ["ghosts"] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/exclude/0");
    expect(errors[0]?.message).toContain('"ghosts"');
    expect(errors[0]?.allowed_values).toEqual(["tasks", "tickets"]);
  });

  test("`exclude` に持ち主が自動では分からない表 → 断り、外せる表を示す", () => {
    const errors = reject({ tables: { exclude: ["memos"] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/exclude/0");
    expect(errors[0]?.message).toContain('"memos"');
    expect(errors[0]?.allowed_values).toEqual(["tasks", "tickets"]);
  });

  test("`exclude` に同じ表が2回 → 2回目を名指しする", () => {
    const errors = reject({ tables: { exclude: ["tasks", "tasks"] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/exclude/1");
    expect(errors[0]?.message).toContain('"tasks"');
  });

  test("`include` に実在しない表 → 足せる表(自動では分からない表)を示す", () => {
    const errors = reject({ tables: { include: [{ table: "ghosts", owner_field: "writer" }] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/include/0/table");
    expect(errors[0]?.message).toContain('"ghosts"');
    expect(errors[0]?.allowed_values).toEqual(["memos", "notes"]);
  });

  test("`include` に持ち主が既に自動で分かる表 → 断る(足す必要が無い)", () => {
    const errors = reject({ tables: { include: [{ table: "tasks", owner_field: "title" }] } });
    expect(errors.map((e) => e.path)).toContain("/app/workspace/my_page/tables/include/0/table");
    const error = errors.find((e) => e.path === "/app/workspace/my_page/tables/include/0/table");
    expect(error?.message).toContain('"tasks"');
    expect(error?.allowed_values).toEqual(["memos", "notes"]);
  });

  test("(ii) の表を `include` しても断る", () => {
    const errors = reject({ tables: { include: [{ table: "tickets", owner_field: "assignee" }] } });
    expect(errors.map((e) => e.path)).toEqual(["/app/workspace/my_page/tables/include/0/table"]);
  });

  test("`include` に同じ表が2回 → 2回目を名指しする", () => {
    const errors = reject({
      tables: {
        include: [
          { table: "memos", owner_field: "writer" },
          { table: "memos", owner_field: "body" },
        ],
      },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/include/1/table");
    expect(errors[0]?.message).toContain('"memos"');
  });

  test("同じ表が `exclude` と `include` の両方に出てくる → 断る", () => {
    const errors = reject({
      tables: { exclude: ["tasks"], include: [{ table: "tasks", owner_field: "st_owner" }] },
    });
    const error = errors.find((e) => e.path === "/app/workspace/my_page/tables/include/0/table");
    expect(error).toBeDefined();
    expect(error?.message).toContain("exclude");
  });

  test("`owner_field` が実在しない → その表の text で必須でない列を示す", () => {
    const errors = reject({ tables: { include: [{ table: "memos", owner_field: "author" }] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/include/0/owner_field");
    expect(errors[0]?.message).toContain('"author"');
    expect(errors[0]?.allowed_values).toEqual(["body", "writer"]);
  });

  test("`owner_field` が text でない → 断る(D-V22-17)", () => {
    const errors = reject({ tables: { include: [{ table: "memos", owner_field: "count" }] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/include/0/owner_field");
    expect(errors[0]?.message).toContain("text");
    expect(errors[0]?.allowed_values).toEqual(["body", "writer"]);
  });

  test("`owner_field` が必須(required)→ 断る(D-V22-17)", () => {
    const errors = reject({ tables: { include: [{ table: "memos", owner_field: "code" }] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/tables/include/0/owner_field");
    expect(errors[0]?.message).toContain("required");
    expect(errors[0]?.allowed_values).toEqual(["body", "writer"]);
  });

  test("`views` に実在しない画面 → 並べられる画面(detail_view を除く)を示す", () => {
    const errors = reject({ views: ["ghost-view"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/views/0");
    expect(errors[0]?.message).toContain('"ghost-view"');
    expect(errors[0]?.allowed_values).toEqual([
      "task-list",
      "ticket-form",
      "memo-list",
      "note-list",
    ]);
  });

  test("`views` に detail_view → 断る(開くには行が要る)", () => {
    const errors = reject({ views: ["memo-list", "memo-detail"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/views/1");
    expect(errors[0]?.message).toContain("detail_view");
    expect(errors[0]?.allowed_values).toEqual([
      "task-list",
      "ticket-form",
      "memo-list",
      "note-list",
    ]);
  });

  test("`views` に同じ画面が2回 → 2回目を名指しする", () => {
    const errors = reject({ views: ["memo-list", "memo-list"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/workspace/my_page/views/1");
    expect(errors[0]?.message).toContain('"memo-list"');
  });

  test("誤りは全部まとめて返す(1往復で直せる)", () => {
    const errors = reject({
      tables: { exclude: ["memos"], include: [{ table: "ghosts", owner_field: "x" }] },
      views: ["memo-detail"],
    });
    expect(errors.map((e) => e.path).sort()).toEqual([
      "/app/workspace/my_page/tables/exclude/0",
      "/app/workspace/my_page/tables/include/0/table",
      "/app/workspace/my_page/views/0",
    ]);
  });
});

// =====================================================================================
// 4. 畳み込み(D-V22-21: 直下のキーごとの置き換え・null で消す・すべて消えたらキーごと消える)
// =====================================================================================

describe("(4) 畳み込み —— 直下のキーごとの置き換え", () => {
  test("書かなかったキーは残る(メニューの位置を変えてもマイページが残る)", () => {
    const declared = fold(baseManifest(), [
      setWorkspace({ navigation: { placement: "side" }, my_page: { open_after_login: true } }),
    ]);
    const next = fold(declared, [setWorkspace({ navigation: { placement: "top" } })]);
    expect(workspaceOf(next)).toEqual({
      navigation: { placement: "top" },
      my_page: { open_after_login: true },
    });
  });

  test("マイページを足してもメニューの位置が残る", () => {
    const declared = fold(baseManifest(), [
      setWorkspace({
        navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
      }),
    ]);
    const next = fold(declared, [setWorkspace({ my_page: {} })]);
    expect(workspaceOf(next)).toEqual({
      navigation: { placement: "top", by_role: [{ role: "staff", placement: "side" }] },
      my_page: {},
    });
  });

  test("書いたキーの中は丸ごと置き換える(前の `by_role` / 前の `views` は残らない)", () => {
    const declared = fold(baseManifest(), [
      setWorkspace({
        navigation: { placement: "side", by_role: [{ role: "staff", placement: "top" }] },
        my_page: { open_after_login: true, views: ["memo-list"] },
      }),
    ]);
    const next = fold(declared, [
      setWorkspace({ navigation: { placement: "top" }, my_page: { views: ["ticket-form"] } }),
    ]);
    expect(workspaceOf(next)).toEqual({
      navigation: { placement: "top" },
      my_page: { views: ["ticket-form"] },
    });
  });

  test("`null` でそのキーだけ消える", () => {
    const declared = fold(baseManifest(), [
      setWorkspace({ navigation: { placement: "top" }, my_page: {} }),
    ]);
    expect(workspaceOf(fold(declared, [setWorkspace({ navigation: null })]))).toEqual({
      my_page: {},
    });
    expect(workspaceOf(fold(declared, [setWorkspace({ my_page: null })]))).toEqual({
      navigation: { placement: "top" },
    });
  });

  test("すべてのキーが消えると `workspace` キーごと消え、定義は宣言前と1バイトも違わない", () => {
    const before = baseManifest();
    const declared = fold(before, [
      setWorkspace({ navigation: { placement: "top" }, my_page: { open_after_login: true } }),
    ]);
    const removed = fold(declared, [setWorkspace({ navigation: null, my_page: null })]);
    expect(Object.keys(removed.app)).not.toContain("workspace");
    expect(JSON.stringify(removed)).toBe(JSON.stringify(before));
    // 1つずつ消しても同じ。
    const stepwise = fold(declared, [
      setWorkspace({ my_page: null }),
      setWorkspace({ navigation: null }),
    ]);
    expect(JSON.stringify(stepwise)).toBe(JSON.stringify(before));
  });

  test("宣言が無いアプリに `null` だけを送っても器は生まれない", () => {
    const before = baseManifest();
    const next = fold(before, [setWorkspace({ my_page: null })]);
    expect(JSON.stringify(next)).toBe(JSON.stringify(before));
  });

  test("同じ差分に2本あれば、キーごとに後の1本が勝ち、書かなかったキーは前の1本のまま", () => {
    const next = fold(baseManifest(), [
      setWorkspace({ navigation: { placement: "top" }, my_page: { open_after_login: true } }),
      setWorkspace({ my_page: { open_after_login: false } }),
    ]);
    expect(workspaceOf(next)).toEqual({
      navigation: { placement: "top" },
      my_page: { open_after_login: false },
    });
  });

  test("元の定義を書き換えない(純粋関数)", () => {
    const declared = fold(baseManifest(), [
      setWorkspace({ navigation: { placement: "top" }, my_page: {} }),
    ]);
    const snapshot = JSON.stringify(declared);
    fold(declared, [setWorkspace({ my_page: null })]);
    fold(declared, [setWorkspace({ my_page: { views: ["memo-list"] } })]);
    expect(JSON.stringify(declared)).toBe(snapshot);
  });
});

// =====================================================================================
// 5. 適用・連鎖・元に戻す・要件定義書
// =====================================================================================

describe("(5) 適用・連鎖・元に戻す・要件定義書", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-workspace-my-page-"));
    const store = KernelMetaStore.open(dataRoot);
    createApp(store, "窓口", { app_id: "desk" });
    store.close();
    const applied = applyManifest(dataRoot, "desk", baseManifest());
    if (!applied.valid) {
      throw new Error(`テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied)}`);
    }
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  function apply(operations: unknown[], diffId: string) {
    return applyDiff(dataRoot, "desk", diffOf(operations, diffId));
  }

  function current(): string {
    return JSON.stringify(readCurrentManifest(dataRoot, "desk"));
  }

  /** 差分全体を断り、「同じ差分で set_workspace も直す」と案内したこと。定義は1バイトも動かない。 */
  function expectCascadeRejected(result: { valid: boolean }, path: string, snapshot: string): void {
    expect(result.valid).toBe(false);
    const error = errorsOf(result).find((e) => e.path === path);
    expect(error).toBeDefined();
    const text = `${error?.message ?? ""}${error?.hint ?? ""}`;
    expect(text).toContain("set_workspace");
    expect(text).toContain("同じ差分");
    expect(current()).toBe(snapshot);
  }

  test("`{}` の適用は断られ、定義は1バイトも動かない", () => {
    expect(apply([setWorkspace({ my_page: {} })], "a-1").valid).toBe(true);
    const snapshot = current();
    const result = apply([setWorkspace({})], "a-2");
    expect(result.valid).toBe(false);
    expect(errorsOf(result)[0]?.message).toContain("何も変えない");
    expect(current()).toBe(snapshot);
  });

  test("適用すると定義に入り、移行の段を1つも生まない", () => {
    const result = apply(
      [
        setWorkspace({
          my_page: { tables: { include: [{ table: "memos", owner_field: "writer" }] } },
        }),
      ],
      "a-3",
    );
    expect(errorsOf(result)).toEqual([]);
    if (!result.valid) {
      return;
    }
    expect(workspaceOf(result.manifest)).toEqual({
      my_page: { tables: { include: [{ table: "memos", owner_field: "writer" }] } },
    });
    expect(result.plan.add_tables).toEqual([]);
    expect(result.plan.add_fields).toEqual([]);
    expect(result.plan.steps ?? []).toEqual([]);
  });

  test("メニューの位置だけを適用しても、マイページの宣言は残る", () => {
    expect(apply([setWorkspace({ my_page: { open_after_login: true } })], "a-4").valid).toBe(true);
    expect(apply([setWorkspace({ navigation: { placement: "top" } })], "a-5").valid).toBe(true);
    expect(workspaceOf(readCurrentManifest(dataRoot, "desk"))).toEqual({
      my_page: { open_after_login: true },
      navigation: { placement: "top" },
    });
  });

  test("undo で1つ前の宣言に戻る(部分更新も `null` で消したのも)", () => {
    const before = current();
    expect(apply([setWorkspace({ navigation: { placement: "top" } })], "u-1").valid).toBe(true);
    const navOnly = current();
    expect(apply([setWorkspace({ my_page: { views: ["memo-list"] } })], "u-2").valid).toBe(true);
    const both = current();
    expect(apply([setWorkspace({ navigation: null })], "u-3").valid).toBe(true);
    expect(workspaceOf(readCurrentManifest(dataRoot, "desk"))).toEqual({
      my_page: { views: ["memo-list"] },
    });

    expect(undo(dataRoot, "desk").valid).toBe(true);
    expect(current()).toBe(both);
    expect(undo(dataRoot, "desk").valid).toBe(true);
    expect(current()).toBe(navOnly);
    expect(undo(dataRoot, "desk").valid).toBe(true);
    expect(current()).toBe(before);
  });

  test("すべて `null` で消すと、定義は宣言前と同じになる", () => {
    const before = current();
    expect(
      apply([setWorkspace({ navigation: { placement: "top" }, my_page: {} })], "n-1").valid,
    ).toBe(true);
    expect(apply([setWorkspace({ navigation: null, my_page: null })], "n-2").valid).toBe(true);
    expect(current()).toBe(before);
  });

  test("連鎖: `remove_view` で `views` の画面を消す差分は差分全体を断り、同じ差分で直せば通る", () => {
    expect(apply([setWorkspace({ my_page: { views: ["note-list"] } })], "c-1").valid).toBe(true);
    const snapshot = current();
    const result = apply([{ op: "remove_view", view: "note-list" }], "c-2");
    expectCascadeRejected(result, "/app/workspace/my_page/views/0", snapshot);
    const fixed = apply(
      [{ op: "remove_view", view: "note-list" }, setWorkspace({ my_page: {} })],
      "c-3",
    );
    expect(errorsOf(fixed)).toEqual([]);
  });

  test("連鎖: `remove_table` で `exclude` の表を消す差分は差分全体を断る", () => {
    expect(
      apply([setWorkspace({ my_page: { tables: { exclude: ["tasks"] } } })], "c-4").valid,
    ).toBe(true);
    const snapshot = current();
    const result = apply(
      [
        { op: "remove_view", view: "task-list" },
        { op: "remove_table", table: "tasks" },
      ],
      "c-5",
    );
    expectCascadeRejected(result, "/app/workspace/my_page/tables/exclude/0", snapshot);
    const fixed = apply(
      [
        { op: "remove_view", view: "task-list" },
        { op: "remove_table", table: "tasks" },
        setWorkspace({ my_page: {} }),
      ],
      "c-6",
    );
    expect(errorsOf(fixed)).toEqual([]);
  });

  test("連鎖: `remove_field` で `include` の持ち主の列を消す差分は差分全体を断る", () => {
    expect(
      apply(
        [
          setWorkspace({
            my_page: { tables: { include: [{ table: "memos", owner_field: "writer" }] } },
          }),
        ],
        "c-7",
      ).valid,
    ).toBe(true);
    const snapshot = current();
    const result = apply([{ op: "remove_field", table: "memos", field: "writer" }], "c-8");
    expectCascadeRejected(result, "/app/workspace/my_page/tables/include/0/owner_field", snapshot);
  });

  test("連鎖: `change_field` で `include` の持ち主の列を必須にする・ID を変える差分は差分全体を断る", () => {
    expect(
      apply(
        [
          setWorkspace({
            my_page: { tables: { include: [{ table: "memos", owner_field: "writer" }] } },
          }),
        ],
        "c-9",
      ).valid,
    ).toBe(true);
    const snapshot = current();
    const required = apply(
      [{ op: "change_field", table: "memos", field: "writer", changes: { required: true } }],
      "c-10",
    );
    expectCascadeRejected(
      required,
      "/app/workspace/my_page/tables/include/0/owner_field",
      snapshot,
    );
    const renamed = apply(
      [{ op: "change_field", table: "memos", field: "writer", changes: { id: "author" } }],
      "c-11",
    );
    expectCascadeRejected(renamed, "/app/workspace/my_page/tables/include/0/owner_field", snapshot);
    // 案内どおり同じ差分で直すと通る。
    const fixed = apply(
      [
        { op: "change_field", table: "memos", field: "writer", changes: { id: "author" } },
        setWorkspace({
          my_page: { tables: { include: [{ table: "memos", owner_field: "author" }] } },
        }),
      ],
      "c-12",
    );
    expect(errorsOf(fixed)).toEqual([]);
  });

  test("連鎖: `set_roles` で (ii) の規則を外すと、`exclude` した表の持ち主が分からなくなるので断る", () => {
    expect(
      apply([setWorkspace({ my_page: { tables: { exclude: ["tickets"] } } })], "c-13").valid,
    ).toBe(true);
    const snapshot = current();
    const result = apply([{ op: "set_roles", roles: roles(null) }], "c-14");
    expectCascadeRejected(result, "/app/workspace/my_page/tables/exclude/0", snapshot);
  });

  test("【V22-M3-T08a 軽-6】連鎖: `add_field` で `include` の表に `st_owner` を足す差分は差分全体を断り、案内に列を足す差分を名指しする", () => {
    expect(
      apply(
        [
          setWorkspace({
            my_page: { tables: { include: [{ table: "memos", owner_field: "writer" }] } },
          }),
        ],
        "c-15",
      ).valid,
    ).toBe(true);
    const snapshot = current();
    const result = apply(
      [
        {
          op: "add_field",
          table: "memos",
          field: { id: "st_owner", name: "持ち主", type: "text" },
        },
      ],
      "c-16",
    );
    expectCascadeRejected(result, "/app/workspace/my_page/tables/include/0/table", snapshot);
    const hint = errorsOf(result).find(
      (e) => e.path === "/app/workspace/my_page/tables/include/0/table",
    )?.hint;
    expect(hint ?? "").toContain("add_field");
    expect(hint ?? "").toContain("列を足す");
  });

  test("【V22-M3-T08a 軽-6】連鎖: `change_table` で `exclude` の表の ID を変える差分は差分全体を断り、案内に表の ID を変える差分を名指しする", () => {
    expect(
      apply([setWorkspace({ my_page: { tables: { exclude: ["tasks"] } } })], "c-17").valid,
    ).toBe(true);
    const snapshot = current();
    const result = apply([{ op: "change_table", table: "tasks", changes: { id: "jobs" } }], "c-18");
    expectCascadeRejected(result, "/app/workspace/my_page/tables/exclude/0", snapshot);
    const hint = errorsOf(result).find(
      (e) => e.path === "/app/workspace/my_page/tables/exclude/0",
    )?.hint;
    expect(hint ?? "").toContain("change_table");
    expect(hint ?? "").toContain("表の ID を変える");
  });

  const MY_PAGE_TEMPLATE = "screens.my_page";

  test("要件定義書: マイページを宣言すると、画面の節に1文だけ出る(件数だけ)", () => {
    const result = apply(
      [
        setWorkspace({
          my_page: {
            open_after_login: true,
            tables: { exclude: ["tasks"], include: [{ table: "memos", owner_field: "writer" }] },
            views: ["ticket-form", "memo-list"],
          },
        }),
      ],
      "r-1",
    );
    expect(errorsOf(result)).toEqual([]);
    const doc = generateRequirementsDoc(dataRoot, "desk");
    const own = doc.statements.filter((s) => s.template === MY_PAGE_TEMPLATE);
    expect(own.map((s) => s.text)).toEqual([
      "このアプリは、ログインした人ごとのマイページを置く。自分の記録に足す表は `1` 件、外す表は `1` 件、開くボタンとして並べる画面は `2` 件である。",
    ]);
    expect(own.map((s) => s.section)).toEqual(["screens"]);
    expect(own.map((s) => JSON.stringify(s.sources))).toEqual([
      JSON.stringify([{ kind: "manifest", pointer: "/app/workspace/my_page" }]),
    ]);
  });

  test("要件定義書: `my_page: {}` でも1文出る(件数は0)", () => {
    expect(apply([setWorkspace({ my_page: {} })], "r-2").valid).toBe(true);
    const doc = generateRequirementsDoc(dataRoot, "desk");
    expect(
      doc.statements.filter((s) => s.template === MY_PAGE_TEMPLATE).map((s) => s.text),
    ).toEqual([
      "このアプリは、ログインした人ごとのマイページを置く。自分の記録に足す表は `0` 件、外す表は `0` 件、開くボタンとして並べる画面は `0` 件である。",
    ]);
  });

  test("要件定義書: マイページの宣言が無ければ、その文は1つも出ず、文書は変わらない", () => {
    const docBefore = generateRequirementsDoc(dataRoot, "desk");
    expect(docBefore.statements.filter((s) => s.template === MY_PAGE_TEMPLATE)).toEqual([]);
    expect(docBefore.markdown.includes("マイページ")).toBe(false);
    // メニューの位置だけの宣言でも出ない。
    // 差分の意図(intent)は履歴の節に逐語で出るので、ここでは「マイページ」を含まない意図で送る
    // (`V22-M3-T02` で、T01 の意図「マイページを置く」が履歴に出て緑にならないことを見て直した)。
    expect(
      applyDiff(
        dataRoot,
        "desk",
        diffOf([setWorkspace({ navigation: { placement: "top" } })], "r-3", "メニューを上に置く"),
      ).valid,
    ).toBe(true);
    const doc = generateRequirementsDoc(dataRoot, "desk");
    expect(doc.statements.filter((s) => s.template === MY_PAGE_TEMPLATE)).toEqual([]);
    expect(doc.markdown.includes("マイページ")).toBe(false);
  });
});

// =====================================================================================
// 6. myPageTables(src/shared/my-page.ts。ADR-0488 限定11・12)
// =====================================================================================

describe("(6) `myPageTables` —— 持ち主が分かる表を決める1本", () => {
  test("マイページの宣言が無ければ空", async () => {
    const myPageTables = await loadMyPageTables();
    expect(myPageTables(baseManifest())).toEqual([]);
  });

  test("`my_page: {}` なら (i) `st_owner` の表と (ii) 「自分」の規則の表を、表の定義順で返す", async () => {
    const myPageTables = await loadMyPageTables();
    expect(myPageTables(withWorkspace(baseManifest(), { my_page: {} }))).toEqual([
      { table: "tasks", ownerFields: ["st_owner"], source: "personal" },
      { table: "tickets", ownerFields: ["assignee"], source: "rule" },
    ]);
  });

  test("`exclude` で外し、`include` で足す((iii))", async () => {
    const myPageTables = await loadMyPageTables();
    const manifest = withWorkspace(baseManifest(), {
      my_page: {
        tables: { exclude: ["tasks"], include: [{ table: "memos", owner_field: "writer" }] },
      },
    });
    expect(myPageTables(manifest)).toEqual([
      { table: "tickets", ownerFields: ["assignee"], source: "rule" },
      { table: "memos", ownerFields: ["writer"], source: "include" },
    ]);
  });

  test("`not` の下の「自分」・読取でない規則・text でない列・実在しない列は (ii) に数えない", async () => {
    const myPageTables = await loadMyPageTables();
    const manifest = withWorkspace(baseManifest(), { my_page: {} }) as unknown as Any;
    (manifest.app as Any).roles = roles([
      {
        target: "table",
        table: "tickets",
        can: ["read"],
        when: { not: { field: "assignee", equals_current_user: true } },
      },
      {
        target: "table",
        table: "memos",
        can: ["write"],
        when: { field: "writer", equals_current_user: true },
      },
      {
        target: "table",
        table: "memos",
        can: ["read"],
        when: { field: "count", equals_current_user: true },
      },
      {
        target: "table",
        table: "notes",
        can: ["read"],
        when: { field: "nobody", equals_current_user: true },
      },
    ]);
    expect(myPageTables(manifest as unknown as Manifest)).toEqual([
      { table: "tasks", ownerFields: ["st_owner"], source: "personal" },
    ]);
  });

  test("「かつ」「または」の下の「自分」は数え、同じ表の `st_owner` と規則の列は1つにまとめる(D-V22-23)", async () => {
    const myPageTables = await loadMyPageTables();
    const manifest = withWorkspace(baseManifest(), { my_page: {} }) as unknown as Any;
    const app = manifest.app as Any;
    const tables = app.tables as Any[];
    (tables[0] as Any).fields = [
      ...((tables[0] as Any).fields as Any[]),
      { id: "helper", name: "手伝い", type: "text" },
    ];
    app.roles = roles([
      {
        target: "table",
        table: "tasks",
        can: ["read", "write"],
        when: {
          and: [
            { field: "title", equals: "x" },
            {
              or: [
                { field: "helper", equals_current_user: true },
                { field: "st_owner", equals_current_user: true },
              ],
            },
          ],
        },
      },
      ticketRule(),
    ]);
    expect(myPageTables(manifest as unknown as Manifest)).toEqual([
      { table: "tasks", ownerFields: ["st_owner", "helper"], source: "personal" },
      { table: "tickets", ownerFields: ["assignee"], source: "rule" },
    ]);
  });

  test("(i) の判定は `owner-scope.ts` の `personalOwnerField` と一致する(ADR-0488 限定12)", async () => {
    const myPageTables = await loadMyPageTables();
    const variants: Table[] = [
      {
        id: "t-text",
        name: "a",
        fields: [{ id: "st_owner", name: "o", type: "text" }],
      },
      {
        id: "t-required",
        name: "b",
        fields: [{ id: "st_owner", name: "o", type: "text", required: true }],
      },
      {
        id: "t-number",
        name: "c",
        fields: [{ id: "st_owner", name: "o", type: "number" }],
      },
      { id: "t-none", name: "d", fields: [{ id: "owner", name: "o", type: "text" }] },
    ] as unknown as Table[];
    const manifest = {
      app: { id: "v", name: "v", tables: variants, views: [], workspace: { my_page: {} } },
    } as unknown as Manifest;
    const fromMyPage = myPageTables(manifest)
      .filter((t) => t.source === "personal")
      .map((t) => [t.table, t.ownerFields]);
    const fromOwnerScope = variants
      .map((t) => [t.id, personalOwnerField(t)?.id] as const)
      .filter(([, id]) => id !== undefined)
      .map(([table, id]) => [table, [id]]);
    expect(fromMyPage as unknown[]).toEqual(fromOwnerScope);
    expect(fromMyPage).toEqual([["t-text", ["st_owner"]]]);
  });

  test("`src/shared/my-page.ts` は `personalOwnerField` を値で import し、`st_owner` を自分で綴らない", () => {
    const source = readFileSync(join(import.meta.dir, "..", "shared", "my-page.ts"), "utf-8");
    expect(source).toMatch(
      /import\s*\{[^}]*\bpersonalOwnerField\b[^}]*\}\s*from\s*"\.\.\/server\/owner-scope\.ts"/,
    );
    expect(source.includes("st_owner")).toBe(false);
    expect(source.includes("OWNER_FIELD")).toBe(false);
  });
});

// =====================================================================================
// 7. (ii) の判定の締め直し(ADR-0490 / ADR-0492。T02 の完了条件)
// =====================================================================================

type SelfConditionFields = (manifest: Manifest, tableId: string) => readonly string[];
type AnonymousTableReadable = (manifest: Manifest, table: Table) => boolean;

/** 実装前でも他の検査を走らせるため、`owner-scope.ts` の末尾の export は検査の中で読み込む。 */
async function loadOwnerScope(): Promise<{
  selfConditionFields: SelfConditionFields;
  anonymousTableReadable: AnonymousTableReadable;
}> {
  const mod = (await import("../server/owner-scope.ts")) as unknown as {
    myPageSelfConditionFields?: SelfConditionFields;
    anonymousTableReadable: AnonymousTableReadable;
  };
  if (typeof mod.myPageSelfConditionFields !== "function") {
    throw new Error("owner-scope.ts に myPageSelfConditionFields がまだありません");
  }
  return {
    selfConditionFields: mod.myPageSelfConditionFields,
    anonymousTableReadable: mod.anonymousTableReadable,
  };
}

/** `wrappers` 段の `and` で包んだ「自分」の葉(葉の深さ = `wrappers`。根が深さ0)。 */
function deepSelfLeaf(wrappers: number, field = "assignee"): unknown {
  let node: unknown = { field, equals_current_user: true };
  for (let i = 0; i < wrappers; i += 1) {
    node = { and: [node] };
  }
  return node;
}

/**
 * `tickets` を、`staff` が条件 `when` つきで読み、未ログイン(`anonymous`)が条件なしで読む土台。
 * `tickets` は `st_owner` / `st_public` / 行ごとの付与を持たないので、未ログインの表ごとの読取を閉じる
 * 理由になりうるのは `self_condition`(= `conditionNamesCurrentUser` が真)の1本だけである。
 */
function oracleManifest(when: unknown): Manifest {
  const manifest = withWorkspace(baseManifest(), { my_page: {} }) as unknown as Any;
  (manifest.app as Any).roles = [
    ...roles([{ target: "table", table: "tickets", can: ["read"], when }]),
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [{ target: "table", table: "tickets", can: ["read"] }],
    },
  ];
  return manifest as unknown as Manifest;
}

function ticketsOf(manifest: Manifest): Table {
  return manifest.app.tables.find((t) => t.id === "tickets") as Table;
}

describe("(7) (ii) の判定 —— `owner-scope.ts` の末尾の export 1本(ADR-0490 / ADR-0492)", () => {
  test("深さ64を越えた枝の「自分」は数えず、その表は (ii) に載らない", async () => {
    const myPageTables = await loadMyPageTables();
    const manifest = withWorkspace(baseManifest(), { my_page: {} }) as unknown as Any;
    (manifest.app as Any).roles = roles([
      { target: "table", table: "tickets", can: ["read"], when: deepSelfLeaf(65) },
    ]);
    expect(myPageTables(manifest as unknown as Manifest)).toEqual([
      { table: "tasks", ownerFields: ["st_owner"], source: "personal" },
    ]);
  });

  test("深さ64ちょうどの葉は数える(打ち切りは `conditionNamesCurrentUser` と同じ段で起きる)", async () => {
    const myPageTables = await loadMyPageTables();
    const manifest = withWorkspace(baseManifest(), { my_page: {} }) as unknown as Any;
    (manifest.app as Any).roles = roles([
      { target: "table", table: "tickets", can: ["read"], when: deepSelfLeaf(64) },
    ]);
    expect(myPageTables(manifest as unknown as Manifest)).toEqual([
      { table: "tasks", ownerFields: ["st_owner"], source: "personal" },
      { table: "tickets", ownerFields: ["assignee"], source: "rule" },
    ]);
  });

  test("`not` の下の葉は、入れ子の `not` の下でも数えない。 `not` と並ぶ葉は数える", async () => {
    const { selfConditionFields } = await loadOwnerScope();
    const nested = oracleManifest({
      not: { not: { field: "assignee", equals_current_user: true } },
    });
    expect(selfConditionFields(nested, "tickets")).toEqual([]);
    const mixed = oracleManifest({
      and: [
        { not: { field: "title", equals_current_user: true } },
        { field: "assignee", equals_current_user: true },
      ],
    });
    expect(selfConditionFields(mixed, "tickets")).toEqual(["assignee"]);
  });

  test("集める範囲は全役割の、その表を名指しした `read` を含む規則(閲覧者の役割で絞らない)。 重複は1つにまとめる", async () => {
    const { selfConditionFields } = await loadOwnerScope();
    const manifest = withWorkspace(baseManifest(), { my_page: {} }) as unknown as Any;
    const app = manifest.app as Any;
    const base = roles([
      {
        target: "table",
        table: "tickets",
        can: ["read"],
        when: { field: "assignee", equals_current_user: true },
      },
      {
        target: "table",
        table: "tickets",
        can: ["write"],
        when: { field: "title", equals_current_user: true },
      },
    ]);
    app.roles = [
      ...base.map((r) =>
        (r as Any).id === "member"
          ? {
              ...(r as Any),
              rules: [
                {
                  target: "table",
                  table: "tickets",
                  can: ["read", "write"],
                  when: {
                    or: [
                      { field: "assignee", equals_current_user: true },
                      { field: "reviewer", equals_current_user: true },
                    ],
                  },
                },
                {
                  target: "table",
                  table: "memos",
                  can: ["read"],
                  when: { field: "writer", equals_current_user: true },
                },
              ],
            }
          : r,
      ),
    ];
    expect(selfConditionFields(manifest as unknown as Manifest, "tickets")).toEqual([
      "assignee",
      "reviewer",
    ]);
    expect(selfConditionFields(manifest as unknown as Manifest, "notes")).toEqual([]);
    expect(selfConditionFields(manifest as unknown as Manifest, "ghosts")).toEqual([]);
  });

  test("役割も規則も無い・形の壊れた定義では空を返し、例外を投げない", async () => {
    const { selfConditionFields } = await loadOwnerScope();
    expect(
      selfConditionFields(
        { app: { id: "x", name: "x", tables: [], views: [] } } as unknown as Manifest,
        "t",
      ),
    ).toEqual([]);
    expect(selfConditionFields(null as unknown as Manifest, "t")).toEqual([]);
    const broken = oracleManifest({ and: "壊れている" });
    expect(selfConditionFields(broken, "tickets")).toEqual([]);
  });
});

describe("(8) ADR-0492 §Decision 1-1: 列名の集合が空でない ⇒ 同じ条件で `conditionNamesCurrentUser` が真", () => {
  test("土台の対照: 「自分」を含まない条件では未ログインが読め、含む条件では読めない(読み手の較正)", () => {
    const plain = oracleManifest({ field: "title", equals: "x" });
    expect(anonymousTableReadable(plain, ticketsOf(plain))).toBe(true);
    const self = oracleManifest({ field: "assignee", equals_current_user: true });
    expect(anonymousTableReadable(self, ticketsOf(self))).toBe(false);
  });

  // [形, 条件, 列名の期待, conditionNamesCurrentUser の期待(= 未ログインが読めないこと)]
  test.each([
    [
      "and",
      {
        and: [
          { field: "title", equals: "x" },
          { field: "assignee", equals_current_user: true },
        ],
      },
      ["assignee"],
      true,
    ],
    [
      "or",
      {
        or: [
          { field: "assignee", equals_current_user: true },
          { field: "assignee", is_empty: true },
        ],
      },
      ["assignee"],
      true,
    ],
    ["not", { not: { field: "assignee", equals_current_user: true } }, [], true],
    ["入れ子の not", { not: { not: { field: "assignee", equals_current_user: true } } }, [], true],
    ["深さ64を越える木", deepSelfLeaf(65), [], true],
    ["深さ64ちょうどの木", deepSelfLeaf(64), ["assignee"], true],
    [
      "葉が equals_current_user: false",
      { field: "assignee", equals_current_user: false },
      [],
      false,
    ],
  ] as const)("%s", async (_label, when, expectedFields, expectedNamesCurrentUser) => {
    const { selfConditionFields, anonymousTableReadable } = await loadOwnerScope();
    const manifest = oracleManifest(when);
    const fields = selfConditionFields(manifest, "tickets");
    const namesCurrentUser = !anonymousTableReadable(manifest, ticketsOf(manifest));
    expect([...fields]).toEqual([...expectedFields]);
    expect(namesCurrentUser).toBe(expectedNamesCurrentUser);
    // 含意: 列名が空でない ⇒ conditionNamesCurrentUser が真。
    expect(fields.length === 0 || namesCurrentUser).toBe(true);
  });

  test("`src/shared/my-page.ts` は規則を読む綴り(限定12'' の7語)を持たない", () => {
    const source = readFileSync(join(import.meta.dir, "..", "shared", "my-page.ts"), "utf-8");
    for (const word of [
      "st_owner",
      "OWNER_FIELD",
      "equals_current_user",
      "rules",
      "roleRulesOf",
      "manifestRoleDeclarations",
      ".when",
    ]) {
      expect(source.includes(word)).toBe(false);
    }
  });
});
