/**
 * **行単位の招待の語彙と、適用時の拒否 —— `access_control.invitations` と `workspace.invitations`**
 * (`V23-M5-T01`。門A = `ADR-0501`(`SC-G17`〜`SC-G19`)を補う `ADR-0532` §Decision 1-1。
 * 決定 `D-V23-119`・`D-V23-133` 軽5。授権 `ADR-0533`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**:
 * 1. **設計図の形** —— `access_control.invitations` は5キー(`by?` / `grantable` / `target_roles?` /
 *    `expires_days?` / `group_from?`)で閉じ、`grantable` だけが必須で1つ以上。 `expires_days` は1〜30の整数。
 *    `workspace.invitations = { label }`(`label` は必須)。 `set_workspace` の器でも書け、`null` で消せる。
 *    6キー目・範囲の外・空の配列を断る。 **新しい `$defs` は作らない。**
 * 2. **適用時の拒否**(`referential-integrity.ts`。畳み込んだ後の定義に対して見る) ——
 *    `by`・`grantable` の要素が `permissions[].id` に無い / `target_roles` の要素が `roles` に無い /
 *    `group_from` が招待する表の reference 項目でない・グループの表(`groups.table`)を指さない・
 *    `members.group` が無い / 付与表に決まった列(相手の行・メンバー・グループ・権限)の外の必須の項目がある /
 *    招待を宣言した表(`enabled: true` のものだけ数える)があるのに `workspace.invitations` が無い
 *    (`set_workspace` の `null` で消す差分を含む)。 置き忘れの案内は「同じ差分で `set_workspace` も直す」。
 * 3. **文面** —— 型の違反の文面が罠の汎用文(識別子の規約の汎用 hint・英語の既定文・`anyOf` の言い訳)に
 *    ならないこと。
 * 4. **書かないアプリは今日と同じ** —— 招待を書かない定義は今日どおり通り、`set_workspace` の畳み込みの
 *    キーの並びも今日と同じ。
 *
 * **測らないもの(誇張しない)**: 口・承諾の判定・内部表(`T03` 以降)。 画面(`T06`)。 生成器(`T09`)。
 * 説明書・要件書の文(`T08`)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import diffSchema from "../../schemas/diff.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/manifest.schema.json" with { type: "json" };
import { applyDiff, foldOperations } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import type { Manifest, Operation } from "./types.ts";
import { validateDiff, validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const DEFS = "$defs";
const M = (manifestSchema as unknown as Any)[DEFS] as Any;
const D = (diffSchema as unknown as Any)[DEFS] as Any;

const IV = "/app/tables/0/access_control/invitations";
const WS_IV = "/app/workspace/invitations";

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
    { id: "expert", name: "専門家" },
    { id: "anonymous", name: "未ログイン" },
  ];
}

/** `orgs` の付与の宣言。 `invitations` を渡せばそれを10キー目に置く。 */
function orgsAccessControl(options: { invitations?: unknown; enabled?: boolean } = {}): Any {
  return {
    enabled: options.enabled ?? true,
    permissions: [
      { id: "admin", name: "管理", read: true, write: true, delete: true },
      { id: "reader", name: "参照", read: true, write: false, delete: false },
    ],
    creator_permission: "admin",
    grant: { table: "org_grant", target: "org", member: "member", permission: "permission" },
    members: { table: "members", account: "account", group: "team" },
    groups: { table: "teams" },
    ...(options.invitations === undefined ? {} : { invitations: options.invitations }),
  };
}

type Options = {
  orgs?: Any;
  workspace?: Any | null;
  orgFields?: Any[];
  grantFields?: Any[];
  memberFields?: Any[];
};

