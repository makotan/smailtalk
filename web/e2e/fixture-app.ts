/**
 * E2E 共通のフィクスチャ土台。
 *
 * ここが担うのは2つだけ:
 *
 * 1. **テスト1件ごとに専用のアプリインスタンスを払い出す**(`provisionApp`)。
 *    テスト同士が同じテーブルを共有しないので、あるテストが残したレコードが
 *    別のテストの期待値を壊すことがない。実行順序にも、単体実行か通し実行かにも、
 *    リトライにも依存しない。
 * 2. **7つのフィールド型すべてに対する検証用の値**(`sampleValue` / `buildRecord` /
 *    `ensureReferenceTargets`)。`reference` は「参照先テーブルにレコードを先に1件
 *    作り、その `_id` を使う」形で埋める。required な reference を持つフィクスチャでも
 *    保存が通る。
 *
 * アプリ固有の名前(テーブル名・フィールド名・アプリ名)はここにも一切書かない。
 * 値はすべてフィールドの `id` と `type` から機械的に導く。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type APIRequestContext, type BrowserContext, expect } from "@playwright/test";
import type { Role } from "../../src/auth/types.ts";
import type { Field, Manifest, Table } from "../../src/kernel/types.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** ブラウザがアクセスする port(`playwright.config.ts` と同じ既定値)。cookie の url に使う。 */
const port = Number(process.env.ST_E2E_PORT ?? 3210);

/** 読み込むフィクスチャ。`fixture-server.ts` と同じ既定値でなければならない。 */
export const fixturePath = resolve(
  repoRoot,
  process.env.ST_E2E_FIXTURE ?? "fixtures/valid/inventory-all-field-types.json",
);

/**
 * フィクスチャのマニフェスト。
 *
 * **テーブル・ビュー・フィールドの選定**(どの list_view を検証対象にするか等)は
 * これを見て決めてよい。払い出されたインスタンスとの差は `app.id` と `app.name`
 * だけなので、選定結果はそのまま使える。ただし **URL に載る app_id は必ず
 * `FixtureApp.appId` を使うこと**(こちらの `app.id` は手動確認用のアプリを指す)。
 */
export const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Manifest;

/** 払い出しエンドポイント(`fixture-server.ts` と共有)。 */
const PROVISION_PATH = "/__e2e__/apps";

/** テスト用ログイン前段(`fixture-server.ts` と共有)。返り値は cookie の材料。 */
const sessionPath = (appId: string): string => `/__e2e__/apps/${appId}/session`;

/**
 * **コメントの出し入れを倒す前段**(`fixture-server.ts` と共有。`V10-M31-T03`)。
 * **綴りは向こうの `COMMENT_VISIBILITY_PATH_PATTERN` と1バイトも違ってはならない。**
 */
const commentVisibilityPath = (appId: string): string =>
  `/__e2e__/apps/${appId}/comment-visibility`;

/** テスト1件が専有するアプリインスタンス。 */
export type FixtureApp = {
  /** URL・API パスに使う app_id。 */
  appId: string;
  /** アプリ一覧に出る名前(インスタンスごとに一意)。 */
  appName: string;
  /**
   * このアプリに仕込んだ既定セッションのユーザID(role=owner)。ユーザ管理画面で
   * この owner の行(`data-user-id`)を同定する権限 E2E で使う(V1-M3-T02)。
   */
  userId: string;
  /** 実際に適用されたマニフェスト(`app.id` / `app.name` がインスタンスのもの)。 */
  manifest: Manifest;
  /**
   * このアプリに仕込んだテスト用セッションの Cookie ヘッダ値(`st_session=<id>`)。
   * `request`(ブラウザ context と cookie を共有しない APIRequestContext)から保護 API
   * (records)を叩くとき `headers: app.authHeaders` として渡す。
   */
  sessionCookie: string;
  /** 保護 API を `request` から叩くための Cookie ヘッダ。 */
  authHeaders: { cookie: string };
  /**
   * ブラウザ context にこのアプリのセッション cookie を入れて、per-app 認証ゲートを通す。
   * cookie の Path は `/api/apps/:app_id` なので、他アプリの API には送られない(分離)。
   * これで `page.goto('/apps/:id')` が records の 401 に阻まれず、`page.request` も認証済みになる。
   */
  authenticate(context: BrowserContext): Promise<void>;
  /** レコードを1件作り、その `_id` を返す(このアプリのセッションで認証済みに叩く)。 */
  createRecord(tableId: string, data: Record<string, unknown>): Promise<string>;
  /** テーブル定義を引く(無ければフィクスチャの壊れとして投げる)。 */
  tableOf(tableId: string): Table;
  /**
   * **このアプリのコメントの出し入れを倒す**(`V10-M31-T03`。10メンバ目)。
   *
   * **払い出したままのアプリは OFF である**(製品の既定 = 利用者決定 `D-V10-40`)——
   * **`provisionApp` はこれを1度も呼ばない。** **書く欄を出したいテストが、
   * `page.goto` の**前**に自分で倒す**(設定が読まれるのは `/manifest` を取るときだけである)。
   *
   * **片側だけ渡せる** —— 省いた側は今の値のまま残る(`D-V10-36`)。
   * **返るのは倒した後の実物**(カーネルが `UPDATE` の後に読み直した値)。
   *
   * **【誇張しない】これは書込を止める壁ではない**(`D-V10-38`)—— **`false` に倒しても
   * `POST /api/apps/:app_id/comments` は今日どおり通る。** **止まるのは欄が出ることだけである。**
   */
  setCommentVisibility(patch: {
    write?: boolean;
    read?: boolean;
  }): Promise<{ write: boolean; read: boolean }>;
};

