/**
 * `V14-M2-T02`(`RB-G1` / `RB-G3` / `RB-G4`): **形 → 動詞の写像を、製品にちょうど1本置く。**
 *
 * **正は `ADR-0402` §Decision 5 の表**(4形ごとに見る対象)であり、
 * **計画の正は `docs/plan/v14/01-v14-m2-tasks.md` §2** である。
 *
 * ## このファイルが固定すること
 *
 * | # | 条件 |
 * |---|---|
 * | (1) | `set` / `run` / `view` / `form` の4形を**別々に**撃つ(`ADR-0402` 限定27。`set` の検査で代用しない) |
 * | (2) | `form` 形は「作る先が**今開いている表の**付与表か」だけを見る |
 * | (3) | `inherit_from` が空でも `grant.member` が無くても `grant_write` を返す(§0a。サーバは `grant.table` だけを見ている) |
 * | (4) | `rowAccessAllows` の既定は「出す」である(`undefined` は真) |
 * | (5) | 返しうる動詞の全量は `read` / `write` / `grant_write` の3つちょうど(`run` 専用の動詞が無い。`ADR-0402` 限定24) |
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **画面が正しく隠すことを1件も測っていない** —— それは `V14-M2-T03` / `T04` の担当である。
 * 2. **サーバの遮断を1件も測っていない。** **ボタンを隠すことは書込を止めることではない**
 *    (`ADR-0402` 限定7)。**最終防衛線は今日どおりサーバの 403 / 404 である。**
 */
import { describe, expect, test } from "bun:test";
import type { Manifest } from "../../src/kernel/types.ts";
import type { RowAccess } from "../src/api.ts";
import { grantMemberScope } from "../src/fields/input.tsx";
import type { RowActionVerb, RowVerb } from "../src/views/row-action-verb.ts";
import { rowAccessAllows, rowActionVerb } from "../src/views/row-action-verb.ts";

const PERMISSIONS = [
  { id: "reader", name: "読める", read: true, write: false, delete: false },
  { id: "keeper", name: "任せる", read: true, write: true, delete: true },
];

/**
 * 付与表を持つ表を3通り並べたマニフェスト。
 *
 * - `projects` … **宣言が全部揃っている**(`inherit_from` も `grant.member` も在る)
 * - `issues` … **`inherit_from` が空**(§0a が名指しした形。`access_control:` を書く32本中19本がこれ)
 * - `notes` … **`grant.member` が無い**(同上)
 * - `memos` … **アクセス権管理を1バイトも宣言していない**(付与表ではない form の行き先)
 */
