/**
 * 変更系 HTTP API の統合テスト(V0-P4-T06 / ADR-0003 §4「Phase 4 での変更」)。
 *
 * apply_diff / undo / preview_undo / changelog取得 を HTTP に載せた4本について、
 * 正常系・異常系を `request()`(実ポートを開かない)で確認する。
 *
 * このファイルが確かめたい性質は2つある。
 *
 * 1. **サーバ層はカーネルへの薄い委譲でしかない。** ステータスとボディの対応、
 *    エラーの統一形式(`{ errors: [ValidationError] }`)、そして**カーネルの
 *    エラー文面がサーバ層で書き換えられていない**こと。
 * 2. **稼働中のアプリに反映される。** apply した結果が、**同じ Hono インスタンス**への
 *    次の GET マニフェストにもう現れること(= マニフェストをプロセス内に抱えていない)。
 *    そのため `app` はテストごとに1回だけ作り、apply/undo を跨いで作り直さない。
 *
 * テストデータは毎回 `fs.mkdtemp` の一時ディレクトリに作るので、リポジトリの
 * `data/` には一切触れない。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyManifest,
  type ChangelogEntry,
  createApp,
  type Diff,
  KernelMetaStore,
  type Manifest,
  type Table,
  UNDO_PREVIEW_NOTE,
  type ValidationError,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { authed, seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "change-api";
const OTHER_APP_ID = "untouched";

/** 出発点のマニフェスト。テーブル1つ・list_view 1つの最小構成。 */
function baseManifest(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: "変更API確認",
      tables: [
        {
          id: "base-table",
          name: "基本テーブル",
          fields: [{ id: "title", name: "見出し", type: "text", required: true }],
        },
      ],
      views: [{ id: "base-list", type: "list_view", table: "base-table", columns: ["title"] }],
    },
  };
}

const base = baseManifest(APP_ID);
const baseTable = base.app.tables[0] as Table;
const baseView = base.app.views[0] as { id: string; columns: string[] };

/** 追加フィールドと、それを既存 list_view の列に足す差分(CP-4 の diff#2 の形)。 */
const ADDED_FIELD = { id: "note", name: "メモ", type: "long_text" } as const;

function addFieldDiff(diffId: string): Diff {
  return {
    diff_id: diffId,
    intent: "一覧でメモを見たいという要望に応えて、メモ欄を足した",
    operations: [
      { op: "add_field", table: baseTable.id, field: { ...ADDED_FIELD } },
      {
        op: "update_view",
        view: baseView.id,
        changes: { columns: [...baseView.columns, ADDED_FIELD.id] },
      },
    ],
  };
}

const diffsPath = (appId: string = APP_ID) => `/api/apps/${appId}/diffs`;
const undoPath = (appId: string = APP_ID) => `/api/apps/${appId}/undo`;
const previewPath = (appId: string = APP_ID) => `/api/apps/${appId}/undo/preview`;
const changelogPath = (appId: string = APP_ID) => `/api/apps/${appId}/changelog`;
const manifestPath = (appId: string = APP_ID) => `/api/apps/${appId}/manifest`;
const recordsPath = `/api/apps/${APP_ID}/tables/${baseTable.id}/records`;

let dataRoot: string;
/** サーバインスタンスは1テストにつき1回だけ作る。作り直さないことが要。 */
let app: ReturnType<typeof createServerApp>;
/** 認証境界(ADR-0014)を通すためのセッション cookie。 */
let cookie: string;
/**
 * **巻き添え確認アプリ側のセッション cookie**(`V8-M21` / `J-G24a` / `D-V8-21`)。
 *
 * **セッションはアプリごとに独立している**(`ADR-0014` v3)。**`GET /manifest` が
 * 今日からログインを要求するので、別アプリのマニフェストを読むにはそのアプリの
 * セッションが要る。** **足したのは cookie 1本だけで、期待値は1つも緩めていない。**
 */
let otherCookie: string;

