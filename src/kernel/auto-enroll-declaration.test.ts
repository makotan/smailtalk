/**
 * **名簿への自動登録の宣言(`access_control.members.auto_enroll`)の語彙と適用時の拒否**
 * (`V23-M1-T01`。単位 `SC-G1`・`SC-G2`。上位: `docs/adr/0497-auto-enroll-and-last-row-admin.md`
 * の §Decision 1・限定1・限定2、`docs/adr/0510-v23-m1-guard-authorization-and-pre-start-decisions.md`
 * の §Decision 1、計画 `docs/plan/v23/00-v23-plan.md` §4 の M1-A「語彙の形」)。
 *
 * ## このファイルが測るもの
 *
 * - (A) 受け入れ: 最小形(`roles` だけ)と `name` 付き。 値域(`roles` は空でない・重複なし・
 *   中は2キーで閉じる)。
 * - (R) 適用時の拒否1〜7 を1本ずつ(計画 M1-A の番号どおり)。 拒否5〜7 は差分を当てて測る。
 * - (U) 宣言を外すと定義が宣言前と1バイトも違わない / `undo` で戻る。
 *
 * ## このファイルが測らないもの
 *
 * - 一意索引・埋め戻し・登録(`src/server/auto-enroll-apply.test.ts`・`src/server/auto-enroll.test.ts`)。
 * - MCP と HTTP の口(このファイルはカーネルの `applyDiff` を直接呼ぶ)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { createRecord } from "./records.ts";
import { appDbPath } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";
import { undo } from "./undo.ts";
import { validateManifestFull } from "./validate.ts";

type Any = Record<string, unknown>;

const APP_ID = "scs";

const OWNER_RULES: Any[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

function roles(): Any[] {
  return [
    { id: "owner", name: "運営", rules: structuredClone(OWNER_RULES) },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
    { id: "member", name: "会員" },
    { id: "expert", name: "専門家" },
    { id: "anonymous", name: "未ログイン" },
  ];
}

/** `orgs` の付与の宣言(`auto_enroll` を書かない形)。 */
function orgsAccessControl(
  members: Any = { table: "members", account: "account", group: "team" },
): Any {
  return {
    enabled: true,
    permissions: [
      { id: "admin", name: "管理", read: true, write: true, delete: true },
      { id: "reader", name: "参照", read: true, write: false, delete: false },
    ],
    creator_permission: "admin",
    grant: { table: "org_grant", target: "org", member: "member", permission: "permission" },
    members,
    groups: { table: "teams" },
  };
}

/** `projects` の付与の宣言(同じ名簿の表を指す2つ目の宣言。拒否4 の題材)。 */
function projectsAccessControl(members: Any = { table: "members", account: "account" }): Any {
  return {
    enabled: true,
    permissions: [{ id: "admin", name: "管理", read: true, write: true, delete: true }],
    creator_permission: "admin",
    grant: {
      table: "project_grant",
      target: "project",
      member: "member",
      permission: "permission",
    },
    members,
  };
}

function manifestWith(
  options: { orgs?: Any; projects?: Any; accountType?: string } = {},
): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "評価",
      tables: [
        {
          id: "orgs",
          name: "組織",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: options.orgs ?? orgsAccessControl(),
        },
        {
          id: "projects",
          name: "案件",
          fields: [{ id: "title", name: "名前", type: "text" }],
          ...(options.projects === undefined ? {} : { access_control: options.projects }),
        },
        {
          id: "org_grant",
          name: "組織の付与",
          fields: [
            { id: "org", name: "組織", type: "reference", reference_table: "orgs" },
            { id: "member", name: "利用者", type: "reference", reference_table: "members" },
            { id: "permission", name: "権限", type: "select", options: ["admin", "reader"] },
          ],
        },
        {
          id: "project_grant",
          name: "案件の付与",
          fields: [
            { id: "project", name: "案件", type: "reference", reference_table: "projects" },
            { id: "member", name: "利用者", type: "reference", reference_table: "members" },
            { id: "permission", name: "権限", type: "select", options: ["admin"] },
          ],
        },
        {
          id: "members",
          name: "名簿",
          fields: [
            { id: "account", name: "アカウント", type: options.accountType ?? "text" },
            { id: "display_name", name: "表示名", type: "text" },
            { id: "age", name: "年齢", type: "number" },
            { id: "team", name: "チーム", type: "reference", reference_table: "teams" },
          ],
        },
        { id: "teams", name: "チーム", fields: [{ id: "title", name: "名前", type: "text" }] },
      ],
      views: [{ id: "org-list", type: "list_view", table: "orgs", columns: ["title"] }],
      roles: roles(),
    },
  } as unknown as Manifest;
}