/**
 * このテスト専用のアプリを払い出す。テストの先頭で1回呼ぶ。
 *
 * 返ってくるアプリは**まっさら**である(レコード0件)。他のテストが何をしても、
 * このアプリの中身は変わらない。
 *
 * 併せて **テスト用のセッションを1つ仕込む**(per-app 認証 / ADR-0014 v3)。保護 API
 * (records)は認証必須になったので、`createRecord` も、テスト本体からの `request` 経由の
 * records アクセスも、この cookie で認証する。ブラウザ側は `app.authenticate(context)` を
 * 呼んでゲートを通す(WebAuthn を使わない機能検証を手早くログイン済みにするため)。
 */
export async function provisionApp(request: APIRequestContext): Promise<FixtureApp> {
  const response = await request.post(PROVISION_PATH);
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as {
    app_id: string;
    app_name: string;
    manifest: Manifest;
  };

  // テスト用ログイン前段でセッションを仕込む(cookie 本体はここで組み立てて持ち回る)。
  // role 未指定なので既定 owner(書込・管理ができる)。userId は権限 E2E の行同定に使う。
  const seeded = await request.post(sessionPath(body.app_id));
  expect(seeded.status(), await seeded.text()).toBe(201);
  const cookieSpec = (await seeded.json()) as {
    name: string;
    value: string;
    path: string;
    userId: string;
  };
  const sessionCookie = `${cookieSpec.name}=${cookieSpec.value}`;
  const authHeaders = { cookie: sessionCookie };

  const app: FixtureApp = {
    appId: body.app_id,
    appName: body.app_name,
    userId: cookieSpec.userId,
    manifest: body.manifest,
    sessionCookie,
    authHeaders,
    async authenticate(context) {
      // cookie は URL 由来で domain/secure を導かせる(baseURL の localhost に一致させる)。
      await context.addCookies([
        {
          name: cookieSpec.name,
          value: cookieSpec.value,
          url: `http://localhost:${port}${cookieSpec.path}`,
        },
      ]);
    },
    async createRecord(tableId, data) {
      const created = await request.post(`/api/apps/${body.app_id}/tables/${tableId}/records`, {
        data,
        headers: authHeaders,
      });
      expect(created.status(), await created.text()).toBe(201);
      const record = (await created.json()) as { record: { _id: string } };
      return record.record._id;
    },
    tableOf(tableId) {
      const table = body.manifest.app.tables.find((candidate) => candidate.id === tableId);
      if (table === undefined) {
        throw new Error(`フィクスチャが壊れています: テーブル ${tableId} がありません。`);
      }
      return table;
    },
    async setCommentVisibility(patch) {
      const response = await request.post(commentVisibilityPath(body.app_id), { data: patch });
      expect(response.status(), await response.text()).toBe(200);
      const payload = (await response.json()) as {
        app_id: string;
        comment_visibility: { write: boolean; read: boolean };
      };
      return payload.comment_visibility;
    },
  };
  return app;
}

/** 参照先テーブルID → 先に作っておいた代表レコードの `_id`。 */
export type ReferenceIds = Map<string, string>;

/**
 * 型に沿った検証用の値。**7つの型すべて**を埋める。
 *
 * `index` を変えると値も変わる(ソート順の確認に使う)。`reference` だけは値を
 * 発明できないので、`ensureReferenceTargets` が先に作ったレコードの `_id` を引く。
 * 参照先が用意されていなければ `null`(= 値を入れない)。
 */