/** cookie/Origin 付きで `app.request` する(認証境界の手前を通す)。 */
function request(input: string | Request, init?: RequestInit): Response | Promise<Response> {
  return app.request(authed(cookie)(input, init));
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function errorsOf(response: Response): Promise<ValidationError[]> {
  const body = await json(response);
  expect(Array.isArray(body.errors)).toBe(true);
  expect(Object.keys(body)).toEqual(["errors"]);
  return body.errors as ValidationError[];
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: TEST_ORIGIN },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function currentManifest(appId: string = APP_ID): Promise<Manifest> {
  // **【`V8-M21`】アプリごとに独立したセッションを使う**(上の `otherCookie` の doc)。
  const response = await app.request(
    authed(appId === APP_ID ? cookie : otherCookie)(manifestPath(appId)),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Manifest;
}

async function currentChangelog(appId: string = APP_ID): Promise<ChangelogEntry[]> {
  const response = await request(changelogPath(appId));
  expect(response.status).toBe(200);
  const body = await json(response);
  return body.changelog as ChangelogEntry[];
}

/** apply を1回通して、そのレスポンスボディを返す。 */
async function applyOk(diff: Diff): Promise<Record<string, unknown>> {
  const response = await request(post(diffsPath(), diff));
  const text = await response.text();
  expect(response.status, text).toBe(201);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-change-api-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, base.app.name, { app_id: APP_ID });
    createApp(store, "巻き添え確認", { app_id: OTHER_APP_ID });
  } finally {
    store.close();
  }
  for (const appId of [APP_ID, OTHER_APP_ID]) {
    // **【`V8-M26`】出発点の題材に既定3役割の規則を足す** —— **`applyManifest` を直接呼ぶ
    // 経路は `apply-diff.ts` の自動付与を通らない。** **判定は1バイトも緩めていない。**
    // **undo の検査もこれで成り立つ** —— **戻り先はこの規則付きの題材なので、undo 後に
    // 「新フィールドは書けない(400)」を今日どおり測れる。**
    const applied = applyManifest(dataRoot, appId, withDefaultRoleRules(baseManifest(appId)));
    expect(applied.valid).toBe(true);
  }
  app = createServerApp({ dataRoot });
  cookie = seedSession(dataRoot, APP_ID).cookie;
  otherCookie = seedSession(dataRoot, OTHER_APP_ID).cookie;
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("POST /api/apps/:app_id/diffs(apply_diff)", () => {
  test("差分を適用すると 201 を返し、同じインスタンスへの GET マニフェストに新フィールドが現れる", async () => {
    // 適用前: 新フィールドはどこにもない。
    const before = await currentManifest();
    expect((before.app.tables[0] as Table).fields.map((f) => f.id)).not.toContain(ADDED_FIELD.id);

    const body = await applyOk(addFieldDiff("add-note"));

    // 返るのは単一キー `change` に包んだ適用結果(ADR-0003 §3)。
    expect(Object.keys(body)).toEqual(["change"]);
    const change = body.change as {
      manifest: Manifest;
      plan: { steps?: unknown };
      snapshot: string;
      entry: ChangelogEntry;
    };
    expect((change.manifest.app.tables[0] as Table).fields.map((f) => f.id)).toContain(
      ADDED_FIELD.id,
    );
    expect(change.entry.intent).toBe(addFieldDiff("add-note").intent);
    expect(change.entry.kind).toBe("apply");
    expect(typeof change.snapshot).toBe("string");

    // **サーバを作り直していない**のに、次の GET でもう新しいマニフェストが返る。
    const after = await currentManifest();
    const afterTable = after.app.tables[0] as Table;
    expect(afterTable.fields.map((f) => f.id)).toContain(ADDED_FIELD.id);
    expect((after.app.views[0] as { columns: string[] }).columns).toContain(ADDED_FIELD.id);

    // スキーマも追随している(さっきまで書けなかった列に書ける)。
    const created = await request(
      post(recordsPath, { title: "見出し", [ADDED_FIELD.id]: "メモ本文" }),
    );
    expect(created.status).toBe(201);
    expect((await json(created)).record).toHaveProperty(ADDED_FIELD.id, "メモ本文");
  });

  test("破壊的な op は 400 で拒否され、状態は1バイトも変わらない", async () => {
    const before = await currentManifest();
    // V1-M0-T05: createApp の第0行があるので changelog は [] ではない。
    // 「1件も増えない」ことを見たいので before/after 比較に直す。
    const changelogBefore = await currentChangelog();

    const response = await request(
      post(diffsPath(), {
        diff_id: "drop-field",
        intent: "使わない項目を消したい",
        operations: [{ op: "remove_field", table: baseTable.id, field: "title" }],
      }),
    );
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.path).toBeDefined();

    // 状態不変: マニフェストも履歴も動いていない。
    expect(await currentManifest()).toEqual(before);
    expect(await currentChangelog()).toEqual(changelogBefore);
  });

  test("現行マニフェストに対して成立しない差分は 400 で、カーネルの文面がそのまま返る", async () => {
    // V1-M0-T05: createApp の第0行があるので changelog は [] ではない。before/after で見る。
    const changelogBefore = await currentChangelog();
    const response = await request(
      post(diffsPath(), {
        diff_id: "dup-field",
        intent: "同じIDのフィールドをもう一度足す",
        operations: [
          {
            op: "add_field",
            table: baseTable.id,
            field: { id: "title", name: "重複", type: "text" },
          },
        ],
      }),
    );
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    // カーネル(foldOperations)が出す path と文面をサーバ層で作り直していないこと。
    expect(errors[0]?.path).toBe("/operations/0/field/id");
    expect(errors[0]?.message).toContain("title");
    expect(await currentChangelog()).toEqual(changelogBefore);
  });

  test("ボディが JSON として読めなければ 400(統一形式)", async () => {
    // V1-M0-T05: createApp の第0行があるので changelog は [] ではない。before/after で見る。
    const changelogBefore = await currentChangelog();
    const response = await request(post(diffsPath(), "{ これは JSON ではない"));
    expect(response.status).toBe(400);
    expect((await errorsOf(response)).length).toBe(1);
    expect(await currentChangelog()).toEqual(changelogBefore);
  });

  test("必須項目(intent)を欠く差分は 400", async () => {
    // V1-M0-T05: createApp の第0行があるので changelog は [] ではない。before/after で見る。
    const changelogBefore = await currentChangelog();
    const response = await request(
      post(diffsPath(), {
        diff_id: "no-intent",
        operations: [{ op: "add_field", table: baseTable.id, field: { ...ADDED_FIELD } }],
      }),
    );
    expect(response.status).toBe(400);
    expect((await errorsOf(response)).length).toBeGreaterThan(0);
    expect(await currentChangelog()).toEqual(changelogBefore);
  });

  test("存在しないアプリへの apply は 404", async () => {
    const response = await request(post(diffsPath("no-such-app"), addFieldDiff("x")));
    expect(response.status).toBe(404);
    const errors = await errorsOf(response);
    expect(errors[0]?.allowed_values).toContain(APP_ID);
  });
});