function orgsWithAutoEnroll(autoEnroll: unknown): Any {
  return orgsAccessControl({
    table: "members",
    account: "account",
    group: "team",
    auto_enroll: autoEnroll,
  });
}

function errorsOf(result: { valid: boolean; errors?: ValidationError[] }): ValidationError[] {
  return result.valid ? [] : (result.errors ?? []);
}

const AE = "/app/tables/0/access_control/members/auto_enroll";

// ---------------------------------------------------------------------------------------
// (A) 受け入れと値域
// ---------------------------------------------------------------------------------------

describe("(A) 受け入れと値域", () => {
  test("(A-1) 最小形(roles だけ)は通る", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsWithAutoEnroll({ roles: ["member"] }) }),
    );
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  test("(A-2) name 付き(roles 2つ・name は名簿の text 列)は通る", () => {
    const result = validateManifestFull(
      manifestWith({
        orgs: orgsWithAutoEnroll({ roles: ["member", "expert"], name: "display_name" }),
      }),
    );
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  test("(A-3) roles が空の配列・要素の重複・roles の欠落・3つ目のキーは、スキーマで断られる", () => {
    for (const bad of [
      { roles: [] },
      { roles: ["member", "member"] },
      { name: "display_name" },
      { roles: ["member"], group: "team" },
    ]) {
      const result = validateManifestFull(manifestWith({ orgs: orgsWithAutoEnroll(bad) }));
      expect(result.valid, JSON.stringify(bad)).toBe(false);
      // **どれも auto_enroll の中(か auto_enroll そのもの)を指す** —— members に
      // auto_enroll が無いことによる「未知のプロパティ」の断りではないことを見る。
      const paths = errorsOf(result).map((error) => error.path);
      expect(
        paths.some((path) => path.startsWith(AE)),
        JSON.stringify(errorsOf(result)),
      ).toBe(true);
    }
  });

  test("(A-4) 陰性対照: auto_enroll を書かない宣言は今日どおり通る", () => {
    const result = validateManifestFull(manifestWith());
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (R) 適用時の拒否1〜4(定義だけで決まるもの)
// ---------------------------------------------------------------------------------------

describe("(R) 適用時の拒否(定義だけで決まるもの)", () => {
  test("(R-1a) 拒否1: roles の要素が app.roles[].id に無いと断られる", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsWithAutoEnroll({ roles: ["member", "boss"] }) }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${AE}/roles/1`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"boss"');
    expect(hit?.allowed_values).toEqual(["owner", "editor", "viewer", "member", "expert"]);
  });

  test("(R-1b) 拒否1: roles の要素が anonymous だと断られる(宣言されていても)", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsWithAutoEnroll({ roles: ["anonymous"] }) }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${AE}/roles/0`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain("anonymous");
  });

  test("(R-2a) 拒否2: name が名簿の表に実在しない列だと断られる", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsWithAutoEnroll({ roles: ["member"], name: "nickname" }) }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${AE}/name`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"nickname"');
  });

  test("(R-2b) 拒否2: name が text 型でない列だと断られる", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsWithAutoEnroll({ roles: ["member"], name: "age" }) }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === `${AE}/name`);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
  });

  test("(R-2c) 拒否2: name が account・group の列と同じだと断られる", () => {
    for (const column of ["account", "team"]) {
      const result = validateManifestFull(
        manifestWith({ orgs: orgsWithAutoEnroll({ roles: ["member"], name: column }) }),
      );
      expect(result.valid, column).toBe(false);
      const hit = errorsOf(result).find((error) => error.path === `${AE}/name`);
      expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    }
  });

  test("(R-3) 拒否3: account の列が text 型でないと断られる", () => {
    const result = validateManifestFull(
      manifestWith({ orgs: orgsWithAutoEnroll({ roles: ["member"] }), accountType: "number" }),
    );
    expect(result.valid).toBe(false);
    const errors = errorsOf(result);
    const hit = errors.find(
      (error) => error.path === "/app/tables/0/access_control/members/account",
    );
    expect(hit, JSON.stringify(errors)).toBeDefined();
    // **スキーマの断り(auto_enroll が未知のキー)ではないこと。**
    expect(errors.some((error) => error.path === "/app/tables/0/access_control/members")).toBe(
      false,
    );
  });

  test("(R-4a) 拒否4: 同じ名簿の表を指す2つの宣言で auto_enroll の中身が食い違うと断られる", () => {
    const result = validateManifestFull(
      manifestWith({
        orgs: orgsWithAutoEnroll({ roles: ["member"] }),
        projects: projectsAccessControl({
          table: "members",
          account: "account",
          auto_enroll: { roles: ["expert"] },
        }),
      }),
    );
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find(
      (error) => error.path === "/app/tables/1/access_control/members/auto_enroll",
    );
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"members"');
  });

  test("(R-4b) 拒否4 の陰性対照: 片方だけが書く・同じ中身を両方が書くのは通る", () => {
    const oneSide = validateManifestFull(
      manifestWith({
        orgs: orgsWithAutoEnroll({ roles: ["member"], name: "display_name" }),
        projects: projectsAccessControl(),
      }),
    );
    expect(oneSide.valid, JSON.stringify(oneSide)).toBe(true);
    const same = validateManifestFull(
      manifestWith({
        orgs: orgsWithAutoEnroll({ roles: ["member"], name: "display_name" }),
        projects: projectsAccessControl({
          table: "members",
          account: "account",
          auto_enroll: { roles: ["member"], name: "display_name" },
        }),
      }),
    );
    expect(same.valid, JSON.stringify(same)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// (D) 差分を当てて測る拒否5〜7 と、外す・undo
// ---------------------------------------------------------------------------------------

describe("(D) 差分を当てて測る", () => {
  let dataRoot: string;
  let store: KernelMetaStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-auto-enroll-decl-"));
    store = KernelMetaStore.open(dataRoot);
    createApp(store, "評価", { app_id: APP_ID });
    const applied = applyManifest(dataRoot, APP_ID, manifestWith());
    if (!applied.valid) {
      throw new Error(`初期マニフェストの投入に失敗: ${JSON.stringify(applied.errors)}`);
    }
  });

  afterEach(async () => {
    store.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  function declareDiff(diffId: string, autoEnroll: unknown): Diff {
    return {
      diff_id: diffId,
      intent: "名簿への自動登録を宣言する",
      operations: [
        {
          op: "change_table",
          table: "orgs",
          changes: { access_control: orgsWithAutoEnroll(autoEnroll) },
        },
      ],
    } as unknown as Diff;
  }

  function declareAutoEnroll(): void {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      declareDiff("d-declare", { roles: ["member", "expert"], name: "display_name" }),
    );
    if (!result.valid) {
      throw new Error(`宣言の適用に失敗: ${JSON.stringify(result.errors)}`);
    }
  }

  function manifestJson(): string {
    return JSON.stringify(readCurrentManifest(dataRoot, APP_ID));
  }

  test("(D-0) 宣言は change_table で足せる(差分操作を増やさない)", () => {
    const result = applyDiff(
      dataRoot,
      APP_ID,
      declareDiff("d-declare", { roles: ["member"], name: "display_name" }),
    );
    expect(result.valid, JSON.stringify(result)).toBe(true);
    const members = (
      readCurrentManifest(dataRoot, APP_ID).app.tables[0] as unknown as {
        access_control: { members: Any };
      }
    ).access_control.members;
    expect(members.auto_enroll).toEqual({ roles: ["member"], name: "display_name" });
  });

  test("(R-5) 拒否5: set_roles で auto_enroll.roles が指す役割を消す差分は、差分全体が断られ、change_table も直すよう案内される", () => {
    declareAutoEnroll();
    const before = manifestJson();
    const withoutExpert = roles().filter((role) => role.id !== "expert");
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-drop-expert",
      intent: "専門家の役割を消す",
      operations: [{ op: "set_roles", roles: withoutExpert }],
    } as unknown as Diff);
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path.includes("auto_enroll/roles/"));
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.hint).toContain("change_table");
    expect(manifestJson()).toBe(before);

    // **同じ差分で change_table も直せば通る**(`D-V22-13` と同じ扱い)。
    const fixed = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-drop-expert-2",
      intent: "専門家の役割を消し、自動登録からも外す",
      operations: [
        { op: "set_roles", roles: withoutExpert },
        {
          op: "change_table",
          table: "orgs",
          changes: {
            access_control: orgsWithAutoEnroll({ roles: ["member"], name: "display_name" }),
          },
        },
      ],
    } as unknown as Diff);
    expect(fixed.valid, JSON.stringify(fixed)).toBe(true);
  });

  test("(R-6a) 拒否6: remove_field で name の列を消す差分は断られる", () => {
    declareAutoEnroll();
    const before = manifestJson();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-remove-name",
      intent: "表示名の列を消す",
      operations: [{ op: "remove_field", table: "members", field: "display_name" }],
    } as unknown as Diff);
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path.endsWith("auto_enroll/name"));
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(manifestJson()).toBe(before);
  });

  test("(R-6b) 拒否6: change_field で name の列の型を変える差分は断られる", () => {
    declareAutoEnroll();
    const before = manifestJson();
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-retype-name",
      intent: "表示名の列を数にする",
      operations: [
        {
          op: "change_field",
          table: "members",
          field: "display_name",
          changes: { type: "number" },
        },
      ],
    } as unknown as Diff);
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path.endsWith("auto_enroll/name"));
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(manifestJson()).toBe(before);
  });

  test("(R-6c) 拒否6: account の列を消す・型を変える差分は断られる", () => {
    declareAutoEnroll();
    const before = manifestJson();
    const removed = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-remove-account",
      intent: "アカウントの列を消す",
      operations: [{ op: "remove_field", table: "members", field: "account" }],
    } as unknown as Diff);
    expect(removed.valid).toBe(false);
    const retyped = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-retype-account",
      intent: "アカウントの列を数にする",
      operations: [
        { op: "change_field", table: "members", field: "account", changes: { type: "number" } },
      ],
    } as unknown as Diff);
    expect(retyped.valid).toBe(false);
    expect(
      errorsOf(retyped).some((error) => error.path.endsWith("members/account")),
      JSON.stringify(errorsOf(retyped)),
    ).toBe(true);
    expect(manifestJson()).toBe(before);
  });

  test("(R-7) 拒否7: 名簿の account 列に既に重複があると、宣言の差分全体が断られ、重複の件数が出る", () => {
    const db = new Database(appDbPath(dataRoot, APP_ID));
    try {
      const manifest = readCurrentManifest(dataRoot, APP_ID);
      for (const account of ["u-1", "u-1", "u-2"]) {
        const created = createRecord(db, manifest, "members", { account });
        if (!created.ok) {
          throw new Error(JSON.stringify(created));
        }
      }
    } finally {
      db.close();
    }
    const before = manifestJson();
    const result = applyDiff(dataRoot, APP_ID, declareDiff("d-declare-dup", { roles: ["member"] }));
    expect(result.valid).toBe(false);
    const hit = errorsOf(result).find((error) => error.path === AE);
    expect(hit, JSON.stringify(errorsOf(result))).toBeDefined();
    expect(hit?.message).toContain('"u-1"(2 件)');
    expect(manifestJson()).toBe(before);
  });

  test("(R-7b) 拒否7 の陰性対照: 重複があっても auto_enroll を書かない差分は今日どおり通る", () => {
    const db = new Database(appDbPath(dataRoot, APP_ID));
    try {
      const manifest = readCurrentManifest(dataRoot, APP_ID);
      for (const account of ["u-1", "u-1"]) {
        const created = createRecord(db, manifest, "members", { account });
        if (!created.ok) {
          throw new Error(JSON.stringify(created));
        }
      }
    } finally {
      db.close();
    }
    const result = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-plain",
      intent: "名簿に列を足す",
      operations: [
        { op: "add_field", table: "members", field: { id: "memo", name: "メモ", type: "text" } },
      ],
    } as unknown as Diff);
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  test("(U-1) auto_enroll を外すと、定義が宣言前と1バイトも違わない", () => {
    const before = manifestJson();
    declareAutoEnroll();
    expect(manifestJson()).not.toBe(before);
    const removed = applyDiff(dataRoot, APP_ID, {
      diff_id: "d-undeclare",
      intent: "名簿への自動登録をやめる",
      operations: [
        { op: "change_table", table: "orgs", changes: { access_control: orgsAccessControl() } },
      ],
    } as unknown as Diff);
    expect(removed.valid, JSON.stringify(removed)).toBe(true);
    expect(manifestJson()).toBe(before);
  });

  test("(U-2) undo で宣言の前に戻る", () => {
    const before = manifestJson();
    declareAutoEnroll();
    expect(manifestJson()).not.toBe(before);
    const undone = undo(dataRoot, APP_ID);
    expect(undone.valid, JSON.stringify(undone)).toBe(true);
    expect(manifestJson()).toBe(before);
  });
});