function manifestWith(options: Options = {}): Manifest {
  const workspace =
    options.workspace === undefined ? { invitations: { label: "招待" } } : options.workspace;
  return {
    app: {
      id: "scs",
      name: "評価",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: options.orgFields ?? [
            { id: "title", name: "名前", type: "text" },
            { id: "team", name: "チーム", type: "reference", reference_table: "teams" },
            { id: "sponsor", name: "後援", type: "reference", reference_table: "members" },
            { id: "memo", name: "メモ", type: "text" },
          ],
          access_control:
            options.orgs ?? orgsAccessControl({ invitations: { grantable: ["reader"] } }),
        },
        {
          id: "org_grant",
          name: "組織の付与",
          fields: options.grantFields ?? [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs", required: true },
            {
              id: "member",
              name: "利用者",
              type: "reference",
              reference_table: "members",
              required: true,
            },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["admin", "reader"],
              required: true,
            },
            { id: "note", name: "備考", type: "text" },
          ],
        },
        {
          id: "members",
          name: "名簿",
          fields: options.memberFields ?? [
            { id: "account", name: "アカウント", type: "text" },
            { id: "team", name: "チーム", type: "reference", reference_table: "teams" },
          ],
        },
        { id: "teams", name: "チーム", fields: [{ id: "title", name: "名前", type: "text" }] },
      ],
      views: [{ id: "org-list", type: "list_view", table: "orgs", columns: ["title"] }],
      roles: roles(),
      ...(workspace === null ? {} : { workspace }),
    },
  } as unknown as Manifest;
}

function withInvitations(invitations: unknown, extra: Omit<Options, "orgs"> = {}): Manifest {
  return manifestWith({ ...extra, orgs: orgsAccessControl({ invitations }) });
}

function errorsOf(result: { valid: boolean; errors?: ValidationError[] }): ValidationError[] {
  return result.valid ? [] : (result.errors ?? []);
}

function diffOf(operations: unknown[], diffId = "iv-1"): unknown {
  return { diff_id: diffId, intent: "招待を宣言する", operations };
}

function invitationsDef(): Any {
  const ac = ((M.table as Any).properties as Any).access_control as Any;
  return ((ac.properties as Any).invitations ?? {}) as Any;
}

function workspaceInvitationsDef(): Any {
  const ws = ((M.app as Any).properties as Any).workspace as Any;
  return ((ws.properties as Any).invitations ?? {}) as Any;
}

function setWorkspaceContainer(): Any {
  const branch = ((D.operation as Any).allOf as Any[]).find(
    (b) => ((((b.if as Any)?.properties ?? {}) as Any).op as Any)?.const === "set_workspace",
  ) as Any;
  return (((branch.then as Any).properties as Any).workspace ?? {}) as Any;
}

/** 罠の汎用文(識別子の規約の汎用 hint・英語の既定文・`anyOf` の言い訳)を1つも含まないこと。 */
function expectNoTrapText(errors: ValidationError[]): void {
  const text = JSON.stringify(errors);
  expect(text).not.toContain("book-tracker");
  expect(text).not.toContain("識別子の規約に合いません");
  expect(text).not.toContain("must ");
  expect(text).not.toContain("anyOf");
  expect(text).not.toContain("詳細不明");
}

// ---------------------------------------------------------------------------------------
// (S) 設計図の形
// ---------------------------------------------------------------------------------------