describe("POST /api/apps/:app_id/undo", () => {
  test("undo するとマニフェストが差分適用前に戻る", async () => {
    const before = await currentManifest();
    await applyOk(addFieldDiff("add-note"));
    expect((await currentManifest()).app.tables[0]).not.toEqual(before.app.tables[0]);

    const response = await request(post(undoPath(), null));
    const body = await json(response);
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(Object.keys(body)).toEqual(["undo"]);
    const result = body.undo as { manifest: Manifest; entry: ChangelogEntry };
    expect(result.entry.kind).toBe("undo");
    // **旧行(逐語)**: `expect(result.manifest).toEqual(before);`
    // **【`V10-M31-T01`】** `before` は `currentManifest()`(= `GET /api/apps/:app_id/manifest`
    // の応答)で、**`V10-M31-T01` から兄弟キー `comment_visibility` が載る**。一方
    // `result.manifest` は `POST /undo` の応答が返す**素のマニフェスト**(`{ app }` だけ)で、
    // そこには1バイトも足していない。ここで見たいのは**定義が差分適用前に戻ったこと**なので、
    // `app` の中身どうしで突き合わせる。
    expect(result.manifest).toEqual({ app: before.app });

    // 同じインスタンスへの次の GET でもう戻っている。
    expect(await currentManifest()).toEqual(before);

    // 新フィールドは書けなくなる(スキーマも戻っている)。
    const rejected = await request(
      post(recordsPath, { title: "見出し", [ADDED_FIELD.id]: "メモ" }),
    );
    expect(rejected.status).toBe(400);
  });

  test("取り消せる変更がなければ 400(カーネルの文面のまま)", async () => {
    const response = await request(post(undoPath(), null));
    expect(response.status).toBe(400);
    const errors = await errorsOf(response);
    expect(errors[0]?.message).toContain("取り消せる変更がありません");
  });

  test("存在しないアプリへの undo は 404", async () => {
    const response = await request(post(undoPath("no-such-app"), null));
    expect(response.status).toBe(404);
    expect((await errorsOf(response)).length).toBe(1);
  });
});