function fixtureManifest(): Manifest {
  return {
    app: {
      id: "row-action-verb",
      name: "形と動詞",
      tables: [
        { id: "programs", name: "事業", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "projects",
          name: "案件",
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "program", name: "事業", type: "reference", reference_table: "programs" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            inherit_from: ["program"],
            grant: {
              table: "project_grant",
              target: "project",
              member: "member",
              permission: "permission",
            },
          },
        },
        {
          id: "issues",
          name: "課題",
          fields: [{ id: "title", name: "件名", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            // **空である**(§0a)。**サーバの `rowGrantWriteJudge` はこれを1度も見ない。**
            inherit_from: [],
            grant: {
              table: "issue_grant",
              target: "issue",
              member: "member",
              permission: "permission",
            },
          },
        },
        {
          id: "notes",
          name: "覚書",
          fields: [{ id: "body", name: "本文", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            inherit_from: ["program"],
            // **`member` を書いていない**(§0a)。
            grant: { table: "note_grant", target: "note", permission: "permission" },
          },
        },
        { id: "memos", name: "備忘", fields: [{ id: "body", name: "本文", type: "text" }] },
        {
          id: "project_grant",
          name: "案件の付与",
          fields: [
            { id: "project", name: "対象", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "reference", reference_table: "programs" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
        {
          id: "issue_grant",
          name: "課題の付与",
          fields: [
            { id: "issue", name: "対象", type: "reference", reference_table: "issues" },
            { id: "member", name: "相手", type: "reference", reference_table: "programs" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
        {
          id: "note_grant",
          name: "覚書の付与",
          fields: [
            { id: "note", name: "対象", type: "reference", reference_table: "notes" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
      ],
      views: [
        { id: "project-grant-form", type: "form", table: "project_grant" },
        { id: "issue-grant-form", type: "form", table: "issue_grant" },
        { id: "note-grant-form", type: "form", table: "note_grant" },
        { id: "memo-form", type: "form", table: "memos" },
      ],
      workflows: [],
    },
  } as unknown as Manifest;
}

function access(overrides: Partial<RowAccess> = {}): RowAccess {
  return { read: true, write: true, delete: true, grant_write: true, ...overrides };
}

describe("形 → 動詞の写像(ADR-0402 §Decision 5)", () => {
  test("(RB-G1/verb-1) set 形は write を返す", () => {
    const manifest = fixtureManifest();
    expect(
      rowActionVerb(manifest, "projects", { set: { field: "title", value: "済" }, name: "閉じる" }),
    ).toBe("write");
  });

  test("(RB-G4/verb-2) run 形は write を返す", () => {
    const manifest = fixtureManifest();
    // **`set` の検査で代用していない**(`ADR-0402` 限定27)—— 起点も期待値も別に書いている。
    expect(rowActionVerb(manifest, "projects", { run: "send_mail", name: "送る" })).toBe("write");
  });

  test("(RB-G1/verb-3) view 形は read を返す", () => {
    const manifest = fixtureManifest();
    expect(rowActionVerb(manifest, "projects", { view: "project-detail", name: "開く" })).toBe(
      "read",
    );
  });

  test("(RB-G3/verb-4) form 形は、作る先が今開いている表の付与表のとき grant_write を返す", () => {
    const manifest = fixtureManifest();
    expect(
      rowActionVerb(manifest, "projects", {
        form: "project-grant-form",
        prefill: { field: "project" },
      }),
    ).toBe("grant_write");
  });

  test("(RB-G3/verb-5) form 形でも、作る先が付与表でなければ undefined(今日どおり面だけ)", () => {
    const manifest = fixtureManifest();
    expect(
      rowActionVerb(manifest, "projects", { form: "memo-form", prefill: { field: "body" } }),
    ).toBeUndefined();
  });

  test("(RB-G3/verb-5b) form 形は、inherit_from が空の付与表でも grant_write を返す", () => {
    const manifest = fixtureManifest();
    // **この1行が §0a の噛み合わせ不良そのものである** ——
    // **`grantMemberScope` はこの表で `undefined` に落ちる。写像はそれに乗らない。**
    expect(grantMemberScope(manifest, "issue_grant")).toBeUndefined();
    expect(
      rowActionVerb(manifest, "issues", { form: "issue-grant-form", prefill: { field: "issue" } }),
    ).toBe("grant_write");
  });

  test("(RB-G3/verb-5c) form 形は、grant.member を書いていない付与表でも grant_write を返す", () => {
    const manifest = fixtureManifest();
    expect(grantMemberScope(manifest, "note_grant")).toBeUndefined();
    expect(
      rowActionVerb(manifest, "notes", { form: "note-grant-form", prefill: { field: "note" } }),
    ).toBe("grant_write");
  });

  test("(RB-G3/verb-6) form 形でも、作る先が別の親の付与表なら undefined", () => {
    const manifest = fixtureManifest();
    // **`issue_grant` は `issues` の付与表であって、`projects` の付与表ではない。**
    // **`access` の鍵は「今開いている表の行の `_id`」なので、別の親の行は当てられない。**
    expect(
      rowActionVerb(manifest, "projects", {
        form: "issue-grant-form",
        prefill: { field: "issue" },
      }),
    ).toBeUndefined();
  });

  test("(RB-G1/verb-11) 複数形は set → run → view → form の順で最初に当たったものを返す", () => {
    const manifest = fixtureManifest();
    expect(
      rowActionVerb(manifest, "projects", {
        set: { field: "title", value: "済" },
        run: "send_mail",
        view: "project-detail",
        form: "project-grant-form",
      }),
    ).toBe("write");
    expect(
      rowActionVerb(manifest, "projects", {
        run: "send_mail",
        view: "project-detail",
        form: "project-grant-form",
      }),
    ).toBe("write");
    expect(
      rowActionVerb(manifest, "projects", {
        view: "project-detail",
        form: "project-grant-form",
      }),
    ).toBe("read");
  });

  test("(RB-G4/verb-10) 写像が返しうる動詞の全量は read / write / grant_write の3つちょうどである", () => {
    const manifest = fixtureManifest();
    const verbs = [
      rowActionVerb(manifest, "projects", { set: { field: "title", value: "済" } }),
      rowActionVerb(manifest, "projects", { run: "send_mail" }),
      rowActionVerb(manifest, "projects", { view: "project-detail" }),
      rowActionVerb(manifest, "projects", {
        form: "project-grant-form",
        prefill: { field: "project" },
      }),
      rowActionVerb(manifest, "projects", { form: "memo-form", prefill: { field: "body" } }),
      rowActionVerb(manifest, "projects", { name: "どれでもない" }),
    ];
    expect([...new Set(verbs.filter((verb) => verb !== undefined))].sort()).toEqual([
      "grant_write",
      "read",
      "write",
    ]);
    // **`run` 専用の動詞が無い**(`ADR-0402` 限定24)—— `set` と1バイトも同じ動詞である。
    expect(rowActionVerb(manifest, "projects", { run: "send_mail" })).toBe(
      rowActionVerb(manifest, "projects", { set: { field: "title", value: "済" } }),
    );
  });
});

describe("rowAccessAllows(既定は「出す」に倒す)", () => {
  test("(RB-G1/verb-7) rowAccessAllows は verb が undefined なら真", () => {
    expect(
      rowAccessAllows(access({ read: false, write: false, grant_write: false }), undefined),
    ).toBe(true);
  });

  test("(RB-G1/verb-8) rowAccessAllows は rowAccess が undefined なら真(宣言していない表)", () => {
    expect(rowAccessAllows(undefined, "write")).toBe(true);
    expect(rowAccessAllows(undefined, "read")).toBe(true);
    expect(rowAccessAllows(undefined, "grant_write")).toBe(true);
  });

  test("(RB-G1/verb-9) rowAccessAllows は動詞の値をそのまま返す(3動詞ぶん)", () => {
    expect(rowAccessAllows(access({ read: false }), "read")).toBe(false);
    expect(rowAccessAllows(access({ read: true }), "read")).toBe(true);
    expect(rowAccessAllows(access({ write: false }), "write")).toBe(false);
    expect(rowAccessAllows(access({ write: true }), "write")).toBe(true);
    expect(rowAccessAllows(access({ grant_write: false }), "grant_write")).toBe(false);
    expect(rowAccessAllows(access({ grant_write: true }), "grant_write")).toBe(true);
  });
});

/**
 * `V14-M6-T01`(`RB-G7` / `RB-G8`): **判定を受け取る側が `delete` を扱えること。**
 *
 * **計画の正は `docs/plan/v14/04-v14-m6-tasks.md` §2 `T01`**(§6 が §0〜§5 を上書きしている)。
 *
 * ## この節が固定すること
 *
 * | # | 条件 |
 * |---|---|
 * | (1) | `rowAccessAllows` が `"delete"` を受け、その行の `delete` **そのもの**を返す(`RB-G7`) |
 * | (2) | 宣言していない表(`rowAccess === undefined`)では `"delete"` でも既定の「出す」に倒れる(`ADR-0402` 限定4) |
 * | (3) | **写像(`rowActionVerb`)は `"delete"` を1度も返さない**(`ADR-0402` 越えてはならない線1。戻り型を1バイトも広げていない) |
 * | (4) | `"write"` を `"delete"` で代用していない —— 2つが食い違う値のとき、それぞれ自分の動詞を返す(`RB-G8`) |
 *
 * ## この節が証明しないこと(誇張しない)
 *
 * 1. **組み込みの削除・編集ボタンが実際に隠れることを1件も測っていない** ——
 *    それは `V14-M6-T02` / `T03`(`web/test/row-grant-detail-buttons.test.tsx`)の担当である。
 * 2. **サーバの遮断を1件も測っていない。** **最終防衛線は今日どおり 403 / 404 である**
 *    (`ADR-0402` 限定7)。
 */
describe("V14-M6-T01: 判定を受け取る側が delete を扱う(RB-G7 / RB-G8)", () => {
  test("(RB-G7/verb-1) rowAccessAllows は delete が偽の行で偽を返す", () => {
    const verb: RowVerb = "delete";
    expect(
      rowAccessAllows({ read: true, write: true, delete: false, grant_write: false }, verb),
    ).toBe(false);
  });

  test("(RB-G7/verb-2) rowAccessAllows は delete が真の行で真を返す", () => {
    const verb: RowVerb = "delete";
    expect(
      rowAccessAllows({ read: true, write: true, delete: true, grant_write: false }, verb),
    ).toBe(true);
  });

  test("(RB-G7/verb-3) rowAccessAllows は宣言していない表では delete でも真(既定は「出す」)", () => {
    // **`ADR-0402` 限定4** —— **既存アプリの見え方を黙って変えない。**
    const verb: RowVerb = "delete";
    expect(rowAccessAllows(undefined, verb)).toBe(true);
  });

  test("(RB-G7/verb-4) rowActionVerb は delete を1度も返さない(6通り。4形は今日どおりの動詞)", () => {
    const manifest = fixtureManifest();
    // **6通りである** —— 4形 + 複合 + 不正な入力。
    // **同じ検査で「4形が今日どおりの動詞を返す」ことも撃つ** ——
    // **写像を1バイトも変えていないことを示すためである。**
    const cases: { readonly label: string; readonly verb: RowActionVerb | undefined }[] = [
      {
        label: "1. set 形",
        verb: rowActionVerb(manifest, "projects", { set: { field: "title", value: "済" } }),
      },
      { label: "2. run 形", verb: rowActionVerb(manifest, "projects", { run: "send_mail" }) },
      {
        label: "3. view 形",
        verb: rowActionVerb(manifest, "projects", { view: "project-detail" }),
      },
      {
        label: "4. form 形",
        verb: rowActionVerb(manifest, "projects", {
          form: "project-grant-form",
          prefill: { field: "project" },
        }),
      },
      {
        label: "5. 複合(複数の形のキーを同時に持つ)",
        verb: rowActionVerb(manifest, "projects", {
          set: { field: "title", value: "済" },
          run: "send_mail",
          view: "project-detail",
          form: "project-grant-form",
        }),
      },
      {
        label: "6. 不正な入力(null / 配列 / 文字列)",
        // **どれも `undefined` に落ちるので、代表して1つを持たせる。**
        // **残り2つはこの直後に別途撃つ。**
        verb: rowActionVerb(manifest, "projects", null),
      },
    ];
    // **`delete` を1度も返さない**(6通りぶん)。
    for (const item of cases) {
      expect(item.verb, item.label).not.toBe("delete" as unknown as RowActionVerb);
    }
    // **4形は今日どおりの動詞である**(写像を1バイトも変えていない)。
    expect(cases.map((item) => item.verb)).toEqual([
      "write",
      "write",
      "read",
      "grant_write",
      "write",
      undefined,
    ]);
    // **6番の残り**(配列・文字列)。**どれも `delete` ではなく `undefined` である。**
    expect(rowActionVerb(manifest, "projects", [])).toBeUndefined();
    expect(rowActionVerb(manifest, "projects", "delete")).toBeUndefined();
  });

  test("(RB-G8/verb-1) rowAccessAllows の write は delete で代用されていない", () => {
    const writeVerb: RowVerb = "write";
    const deleteVerb: RowVerb = "delete";
    expect(
      rowAccessAllows({ read: true, write: false, delete: false, grant_write: false }, writeVerb),
    ).toBe(false);
    expect(
      rowAccessAllows({ read: true, write: true, delete: true, grant_write: false }, writeVerb),
    ).toBe(true);
    // **2つが食い違う値のとき、それぞれ自分の動詞を返す** ——
    // **編集ボタンが `delete` を見ていない/削除ボタンが `write` を見ていないことの土台である。**
    const writableButNotDeletable: RowAccess = {
      read: true,
      write: true,
      delete: false,
      grant_write: false,
    };
    expect(rowAccessAllows(writableButNotDeletable, writeVerb)).toBe(true);
    expect(rowAccessAllows(writableButNotDeletable, deleteVerb)).toBe(false);
    const deletableButNotWritable: RowAccess = {
      read: true,
      write: false,
      delete: true,
      grant_write: false,
    };
    expect(rowAccessAllows(deletableButNotWritable, writeVerb)).toBe(false);
    expect(rowAccessAllows(deletableButNotWritable, deleteVerb)).toBe(true);
  });
});