describe("(S) 設計図の形", () => {
  test("(S-1) access_control の10キー目に invitations があり、中は5キー・grantable だけ必須", () => {
    const ac = ((M.table as Any).properties as Any).access_control as Any;
    const keys = Object.keys(ac.properties as Any);
    expect(keys.length).toBe(10);
    expect(keys[9]).toBe("invitations");
    const def = invitationsDef();
    expect(Object.keys((def.properties ?? {}) as Any)).toEqual([
      "by",
      "grantable",
      "target_roles",
      "expires_days",
      "group_from",
    ]);
    expect(def.required).toEqual(["grantable"]);
    expect(def.additionalProperties).toBe(false);
    // access_control の必須は今日の4本のまま(書かない表は今日と1バイトも変わらない)。
    expect(ac.required).toEqual(["enabled", "permissions", "grant", "creator_permission"]);
  });

  test("(S-2) expires_days は1〜30の整数", () => {
    const expires = ((invitationsDef().properties ?? {}) as Any).expires_days as Any;
    expect(expires?.type).toBe("integer");
    expect(expires?.minimum).toBe(1);
    expect(expires?.maximum).toBe(30);
  });

  test("(S-3) workspace の3キー目に invitations = { label }(label 必須)。set_workspace の器にも在る", () => {
    const ws = ((M.app as Any).properties as Any).workspace as Any;
    expect(Object.keys(ws.properties as Any)).toEqual(["navigation", "my_page", "invitations"]);
    const def = workspaceInvitationsDef();
    expect(def.required).toEqual(["label"]);
    expect(Object.keys((def.properties ?? {}) as Any)).toEqual(["label"]);
    expect(def.additionalProperties).toBe(false);
    const container = setWorkspaceContainer();
    expect(Object.keys((container.properties ?? {}) as Any)).toEqual([
      "navigation",
      "my_page",
      "invitations",
    ]);
  });

  test("(S-4) $defs の名前は増えていない(manifest 31・diff 5)", () => {
    expect(Object.keys(M).length).toBe(31);
    expect(Object.keys(D).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------
// (A) 受け入れと値域
// ---------------------------------------------------------------------------------------

describe("(A) 受け入れと値域", () => {
  test.each([
    ["grantable だけ", { grantable: ["reader"] }],
    [
      "5キー全部",
      {
        by: ["admin"],
        grantable: ["reader", "admin"],
        target_roles: ["member", "expert"],
        expires_days: 30,
        group_from: "team",
      },
    ],
    ["expires_days 1", { grantable: ["reader"], expires_days: 1 }],
  ])("(A-1) %s は通る", (_label, invitations) => {
    const result = validateManifestFull(withInvitations(invitations));
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test.each([
    ["grantable が無い", { by: ["admin"] }],
    ["grantable が空", { grantable: [] }],
    ["6キー目", { grantable: ["reader"], label: "招待" }],
    ["expires_days 0", { grantable: ["reader"], expires_days: 0 }],
    ["expires_days 31", { grantable: ["reader"], expires_days: 31 }],
    ["expires_days が小数", { grantable: ["reader"], expires_days: 1.5 }],
    ["expires_days が文字列", { grantable: ["reader"], expires_days: "7" }],
    ["by が空", { by: [], grantable: ["reader"] }],
    ["by が重複", { by: ["admin", "admin"], grantable: ["reader"] }],
    ["target_roles が空", { grantable: ["reader"], target_roles: [] }],
    ["grantable が文字列", { grantable: "reader" }],
    ["group_from が数値", { grantable: ["reader"], group_from: 1 }],
  ])("(A-2) %s は設計図で断られる(invitations の中を指す)", (_label, invitations) => {
    const result = validateManifestFull(withInvitations(invitations));
    expect(result.valid).toBe(false);
    const paths = errorsOf(result).map((error) => error.path);
    expect(
      paths.some((path) => path.startsWith(IV)),
      JSON.stringify(errorsOf(result)),
    ).toBe(true);
  });

  test("(A-3) 6キー目は allowed_values に5キーを示して断る", () => {
    const result = validateManifestFull(withInvitations({ grantable: ["reader"], label: "招待" }));
    const hit = errorsOf(result).find((error) => error.path === IV);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"label"');
    expect(hit?.allowed_values).toEqual([
      "by",
      "grantable",
      "target_roles",
      "expires_days",
      "group_from",
    ]);
  });

  test("(A-4) workspace.invitations: label が無い・空・3キー目は断る", () => {
    for (const bad of [{}, { label: "" }, { label: "招待", icon: "mail" }]) {
      const result = validateManifestFull(manifestWith({ workspace: { invitations: bad } }));
      expect(result.valid, JSON.stringify(bad)).toBe(false);
      expect(
        errorsOf(result).some((error) => error.path.startsWith(WS_IV)),
        JSON.stringify(errorsOf(result)),
      ).toBe(true);
    }
  });

  test("(A-5) set_workspace の器で invitations を書ける・null で消せる", () => {
    for (const workspace of [
      { invitations: { label: "招待" } },
      { invitations: null },
      { navigation: { placement: "top" }, invitations: { label: "届いた招待" } },
    ]) {
      const result = validateDiff(diffOf([{ op: "set_workspace", workspace }]));
      expect(errorsOf(result), JSON.stringify(workspace)).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  test("(A-6) change_table の access_control でも invitations を書ける", () => {
    const result = validateDiff(
      diffOf([
        {
          op: "change_table",
          table: "orgs",
          changes: {
            access_control: orgsAccessControl({ invitations: { grantable: ["reader"] } }),
          },
        },
      ]),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (T) 文面が罠の汎用文にならない
// ---------------------------------------------------------------------------------------

describe("(T) 文面", () => {
  test("(T-1) 権限名の形に合わない要素は、権限名の書き方を言う(識別子の汎用 hint に落ちない)", () => {
    const result = validateManifestFull(withInvitations({ grantable: ["Read-Only"] }));
    expect(result.valid).toBe(false);
    const errors = errorsOf(result).filter((error) => error.path === `${IV}/grantable/0`);
    expect(errors.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectNoTrapText(errors);
    const text = JSON.stringify(errors);
    expect(text).toContain("アンダースコア");
    expect(text).toContain("32");
  });

  test("(T-2) 役割名の形に合わない target_roles の要素も同じ(役割名と言う)", () => {
    const result = validateManifestFull(
      withInvitations({ grantable: ["reader"], target_roles: ["Member"] }),
    );
    const errors = errorsOf(result).filter((error) => error.path === `${IV}/target_roles/0`);
    expect(errors.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectNoTrapText(errors);
    expect(JSON.stringify(errors)).toContain("役割");
  });

  test.each([
    ["0", 0],
    ["31", 31],
    ["小数", 1.5],
    ["文字列", "7"],
  ])("(T-3) expires_days が %s のときは「1〜30の整数」と日本語で言う", (_label, value) => {
    const result = validateManifestFull(
      withInvitations({ grantable: ["reader"], expires_days: value }),
    );
    const errors = errorsOf(result).filter((error) => error.path === `${IV}/expires_days`);
    expect(errors.length, JSON.stringify(errorsOf(result))).toBe(1);
    expectNoTrapText(errors);
    expect(errors[0]?.message).toContain("1〜30");
  });

  test("(T-4) 重複は英語の既定文に落ちない", () => {
    const result = validateManifestFull(
      withInvitations({ by: ["admin", "admin"], grantable: ["reader"] }),
    );
    const errors = errorsOf(result).filter((error) => error.path.startsWith(`${IV}/by`));
    expect(errors.length, JSON.stringify(errorsOf(result))).toBeGreaterThan(0);
    expectNoTrapText(errors);
  });

  test("(T-5) set_workspace の invitations の誤りは、anyOf の言い訳(null でない等)を見せない", () => {
    const result = validateDiff(
      diffOf([{ op: "set_workspace", workspace: { invitations: { label: 1 } } }]),
    );
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    expectNoTrapText(errors);
    expect(JSON.stringify(errors)).not.toContain("null");
    expect(errors.some((error) => error.path.endsWith("/invitations/label"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (R) 適用時の拒否
// ---------------------------------------------------------------------------------------

describe("(R) 適用時の拒否", () => {
  test("(R-1) by の要素が permissions[].id に無いと断る", () => {
    const result = validateManifestFull(withInvitations({ by: ["boss"], grantable: ["reader"] }));
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${IV}/by/0`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"boss"');
    expect(hit?.allowed_values).toEqual(["admin", "reader"]);
  });

  test("(R-2) grantable の要素が permissions[].id に無いと断る(役割名を書いても断る)", () => {
    const result = validateManifestFull(withInvitations({ grantable: ["reader", "member"] }));
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${IV}/grantable/1`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"member"');
    expect(hit?.allowed_values).toEqual(["admin", "reader"]);
  });

  test("(R-3) target_roles の要素が roles に無いと断る(権限名を書いても断る)", () => {
    const result = validateManifestFull(
      withInvitations({ grantable: ["reader"], target_roles: ["member", "admin"] }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${IV}/target_roles/1`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"admin"');
    expect(hit?.allowed_values).toContain("member");
  });

  test("(R-3b) target_roles に anonymous を書くと、宣言していても理由を付けて断る(V23-M5-T03。D-V23-136)", () => {
    const result = validateManifestFull(
      withInvitations({ grantable: ["reader"], target_roles: ["member", "anonymous"] }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${IV}/target_roles/1`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"anonymous"');
    expect(hit?.message).toContain("ログインしていない人");
    expect(hit?.allowed_values).toContain("member");
    expect(hit?.allowed_values).not.toContain("anonymous");
    // 陰性対照: anonymous を書かなければ通る。
    expect(
      validateManifestFull(withInvitations({ grantable: ["reader"], target_roles: ["member"] }))
        .valid,
    ).toBe(true);
  });

  test("(R-4a) group_from が招待する表の項目に無いと断る", () => {
    const result = validateManifestFull(
      withInvitations({ grantable: ["reader"], group_from: "division" }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${IV}/group_from`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"division"');
  });

  test("(R-4b) group_from が reference 項目でないと断る", () => {
    const result = validateManifestFull(
      withInvitations({ grantable: ["reader"], group_from: "memo" }),
    );
    expect(result.valid).toBe(false);
    expect(
      errorsOf(result).some((error) => error.path === `${IV}/group_from`),
      JSON.stringify(errorsOf(result)),
    ).toBe(true);
  });

  test("(R-4c) group_from がグループの表(groups.table)でない表を指すと断る", () => {
    const result = validateManifestFull(
      withInvitations({ grantable: ["reader"], group_from: "sponsor" }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${IV}/group_from`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"teams"');
  });

  test("(R-4d) groups を宣言していない表で group_from を書くと断る", () => {
    const ac = orgsAccessControl({ invitations: { grantable: ["reader"], group_from: "team" } });
    delete ac.groups;
    ac.members = { table: "members", account: "account" };
    const result = validateManifestFull(manifestWith({ orgs: ac }));
    expect(result.valid).toBe(false);
    expect(
      errorsOf(result).some((error) => error.path === `${IV}/group_from`),
      JSON.stringify(errorsOf(result)),
    ).toBe(true);
  });

  test("(R-4e) members.group が無いと断る(グループの表は宣言していても)", () => {
    const ac = orgsAccessControl({ invitations: { grantable: ["reader"], group_from: "team" } });
    ac.members = { table: "members", account: "account" };
    const result = validateManifestFull(manifestWith({ orgs: ac }));
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${IV}/group_from`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(`${hit?.message}${hit?.hint}`).toContain("members");
  });

  test("(R-5) 付与表に決まった列の外の必須の項目があると断る", () => {
    const result = validateManifestFull(
      withInvitations(
        { grantable: ["reader"] },
        {
          grantFields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs", required: true },
            {
              id: "member",
              name: "利用者",
              type: "reference",
              reference_table: "members",
              required: true,
            },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["admin", "reader"],
              required: true,
            },
            { id: "note", name: "備考", type: "text", required: true },
          ],
        },
      ),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === IV);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"note"');
    expect(hit?.message).toContain('"org_grant"');
  });

  test("(R-5 陰性対照) 付与表の必須が決まった列だけなら通る・招待を書かなければ必須の列があっても今日どおり通る", () => {
    const grantFields = [
      { id: "org", name: "組織", type: "reference", reference_table: "orgs", required: true },
      { id: "member", name: "利用者", type: "reference", reference_table: "members" },
      { id: "permission", name: "権限", type: "select", options: ["admin", "reader"] },
      { id: "note", name: "備考", type: "text", required: true },
    ];
    const result = validateManifestFull(
      manifestWith({ orgs: orgsAccessControl(), workspace: null, grantFields }),
    );
    expect(errorsOf(result)).toEqual([]);
  });

  test("(R-6) 招待を宣言した表があるのに workspace.invitations が無いと断り、「同じ差分で set_workspace も直す」と案内する", () => {
    for (const workspace of [null, { navigation: { placement: "top" } }]) {
      const result = validateManifestFull(
        manifestWith({
          orgs: orgsAccessControl({ invitations: { grantable: ["reader"] } }),
          workspace,
        }),
      );
      expect(result.valid, JSON.stringify(workspace)).toBe(false);
      const hit = errorsOf(result).find((error) => error.path === WS_IV);
      expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
      const text = `${hit?.message ?? ""}${hit?.hint ?? ""}`;
      expect(text).toContain("set_workspace");
      expect(text).toContain("同じ差分");
      expect(text).toContain('"orgs"');
    }
  });

  test("(R-6 陰性対照) enabled: false の表の invitations は数えない", () => {
    const result = validateManifestFull(
      manifestWith({
        orgs: orgsAccessControl({ enabled: false, invitations: { grantable: ["reader"] } }),
        workspace: null,
      }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (F) 畳み込みと適用(差分の経路)
// ---------------------------------------------------------------------------------------

describe("(F) 畳み込みと適用", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-row-invitations-vocab-"));
    const store = KernelMetaStore.open(dataRoot);
    createApp(store, "評価", { app_id: "scs" });
    store.close();
    const applied = applyManifest(
      dataRoot,
      "scs",
      manifestWith({ orgs: orgsAccessControl(), workspace: null }),
    );
    if (!applied.valid) {
      throw new Error(`テスト前提の初期マニフェスト投入に失敗しました: ${JSON.stringify(applied)}`);
    }
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  function apply(operations: unknown[], diffId: string) {
    return applyDiff(dataRoot, "scs", diffOf(operations, diffId));
  }

  function current(): string {
    return JSON.stringify(readCurrentManifest(dataRoot, "scs"));
  }

  const declareOnOrgs = {
    op: "change_table",
    table: "orgs",
    changes: { access_control: orgsAccessControl({ invitations: { grantable: ["reader"] } }) },
  };

  test("(F-1) 表に招待を足すだけの差分は、置き忘れで断られ、定義は1バイトも動かない", () => {
    const before = current();
    const result = apply([declareOnOrgs], "iv-f1");
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === WS_IV);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(`${hit?.message ?? ""}${hit?.hint ?? ""}`).toContain("同じ差分");
    expect(current()).toBe(before);
  });

  test("(F-2) 同じ差分で set_workspace も書けば通る。続けて set_workspace の null で消す差分は断られる", () => {
    const ok = apply(
      [declareOnOrgs, { op: "set_workspace", workspace: { invitations: { label: "招待" } } }],
      "iv-f2a",
    );
    expect(errorsOf(ok)).toEqual([]);
    expect(ok.valid).toBe(true);
    const manifest = readCurrentManifest(dataRoot, "scs") as unknown as Any;
    expect(((manifest.app as Any).workspace as Any)?.invitations).toEqual({ label: "招待" });

    const before = current();
    const removed = apply([{ op: "set_workspace", workspace: { invitations: null } }], "iv-f2b");
    expect(removed.valid).toBe(false);
    const hit = errorsOf(removed).find((error) => error.path === WS_IV);
    expect(hit, JSON.stringify(errorsOf(removed))).toBeDefined();
    expect(`${hit?.message ?? ""}${hit?.hint ?? ""}`).toContain("set_workspace");
    expect(current()).toBe(before);
  });

  test("(F-3) 畳み込みのキーの並びは navigation → my_page → invitations(書いた順に揺れない)", () => {
    const base = manifestWith({ orgs: orgsAccessControl(), workspace: null });
    const folded = foldOperations(base, [
      {
        op: "set_workspace",
        workspace: {
          invitations: { label: "招待" },
          my_page: {},
          navigation: { placement: "top" },
        },
      },
    ] as unknown as Operation[]);
    expect(folded.valid).toBe(true);
    const manifest = (folded as unknown as { manifest: Manifest }).manifest;
    expect(Object.keys(manifest.app.workspace ?? {})).toEqual([
      "navigation",
      "my_page",
      "invitations",
    ]);
  });

  test("(F-4) 招待を書かないアプリ: navigation と my_page の畳み込みの並びは今日と同じ・invitations のキーは生まれない", () => {
    const base = manifestWith({ orgs: orgsAccessControl(), workspace: null });
    const folded = foldOperations(base, [
      { op: "set_workspace", workspace: { my_page: {}, navigation: { placement: "top" } } },
    ] as unknown as Operation[]);
    expect(folded.valid).toBe(true);
    const manifest = (folded as unknown as { manifest: Manifest }).manifest;
    expect(Object.keys(manifest.app.workspace ?? {})).toEqual(["navigation", "my_page"]);
    expect(JSON.stringify(manifest)).not.toContain("invitations");
  });

  test("(F-5) 招待を書かないアプリの定義は今日どおり通る", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsAccessControl(), workspace: null }),
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