describe("GET /api/apps/:app_id/undo/preview(preview_undo)", () => {
  test("参照系なので GET で引け、状態を1バイトも変えない", async () => {
    await applyOk(addFieldDiff("add-note"));
    const manifestBefore = await currentManifest();
    const changelogBefore = await currentChangelog();

    const response = await request(previewPath());
    const body = await json(response);
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(Object.keys(body)).toEqual(["preview"]);
    const preview = body.preview as {
      diff_id: string;
      intent: string;
      operations: unknown[];
      note: string;
    };
    expect(preview.diff_id).toBe("add-note");
    expect(preview.intent).toBe(addFieldDiff("add-note").intent);
    expect(preview.operations.length).toBe(2);
    // 件数に現れない喪失があることの定型文をサーバ層で落とさない(ADR-0004 §6)。
    expect(preview.note).toBe(UNDO_PREVIEW_NOTE);

    // 2回引いても、マニフェストも履歴も変わらない。
    expect((await request(previewPath())).status).toBe(200);
    expect(await currentManifest()).toEqual(manifestBefore);
    expect(await currentChangelog()).toEqual(changelogBefore);
  });

  test("POST では引けない(参照系を実行系と同居させない)", async () => {
    await applyOk(addFieldDiff("add-note"));
    const response = await request(post(previewPath(), null));
    expect(response.status).toBe(404);
    expect((await errorsOf(response)).length).toBe(1);
    // 履歴は動いていない(POST が undo として実行されてしまっていない)。
    // createApp の第0行(1件)+ addFieldDiff の apply(1件)で2件のまま。
    expect((await currentChangelog()).length).toBe(2);
  });

  test("取り消せる変更がなければ 400", async () => {
    const response = await request(previewPath());
    expect(response.status).toBe(400);
    expect((await errorsOf(response))[0]?.message).toContain("取り消せる変更がありません");
  });

  test("存在しないアプリへの preview は 404", async () => {
    const response = await request(previewPath("no-such-app"));
    expect(response.status).toBe(404);
    expect((await errorsOf(response)).length).toBe(1);
  });
});