export function sampleValue(
  field: Field,
  index: number,
  referenceIds: ReferenceIds,
): string | number | boolean | null {
  switch (field.type) {
    case "text":
    case "long_text":
      return `${field.id}-${index}`;
    case "number":
      return index;
    case "boolean":
      return true;
    case "date":
      return `2026-${String((index % 12) + 1).padStart(2, "0")}-01`;
    case "select":
      return field.options[index % field.options.length] ?? null;
    case "reference":
      return referenceIds.get(field.reference_table) ?? null;
    case "image":
    case "file":
      // image / file はアップロード済み file_id を要する(V2-M2 / ADR-0035 / V5-M16 /
      // ADR-0161)。E2E の合成では実ファイルを用意しないので値を作らない
      // (buildRecord が null フィールドを飛ばす)。
      return null;
  }
}

/** テーブルの全フィールドを埋めたレコード。値を作れないフィールドは入れない。 */
export function buildRecord(
  table: Table,
  index: number,
  referenceIds: ReferenceIds,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const field of table.fields) {
    const value = sampleValue(field, index, referenceIds);
    if (value !== null) {
      record[field.id] = value;
    }
  }
  return record;
}

/**
 * `table` が参照しているテーブルすべてに、代表レコードを1件ずつ作る。
 *
 * 参照先がさらに参照を持つ場合(多段)も先に辿ってから作るので、required な
 * reference が連鎖していても埋まる。循環参照は「先に見たテーブルは作らない」で
 * 打ち切る(v0 の語彙では循環を許すが、値を発明できないため)。
 */
export async function ensureReferenceTargets(
  app: FixtureApp,
  table: Table,
  referenceIds: ReferenceIds = new Map(),
): Promise<ReferenceIds> {
  const visiting = new Set<string>([table.id]);

  const walk = async (current: Table): Promise<void> => {
    for (const field of current.fields) {
      if (field.type !== "reference") {
        continue;
      }
      const targetId = field.reference_table;
      if (referenceIds.has(targetId) || visiting.has(targetId)) {
        continue;
      }
      visiting.add(targetId);
      const target = app.tableOf(targetId);
      await walk(target);
      referenceIds.set(
        targetId,
        await app.createRecord(target.id, buildRecord(target, 0, referenceIds)),
      );
    }
  };

  await walk(table);
  return referenceIds;
}

/** 参照先レコードの表示ラベルに使われるフィールド(一覧・詳細の表示と同じ規則)。 */
export function referenceLabelField(target: Table): Field | undefined {
  return target.fields.find((field) => field.type === "text");
}

/** ロールを指定して仕込んだ追加セッション(権限 E2E / V1-M3-T02)。 */
export type RoleSession = {
  /** 仕込んだユーザのID(ユーザ管理画面の行 `data-user-id` に一致)。 */
  userId: string;
  /** 仕込んだユーザ名。 */
  username: string;
  /** 付与したロール。 */
  role: Role;
  /** このユーザのセッションで保護 API を叩くための Cookie ヘッダ。 */
  authHeaders: { cookie: string };
  /** ブラウザ context にこのユーザのセッション cookie を入れてゲートを通す。 */
  authenticate(context: BrowserContext): Promise<void>;
};

/**
 * 対象アプリに **ロール指定** のユーザ+セッションを追加で仕込む(V1-M3-T02 の権限 E2E)。
 *
 * `provisionApp` が仕込む既定セッションは owner。これに対し本関数は viewer / editor など
 * 任意ロールのユーザを1件足す。`createUser({role})` を直接使うので「初回=owner」ロジックは
 * 通らず、指定した role がそのまま入る(既存 owner とは別ユーザ)。返り値の `userId` で
 * ユーザ管理画面(`user-row` の `data-user-id`)の対象行を同定できる。
 */
export async function seedRoleSession(
  request: APIRequestContext,
  appId: string,
  role: Role,
): Promise<RoleSession> {
  const response = await request.post(sessionPath(appId), { data: { role } });
  expect(response.status(), await response.text()).toBe(201);
  const spec = (await response.json()) as {
    name: string;
    value: string;
    path: string;
    userId: string;
    username: string;
    role: Role;
  };
  return {
    userId: spec.userId,
    username: spec.username,
    role: spec.role,
    authHeaders: { cookie: `${spec.name}=${spec.value}` },
    async authenticate(context) {
      await context.addCookies([
        {
          name: spec.name,
          value: spec.value,
          url: `http://localhost:${port}${spec.path}`,
        },
      ]);
    },
  };
}