describe("GET /api/apps/:app_id/changelog", () => {
  test("apply と undo が時系列で、intent 付きで返る", async () => {
    // V1-M0-T05: createApp が書く「第0行」(_create-app)が最初から1件見えている。
    // このエンドポイントが「画面に出す」経路そのものなので、内容まで明示的に確かめる。
    const initial = await currentChangelog();
    expect(initial).toHaveLength(1);
    expect(initial[0]?.diff_id).toBe("_create-app");
    expect(initial[0]?.intent).toBe(
      `アプリ「${base.app.name}」を作成した(create_app)。この行はカーネルが記録したもので、ユーザの発話ではない。`,
    );
    expect(initial[0]?.kind).toBe("apply");

    await applyOk(addFieldDiff("add-note"));
    await applyOk({
      diff_id: "add-view",
      intent: "メモだけを並べた画面が欲しいという要望に応えた",
      operations: [
        {
          op: "add_view",
          view: {
            id: "note-list",
            type: "list_view",
            table: baseTable.id,
            columns: [ADDED_FIELD.id],
          },
        },
      ],
    });
    expect((await request(post(undoPath(), null))).status).toBe(200);

    const entries = await currentChangelog();
    expect(entries.map((entry) => entry.diff_id)).toEqual([
      "_create-app",
      "add-note",
      "add-view",
      "undo-add-view",
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["apply", "apply", "apply", "undo"]);
    // seq は昇順(時系列)。
    expect(entries.map((entry) => entry.seq)).toEqual(
      [...entries.map((e) => e.seq)].sort((a, b) => a - b),
    );
    // どのエントリにも意図が読める(憲法5: changelog が要件定義書)。
    for (const entry of entries) {
      expect(entry.intent.length).toBeGreaterThan(0);
    }
    // undo エントリは取り消した apply を指している。
    expect(entries[3]?.undo_target_seq).toBe(entries[2]?.seq ?? -1);
  });

  test("他のアプリの履歴は混ざらない", async () => {
    await applyOk(addFieldDiff("add-note"));
    const otherChangelog = await currentChangelog(OTHER_APP_ID);
    // OTHER_APP_ID 側は diff を適用していないが、createApp の第0行だけは見える。
    // 「混ざらない」とは「向こうの add-note が見えない」ことであって、
    // 「向こう自身の第0行も無い」ことではない。
    expect(otherChangelog).toHaveLength(1);
    expect(otherChangelog[0]?.diff_id).toBe("_create-app");
    expect(otherChangelog[0]?.app_id).toBe(OTHER_APP_ID);
    expect((await currentManifest(OTHER_APP_ID)).app.tables[0]).toEqual(baseTable);
  });

  test("存在しないアプリの changelog は 404", async () => {
    const response = await request(changelogPath("no-such-app"));
    expect(response.status).toBe(404);
    expect((await errorsOf(response)).length).toBe(1);
  });
});

/**
 * **実行専用の起動プロファイルの肯定形**(`V5-M3-T02` / `R-G1` のサーバ側)。
 *
 * **本ファイルに置いた理由**: **実データを持つアプリのフィクスチャ(`beforeEach`)が
 * ここに在る**ためである。**新しいテストファイルで同じフィクスチャを作ると
 * `createApp` / `applyManifest` / `KernelMetaStore` の層またぎが3件増え、
 * `scripts/kernel-import-snapshot.txt` の更新が要る**(`ADR-0009` 限定2 の受け皿。
 * 更新には審査が要る)。**層またぎを1本も増やさないために、既存の import で足りる
 * ここへ足した。**
 *
 * **登録の有無そのものは `src/server/runner-profile.test.ts` が見る。**
 * **ここが見るのは「実データのあるアプリで、実行系が今日どおり動くか」だけである。**
 *
 * **【この検査が主張しないこと】** **「編集できない」ではない。** **`profile` を
 * `"full"` にすれば同じ `dataRoot` に対して5本が今日どおり効く**(このファイルの
 * 他の全テストがそれを示している)。
 */
describe("V5-M3-T02 実行専用プロファイル(runner)", () => {
  /** 同じ `dataRoot` を、編集系を登録しない起動の形で開き直す。 */
  function runnerApp(): ReturnType<typeof createServerApp> {
    return createServerApp({ dataRoot, profile: "runner" });
  }

  test("編集系5本は「対応するエンドポイントはありません」の 404 になる(本丸)", async () => {
    const runner = runnerApp();
    const cases: Array<[string, string]> = [
      ["POST", diffsPath()],
      ["POST", undoPath()],
      ["GET", previewPath()],
      ["GET", changelogPath()],
      ["GET", `/api/apps/${APP_ID}/requirements`],
    ];
    for (const [method, path] of cases) {
      const response = await runner.request(
        authed(cookie)(path, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(addFieldDiff("should-not-apply")) } : {}),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(404);
      const errors = (await response.json()) as { errors: ValidationError[] };
      expect(errors.errors[0]?.message).toContain("に対応するエンドポイントはありません");
    }
  });

  /**
   * **【`V5-M3b` / `D-V5-96`(2026-08-06)】新しく落とす5本を、実データのあるアプリで叩く。**
   *
   * **owner の cookie を付けて叩いても 404 である** —— **権限で断られるのではなく、口が
   * 登録されていない。** **本文まで見る**(`V5-M3` の変異2 が「ステータスだけ見ていたら
   * 緑だった」ことを実測している)。
   *
   * **【禁止】「配布物では運営者が何も変えられない」と読まないこと** —— **利用者の管理3本 /
   * 外部との連携4本 / AI の能力5本の計12本が残る。**
   * **【必ず添える】外部との連携と AI の能力は「申請」までであり、申請を許可する口は
   * AI 側にあって配布物に入らない** —— **配った先で申請しても、許可する手段が無い。**
   */
  test("【D-V5-96】新しく落とす5本も、owner の cookie 付きで 404 になる(本丸)", async () => {
    const runner = runnerApp();
    const cases: Array<[string, string]> = [
      ["GET", "/api/apps"],
      ["GET", `/api/apps/${APP_ID}/escape-hatch-assets`],
      ["POST", `/api/apps/${APP_ID}/escape-hatch-assets`],
      ["GET", `/api/apps/${APP_ID}/escape-hatch-assets/requests`],
      ["DELETE", `/api/apps/${APP_ID}/escape-hatch-assets/asset-1`],
    ];
    for (const [method, path] of cases) {
      const response = await runner.request(
        authed(cookie)(path, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "POST"
            ? { body: JSON.stringify({ name: "should-not-issue", css: "a{}", scope_views: ["x"] }) }
            : {}),
        }),
      );
      expect(response.status, `${method} ${path}`).toBe(404);
      const errors = (await response.json()) as { errors: ValidationError[] };
      expect(errors.errors[0]?.message, `${method} ${path}`).toContain(
        "に対応するエンドポイントはありません",
      );
      // **`full` 側では同じ口が「エンドポイントがありません」にならない**(目印が死んでいない)。
      const onFull = await request(path, {
        method,
        headers: { "content-type": "application/json" },
      });
      const fullBody = (await onFull.json()) as { errors?: ValidationError[] };
      expect(fullBody.errors?.[0]?.message ?? "", `full: ${method} ${path}`).not.toContain(
        "に対応するエンドポイントはありません",
      );
    }
  });

  test("【D-V5-96】残す12本は runner でも今日どおり応答する(404 にならない)", async () => {
    const runner = runnerApp();
    const kept: Array<[string, string]> = [
      ["GET", `/api/apps/${APP_ID}/auth/users`],
      ["PATCH", `/api/apps/${APP_ID}/auth/users/no-such-user`],
      ["GET", `/api/apps/${APP_ID}/auth/activity`],
      ["GET", `/api/apps/${APP_ID}/connections`],
      ["POST", `/api/apps/${APP_ID}/connections`],
      ["GET", `/api/apps/${APP_ID}/connections/requests`],
      ["DELETE", `/api/apps/${APP_ID}/connections/no-such-connection`],
      ["GET", `/api/apps/${APP_ID}/ai-capabilities`],
      ["POST", `/api/apps/${APP_ID}/ai-capabilities`],
      ["GET", `/api/apps/${APP_ID}/ai-capabilities/requests`],
      ["PATCH", `/api/apps/${APP_ID}/ai-capabilities/no-such-capability/limit`],
      ["DELETE", `/api/apps/${APP_ID}/ai-capabilities/no-such-capability`],
    ];
    expect(kept.length).toBe(12);
    for (const [method, path] of kept) {
      const response = await runner.request(
        authed(cookie)(path, {
          method,
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      const body = (await response.json()) as { errors?: ValidationError[] };
      expect(body.errors?.[0]?.message ?? "", `${method} ${path}`).not.toContain(
        "に対応するエンドポイントはありません",
      );
    }
  });

  test("編集系を叩いてもマニフェストは1バイトも変わらない", async () => {
    const before = await currentManifest();
    const runner = runnerApp();
    await runner.request(authed(cookie)(diffsPath(), { method: "POST", body: "{}" }));
    await runner.request(authed(cookie)(undoPath(), { method: "POST" }));
    // **`full` 側の同じインスタンスから読み直す。**
    expect(await currentManifest()).toEqual(before);
  });

  test("肯定形: 実行系(マニフェスト読取・レコードの読み書き)は今日どおり動く", async () => {
    const runner = runnerApp();

    // (1) マニフェスト読取
    const manifestRes = await runner.request(authed(cookie)(manifestPath()));
    expect(manifestRes.status).toBe(200);
    expect((await manifestRes.json()) as Manifest).toEqual(await currentManifest());

    // (2) レコード作成(書込は編集系ではない —— **アプリの作りを変えないため**)
    const created = await runner.request(
      new Request(`http://localhost${recordsPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: TEST_ORIGIN },
        body: JSON.stringify({ title: "runner から書いた行" }),
      }),
    );
    expect(created.status, await created.clone().text()).toBe(201);

    // (3) レコード一覧
    const listed = await runner.request(authed(cookie)(recordsPath));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { records: Array<Record<string, unknown>> };
    expect(body.records.map((row) => row.title)).toContain("runner から書いた行");

    // (4) `full` 側から見ても同じ行が在る(同じ `dataRoot` を見ている)
    const fromFull = await request(recordsPath);
    const fullBody = (await fromFull.json()) as { records: Array<Record<string, unknown>> };
    expect(fullBody.records.map((row) => row.title)).toContain("runner から書いた行");
  });
});
