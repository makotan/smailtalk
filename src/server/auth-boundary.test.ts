/**
 * per-app 認証境界の網羅テスト(V1-M3-T01 / ADR-0014 v3 / 計画 v3 §C・アプリ単位認証)。
 *
 * v2(プラットフォーム全体認証)を作り直し、**そのアプリのレコード(データ)を読み書きする
 * 5系統だけ**に per-app 認証を要求する。manifest / diffs / undo / undo/preview / changelog /
 * list_apps は**ローカル専用(認証なし)**に戻した(=アプリ自体を操作する管理・カーネル操作)。
 * ここが v2 と逆(v2 は全 API を保護していた)なので、回帰防止に重要。
 *
 * ============================================================================
 *  歯止め: レコード API(下記 RECORD_ENDPOINTS の5系統)を足したら**必ず表に追記**する。
 *          非保護 API(NON_PROTECTED_ENDPOINTS)を足したときも同様。
 *          この2表が「per-app 認証境界の網羅の唯一の台帳」である(ADR-0014 v3)。
 * ============================================================================
 *
 * app.ts のエンドポイントと保護の対応:
 *   #1  GET    /api/apps                                    → 非保護(list_apps。管理)
 *   #2  GET    /api/apps/:app/manifest                      → 非保護(管理)
 *   #3  GET    /api/apps/:app/tables/:t/records             → **保護**(per-app)
 *   #4  GET    /api/apps/:app/tables/:t/records/:id         → **保護**(per-app)
 *   #5  POST   /api/apps/:app/tables/:t/records             → **保護**(per-app)
 *   #6  PATCH  /api/apps/:app/tables/:t/records/:id         → **保護**(per-app)
 *   #7  DELETE /api/apps/:app/tables/:t/records/:id         → **保護**(per-app)
 *   #8/#9      静的配信 / SPA フォールバック                → 保護対象外(SPA シェル)
 *   #10 POST   /api/apps/:app/diffs                         → 非保護(apply_diff。管理)
 *                                                             **【V4-FIX1 項目(5) で改訂】保護に変えた。下の #24**
 *   #11 POST   /api/apps/:app/undo                          → 非保護(管理)
 *                                                             **【V4-FIX1 項目(5) で改訂】保護に変えた。下の #24**
 *   #12 GET    /api/apps/:app/undo/preview                  → 非保護(管理)
 *   #13 GET    /api/apps/:app/changelog                     → 非保護(管理)
 *
 *  **#10 / #11 の上の記述は制定時のものであり、1バイトも書き換えていない**(判定時点の記述。
 *  `ADR-0007` §6 規律1 と同じ作法)。**今日の正は下の #24 である。**
 *
 *  公開 read-only 窓(V2-M1-T04 / ADR-0034。records ルートの内側で開く未認証 GET):
 *   #14 GET    /api/apps/:app/tables/<public>/records       → **公開**(未認証 GET 200。書込は 401)
 *   #15 GET    /api/apps/:app/tables/<public>/records/:id   → **公開**(公開行は 200 / 非公開行は 404)
 *
 *  「公開」= st_public 規約フィールドを持つテーブルへの**未認証 GET だけ**を通す窓であって、
 *  同じ URL への未認証 POST/PATCH/DELETE は従来どおり 401 のまま(read-only を構造で守る。限定2)。
 *  歯止め: 公開経路(PUBLIC_ENDPOINTS)を足したときも必ずこの表に追記する。
 *
 *  画像アップロード/配信(V2-M2-T02/T03 / ADR-0035。`filesAuthMiddleware` / 配信ルート):
 *   #16 POST   /api/apps/:app/files                          → **保護**(未認証 401。editor/owner)
 *   #17 GET    /api/apps/:app/files/:file_id                 → **公開配信**(公開参照 file は未認証 200 /
 *                                                              非公開・未参照・不在は一律 404。認証境界の 401 では塞がない)
 *
 *  配信は **GET のみ**(限定6)—— `/files/:file_id` への POST/PATCH/DELETE は**経路が無い**(404)。
 *  アップロードは #16 の認証必須 POST、削除は blob 刈り取り(T04)に閉じる。配信の未認証応答が
 *  401 ではなく 404 なのは存在秘匿(列挙耐性)のため(ADR-0035 §限界3/4)。
 *  歯止め: file 経路(FILE_ENDPOINTS)を足したときも必ずこの表に追記する。
 *
 *  システムテーブル(V4-M1 / `B-G6`。**2026-08-02 に塞いだ**):
 *   #18 GET    /api/apps/:app/tables/_apps/records        → **保護**(未認証 401)
 *   #19 GET    /api/apps/:app/tables/_changelog/records   → **保護**(未認証 401)
 *   #20 GET    /api/apps/:app/tables/_ai_usage/records    → **保護**(未認証 401)
 *
 *  **実在するシステムテーブルは3本である**(`src/shared/system-tables.ts:128` 逐語
 *  `export const SYSTEM_TABLES: readonly Table[] = [APPS_TABLE, CHANGELOG_TABLE, AI_USAGE_TABLE];`)。
 *  **V4-M1 より前の本ファイルの散文は `_apps` / `_changelog` の2本しか名指ししておらず、
 *  `_ai_usage` が抜けていた**(`_ai_usage` は V1-M5-T03 が `SYSTEM_TABLES` に足した時点で、
 *  当時の認証バイパスが自動的に3本目へ広がっていた)。**`B-G6` と同時に直した。**
 *
 *  **V4-M1 より前は3本とも未認証で読めた** —— カーネル台帳の読み取り専用投影(=管理データ)
 *  だから認証しない、という扱いだった(`app.ts` のシステムテーブル例外)。しかし**3投影は
 *  いずれもプラットフォーム全体を返す**(`src/kernel/read-records.ts` が読むのは
 *  `source.dataRoot` の `kernel.sqlite` 全体であって app 単位ではない)ので、
 *  `/api/apps/<任意のapp>/tables/_changelog/records` で**全アプリの依頼文の逐語**が、
 *  `_ai_usage` で**誰がいくら使ったか**が未認証で読めていた。**`B-G6` はこれを塞ぐ。**
 *  歯止め: システムテーブルを足したら `SYSTEM_TABLE_ENDPOINTS` に必ず追記する
 *  (この表と `SYSTEM_TABLE_IDS` の突き合わせを下のテストが機械的に行う)。
 *
 *  **塞ぐにあたって壊してはいけない性質**(`ADR-0006:251` の無番号節「システムテーブル読み取り時に
 *  `app.sqlite` を開かない」): **`app.sqlite` が無い / 壊れているアプリでも、`_apps` を眺めるだけで
 *  統一形式でない 500 にならない。** 下の「破壊試験」がこれを固定する。
 *
 *  画面ごとの「見せる相手」による遮断(V4-M3 / `B-G1` / ADR-0070 限定3。**2026-08-03 に足した**):
 *   #21 GET/POST/PATCH/DELETE /api/apps/:app/tables/:t/records[/:id]**?view=<view_id>**
 *                                                          → **保護**(名乗った画面の `audience` に
 *                                                             載っていない相手は 403。載っていない
 *                                                             画面IDは 400)
 *
 *  **`ADR-0014:84` の歯止め(「保護経路を足したときは境界表に追記する」)の履行である。**
 *  **経路(パス)は1本も増えていない** —— 足したのは**既存の5系統に掛かる新しい拒否条件**で
 *  あり、区別するのはクエリ `?view=` である。**それでも「保護が増えた」ことに変わりはないので、
 *  この表に行を書き、下の `VIEW_AUDIENCE_ENDPOINTS` が実際にその拒否を叩く。**
 *  **【禁止】「境界表は変えていない」と「保護経路を足した」を同時に書かない。**
 *
 *  **この保護が守らないもの(誇張しない)**:
 *   - **`?view=` を渡さない要求は今日どおり通る**(ADR-0070 限定4)。**表を閉じる遮断ではない。**
 *   - **#2 `GET /api/apps/:app/manifest` は今日も非保護のままである**(限定7)——
 *     **どんな画面が存在し、誰に見せると宣言されているかは未ログインで読める。**
 *   - **MCP 経路は1ミリも守られない**(限定8)。
 *
 *  **【2026-08-09 追記(`V8-M20` / 台帳 `J-G27` / `J-G29` / `ADR-0301`)。上の #21 / #22 / #23 の
 *  散文にある `audience` の語は制定時のものであり、1バイトも書き換えていない】**
 *  **画面の「見せる相手」(`view.audience`)と、ボタンの「見せる相手」
 *  (`view_action.audience`)の語彙は廃止された。** **`schemas/manifest.schema.json` から
 *  綴りごと消えており、書いたマニフェストは `applyManifest` が invalid にする。**
 *  **経路(パス)も応答コードも1本も変わっていない** —— **判定の出どころが
 *  `app.roles[].rules`(役割 × 対象 × 動詞)へ移っただけである**
 *  (`owner-scope.ts` の `judgeRoleAccess`)。**したがってこの境界表の行は消していない。**
 *  **本ファイルの fixture は `views[].audience` を `app.roles[].rules` の
 *  `{ target: "view", view, can: ["read"] }` へ置き直してある。**
 *
 *  未ログインにも見せると宣言した画面(V4-M2 / `B-G5` / ADR-0074 / **ADR-0075 §2**。
 *  **2026-08-03 に足した**):
 *   #22  GET /api/apps/:app/tables/<公開>/records**?view=<anonymous 宣言の画面>**
 *                                                          → **未認証でも 200**(#14 の公開窓の
 *                                                             上に画面の宣言が重なった形)
 *   #22' GET /api/apps/:app/tables/<非公開>/records**?view=<anonymous 宣言の画面>**
 *                                                          → **未認証は今日どおり通らない**
 *
 *  **これは「保護経路を足した」ではなく「保護を外した」向きの変更である。**
 *  **`ADR-0014:84` の原文は「保護経路を**足した**ときは境界表に追記する」であり、
 *  「外したときは」と1文字も書いていない** —— **したがって原文の歯止めは `B-G5` を
 *  1件も捕まえなかった**(`ADR-0075` の「発見した欠落」)。**`ADR-0075` §2 がこの歯止めを
 *  両方向に改訂し、この行がその履行である。**
 *
 *  **経路(パス)は1本も増えていない。** **`src/server/app.ts` は1バイトも変わっていない**
 *  (`ADR-0074` 限定9 / 限定10)。**変わったのは `src/server/owner-scope.ts` の述語
 *  `isViewAudienceAllowed` に未認証の枝が1本増えたことだけである。**
 *
 *  **この開放が守らないもの(誇張しない)**:
 *   - **#2 `GET /api/apps/:app/manifest` は今日も非保護のままである**(`ADR-0074` 限定9)——
 *     **`anonymous` と書かなかった画面の定義も未ログインで読める。**
 *     **「宣言で隠す」は情報の遮断ではない。**
 *   - **未認証の書込は今日どおり 401 である**(`ADR-0034` 限定2 の構造保証を1ミリも緩めていない)。
 *   - **匿名に返る行は今日どおり `st_public` が真の行だけである**(`ADR-0074` §3a-2)——
 *     **画面を見せることと行を返すことは別である。**
 *   - **匿名公開 GET のレート制限を1バイトも外していない**(限定10)。
 *   - **MCP 経路は1ミリも守られない**(`ADR-0070` 限定8 を引き継ぐ)。
 *
 *  まとめ書きの経路に画面の宣言を掛けた(**`V4-FIX1` 項目(1)**。**2026-08-03 に足した**):
 *   #23 POST   /api/apps/:app/batch**?view=<view_id>**      → **保護**(名乗った画面の `audience` に
 *                                                              載っていない相手は 403。実在しない
 *                                                              画面IDは 400)
 *
 *  **これは「保護経路を足した」向きの変更であり、`ADR-0014:84`(`ADR-0075` §2 が両方向にした)の
 *  歯止めの履行である。** **経路(パス)は1本も増えていない** —— `POST /batch` は既に在り、
 *  足したのは**その上に掛かる新しい拒否条件**である。
 *
 *  **なぜ足したか(実測)**: `docs/evidence/cp-v4.md` §6-3 の #10 が、**同一セッション・
 *  同一画面ID の対照**で次を実測した —— **`GET .../records?view=X` = 403 /
 *  `POST .../batch?view=X` = 200(行が作られた)。** **`ADR-0070` 限定3 が求めた「サーバの
 *  レコード経路が同じ宣言を読む」がバッチ経路に1行も入っておらず、宣言した境界が迂回できた。**
 *
 *  **この保護が守らないもの(誇張しない)**:
 *   - **`?view=` を渡さないバッチは今日どおり通る**(`ADR-0070` 限定4 と同じ既定)。
 *   - **画面の対象テーブルと、ops が書く先のテーブルの一致は検査していない** ——
 *     **バッチは1リクエストで複数テーブルを跨ぐので、比べる相手が1つに決まらない。**
 *     **「自分に開いている画面を名乗って別の表へ書く」ことは今日もできる**
 *     (`src/server/batch-view-audience.test.ts` の (Y) が固定している)。
 *   - **バッチは元から editor/owner 限定(`ADR-0039`)なので、この追加で新しく閉じた表は無い** ——
 *     **閉じたのは「宣言に載っていない画面を名乗ること」だけである。**
 *   - **MCP 経路は1ミリも守られない**(`ADR-0070` 限定8)。
 *
 *  アプリの作りを書き換える口(**`V4-FIX1` 項目(5)**。**2026-08-03 に塞いだ**):
 *   #24 POST   /api/apps/:app/diffs                         → **保護**(未認証 401 / owner 以外 403)
 *   #24 POST   /api/apps/:app/undo                          → **保護**(未認証 401 / owner 以外 403)
 *   #25 GET    /api/apps/:app/requirements                  → 非保護(**台帳に無かったので足した**)
 *
 *  **ユーザ決定の逐語**(本タスクの指示):
 *   > **書き換えの口は塞ぐ。どんな画面が存在するのかを未ログインでも見せていいです。**
 *   > **アクセスしたらログイン必須です。書き換えの口をふさぐは必須です**
 *
 *  **【`V8-M21`(2026-08-10)/ ユーザ決定 `D-V8-34` が、上の逐語を**部分的に**覆した。
 *   逐語は1バイトも消していない】**
 *
 *   **`D-V8-34` の逐語**(選ばれた見出し = **ログイン画面に要る分だけ渡す**):
 *   > **「アプリ名と、「未ログインでも見せる」と決めた画面の名前だけを渡し、項目名・
 *   > 自動処理・他の画面は渡さない。ログイン画面も公開ページも今どどおり出る。以前
 *   > 「どんな画面が存在するのかは未ログインでも見せていい」と決めていた件を、
 *   > 部分的に覆すことになる。」**
 *
 *   **したがって今日の正は次である**:
 *   - **画面の**名前**のうち「未ログインでも見せる」と決めたものは、`GET /public` で
 *     今日どおり渡る**(= 上の逐語のうち、生きている部分)。
 *   - **それ以外(項目名・自動処理・他の画面・権限の宣言)は渡らない** ——
 *     **`GET /manifest` は未認証で **401** になった**(`D-V8-21` / 台帳 `J-G24a`)。
 *   **【禁止】「未ログインには何も見えなくなった」と書かない**(`D-V8-34` の但し書き)。
 *
 *  **直す前の実測**(`docs/evidence/cp-v4.md` §9 の 14): **未認証の `POST /diffs`(正当な
 *  `add_view` 1本)= 201(実際に画面が1本増えた)。未認証の `POST /undo` = 200。**
 *
 *  **`ADR-0075` §限界6 の逐語**「**`ADR-0014` §2 の免除リスト(manifest / diffs / undo /
 *  changelog / list_apps)を1行も見直していない。**」—— **本タスクが見直した。**
 *  **見直しの結果、免除のまま残したのは読取5本(#1 / #2 / #12 / #13 / #25)であり、
 *  塞いだのは書き換えの2本(#24)だけである。**
 *
 *  **`ADR-0014:84`(`ADR-0075` §2 が両方向にした歯止め)の履行である。**
 *
 *  **この保護が守らないもの(誇張しない)**:
 *   - **#2 `GET /api/apps/:app/manifest` は今日も非保護である。** **ユーザ決定により
 *     開けたままにした** —— 「**どんな画面が存在するのかを未ログインでも見せていいです**」。
 *     **`E-G6`(塞ぐ側)は本タスクで1文も審査していない。**
 *   - **#12 `GET undo/preview` / #13 `GET changelog` / #25 `GET requirements` は今日も未認証で、
 *     依頼文(intent)の逐語が読める**(`ADR-0006` §Consequences が記録した状態は解けていない)。
 *   - **MCP 経路は1ミリも変わらない** —— **MCP は HTTP を1本も叩かず、カーネルを直接呼ぶ**
 *     (2026-08-03 に `src/mcp/` を走査して実測。HTTP クライアント呼び出しは0件)。
 *     **`ADR-0005` §7 / `ADR-0014` §3 の「MCP に権限制御は無い」は今日も真である。**
 *   - **`127.0.0.1` バインドが唯一の防御である、という `ADR-0003` §8 の前提は消えていない** ——
 *     **軽くなっただけである。**
 *
 * ここでは**ユーザテーブル**に対する 5系統の保護と、上のシステムテーブル3本を固定する。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { SYSTEM_TABLE_IDS } from "../shared/system-tables.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/** middleware が未認証時に返す統一メッセージ(app.ts の `unauthenticatedError`)。 */
const AUTH_REQUIRED_MESSAGE = "認証が必要です。ログインしてください。";

const APP_ID = "inventory";

function inventoryManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "備品管理",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [{ id: "name", name: "備品名", type: "text", required: true }],
        },
        {
          // 公開テーブル(st_public boolean 非required)。未認証 GET が通る窓(ADR-0034)。
          id: "catalog",
          name: "カタログ",
          fields: [
            { id: "name", name: "商品名", type: "text", required: true },
            { id: "st_public", name: "公開", type: "boolean" },
          ],
        },
      ],
      views: [
        { id: "item-list", type: "list_view", table: "items", columns: ["name"] },
        // **#21 の当たり先**(V4-M3 / `B-G1` / ADR-0070)。運営だけに見せると宣言した画面。
        // **【`V8-M20` / `J-G27` / `ADR-0301`】画面の「見せる相手」(`view.audience`)は
        // 廃止された。** **旧: `audience: ["owner"]` をこの画面の定義に直接書いていた。**
        // **今日は下の `roles` に「役割 `owner` × 対象(画面 `admin-item-list`)× 読取」を
        // 書く** —— **他の役割にはこの画面の規則を書かないので allow-list で締まる。**
        { id: "admin-item-list", type: "list_view", table: "items", columns: ["name"] },
        // **#22 の当たり先**(V4-M2 / `B-G5` / ADR-0074)。**未ログインにも見せると宣言した
        // 画面。** **対象は公開テーブル(`catalog`)である** —— 公開でないテーブルに書くと、
        // 画面は開けても行は今日どおり 401 になる(`ADR-0074` §3a-2)。
        // **【`V8-M20` / `J-G27` / `ADR-0301`】旧: `audience: ["anonymous"]`。**
        // **今日は `app.roles` に予約語 `anonymous` の役割を書き、その規則で開ける。**
        { id: "public-catalog-list", type: "list_view", table: "catalog", columns: ["name"] },
      ],
      // **【`V8-M20` / `J-G27` / `ADR-0301`】画面の「見せる相手」の置き直し先。**
      // **既定3ロール(`owner` / `editor` / `viewer`)は消せない**
      // (消すと `applyManifest` が invalid になる。`referential-integrity.ts` の類型17)。
      // **`item-list` の規則は1本も書かない** —— **規則の書かれていない対象は管轄外
      // (全許可)であり、旧「`audience` を書かない画面は全員に出る」と同じ既定である。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "view", view: "admin-item-list", can: ["read"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "view", view: "public-catalog-list", can: ["read"] }],
        },
      ],
    },
  };
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-auth-boundary-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "備品管理", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】表 `items` にだけ既定3役割の規則を足す。**
  //
  // - **画面には1本も足さない**(`skipAllViews: true`)—— **`item-list`(規則の無い画面)/
  //   `admin-item-list`(運営だけ)/ `public-catalog-list`(未ログインだけ)の3本を
  //   題材が自分で書き分けており、そこへ既定の読取を配ると #21 / #22 / #23 の測定が丸ごと消える。**
  // - **`catalog` にも1本も足さない**(`skipTables`)—— **測っているのは公開窓
  //   (`st_public` / `ADR-0034`)であって面ではない。着手前と同じ「規則の無い表」のままにする。**
  // - **足したのは `items` の表の規則だけである** —— **`records` 5系統とバッチの検査が
  //   「認証境界を通る」ことを測れるようにするための最小限。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(inventoryManifest(), { skipTables: ["catalog"], skipAllViews: true }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/**
 * cookie を一切付けずにリクエストする(未認証)。状態変更でも Origin を送らないので、
 * middleware は Origin 検査(403)ではなく未認証(401)で塞ぐ。
 */
function unauth(method: string, path: string, body?: unknown): Response | Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(new Request(`http://localhost${path}`, init));
}

const R = `/api/apps/${APP_ID}/tables/items/records`;

// --- 保護対象: ユーザテーブルの records 5系統 -------------------------------------

const RECORD_ENDPOINTS: { label: string; method: string; path: string; body?: unknown }[] = [
  { label: "#3 GET records(list)", method: "GET", path: R },
  { label: "#4 GET record", method: "GET", path: `${R}/x` },
  { label: "#5 POST record", method: "POST", path: R, body: { name: "机" } },
  { label: "#6 PATCH record", method: "PATCH", path: `${R}/x`, body: { name: "机" } },
  { label: "#7 DELETE record", method: "DELETE", path: `${R}/x` },
];

test("レコード5系統は未認証で 401(統一形式・boundary メッセージ)を返す", async () => {
  for (const ep of RECORD_ENDPOINTS) {
    const response = await unauth(ep.method, ep.path, ep.body);
    expect(response.status, ep.label).toBe(401);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    expect(Array.isArray(body.errors), ep.label).toBe(true);
    // handler の偶発的な 401 ではなく、middleware(認証境界)が塞いだことを確かめる。
    expect(body.errors?.[0]?.message, ep.label).toBe(AUTH_REQUIRED_MESSAGE);
  }
});

test("保護対象の records は5系統(表に載っている数)である(歯止め)", () => {
  expect(RECORD_ENDPOINTS).toHaveLength(5);
});

// --- 非保護(ローカル専用・認証なし)6本は未認証でも塞がれない ----------------------
//
// v2 で掛けた保護を外し、従来どおり誰でも(=ローカル専用)に戻したことを固定する。
// これらは「認証境界の 401」で塞がれない —— 中身の妥当性で 200/400 になるだけ。

const NON_PROTECTED_ENDPOINTS: {
  label: string;
  method: string;
  path: string;
  body?: unknown;
  expectOk?: boolean;
}[] = [
  { label: "#1 GET /api/apps", method: "GET", path: "/api/apps", expectOk: true },
  // **【`V8-M21` / 台帳 `J-G24a` / `J-G24b` / `D-V8-21` / `D-V8-34`】1行を差し替えた。**
  // **旧の行(逐語)**:
  //   `{ label: "#2 GET manifest", method: "GET", path: \`/api/apps/${APP_ID}/manifest\`, expectOk: true },`
  // **`GET /manifest` は今日から保護側である**(下の `#26` が 401 を固定する)。
  // **代わりに、未ログインへ渡す最小限の口(`GET /public`)を非保護側に置いた** ——
  // **本数は 5本のまま動いていない**(1本外して1本足した)。
  // **【緩めていない】** **外した1本は保護側の検査へ移しただけであり、消していない。**
  {
    label: "#26 GET public(アプリ名と、未ログインでも見せると決めた画面の名前だけ)",
    method: "GET",
    path: `/api/apps/${APP_ID}/public`,
    expectOk: true,
  },
  // **#10 POST diffs / #11 POST undo はここから外れた**(`V4-FIX1` 項目(5)。下の #24)。
  // **ユーザ決定の逐語**: 「**書き換えの口は塞ぐ。どんな画面が存在するのかを未ログインでも
  // 見せていいです。アクセスしたらログイン必須です。書き換えの口をふさぐは必須です**」。
  // undo/preview は「戻せる変更が無い」ので 400 になる(create_app 第0行は undo 不可)。
  // ここで見たいのは「認証境界の 401 に塞がれない」ことなので expectOk は付けない。
  //
  // =====================================================================================
  // **【`V17-M4-T02` による改訂。上の記述も、下に引いた3行も1バイトも書き換えていない】**
  // =====================================================================================
  //
  // **台帳 `AC-G20`(門外 / 限定採用)により、この3本は今日から保護側である。**
  // **外した3行の逐語(消していない。ここに残す)**:
  //
  //   `{ label: "#12 GET undo/preview", method: "GET", path: \`/api/apps/${APP_ID}/undo/preview\` },`
  //   `{`
  //   `  label: "#13 GET changelog",`
  //   `  method: "GET",`
  //   `  path: \`/api/apps/${APP_ID}/changelog\`,`
  //   `  expectOk: true,`
  //   `},`
  //   `{`
  //   `  label: "#25 GET requirements",`
  //   `  method: "GET",`
  //   `  path: \`/api/apps/${APP_ID}/requirements\`,`
  //   `  expectOk: true,`
  //   `},`
  //
  // **`#25` に付いていた説明の逐語も残す**: 「**`ADR-0014` §2 の免除リストに名前が無く、
  // 本ファイルの台帳にも1行も無かった —— `V4-FIX1` 項目(5) の洗い出しで見つけて足した。
  // 読取なので今日も塞いでいない(ユーザ決定は書き換えの口だけを必須としている)。**」
  // **後半は今日の正でなくなった** —— **ユーザ決定 `D-V17-…`(読み物3本を閉じる)による。**
  //
  // **【3本は消していない。保護側の検査へ移した】** —— 下の
  // 「**`AC-G20`: 読み物3本は未認証で 401 になる**」が同じ3本を撃つ。
  // **【本数の変化を言い換えない】** **非保護の台帳は 5本 → 2本になった。**
  // **残る2本(`GET /api/apps` / `GET /public`)は今日どおり未ログインで 200 である。**
];

test("非保護2本は未認証でも認証境界に塞がれない(v2 の保護を外して従来どおり)", async () => {
  for (const ep of NON_PROTECTED_ENDPOINTS) {
    const response = await unauth(ep.method, ep.path, ep.body);
    // 認証境界の 401 ではないこと(handler まで届いていること)。
    expect(response.status, ep.label).not.toBe(401);
    if (ep.expectOk) {
      expect(response.status, ep.label).toBe(200);
    }
  }
});

test("非保護の台帳は2本である(歯止め)", () => {
  // **【`V17-M4-T02`】旧の逐語**: `expect(NON_PROTECTED_ENDPOINTS).toHaveLength(5);`
  // **3本(`undo/preview` / `changelog` / `requirements`)を保護側へ移したぶんだけ減った。**
  expect(NON_PROTECTED_ENDPOINTS).toHaveLength(2);
});

// --- **`AC-G20`(`V17-M4-T02`。2026-09-09)読み物3本を保護側へ移した** --------------------
//
// **上の非保護の台帳から外した3本を、ここで 401 として固定する** —— **消していない。**
// **掛かっているのは `GET /manifest` と同じ1本の関門である**(`app.ts` の
// `manifestAuthMiddleware` を `registerChangeRoutes` に渡している)。
const READ_ROUTES_NOW_PROTECTED: { label: string; method: string; path: string }[] = [
  { label: "#12 GET undo/preview", method: "GET", path: `/api/apps/${APP_ID}/undo/preview` },
  { label: "#13 GET changelog", method: "GET", path: `/api/apps/${APP_ID}/changelog` },
  { label: "#25 GET requirements", method: "GET", path: `/api/apps/${APP_ID}/requirements` },
];

test("AC-G20: 読み物3本は未認証で 401(統一形式・boundary メッセージ)を返す", async () => {
  for (const ep of READ_ROUTES_NOW_PROTECTED) {
    const response = await unauth(ep.method, ep.path);
    expect(response.status, ep.label).toBe(401);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    expect(body.errors?.[0]?.message, ep.label).toBe(AUTH_REQUIRED_MESSAGE);
  }
});

test("AC-G20: 保護側へ移したのは3本ちょうどである(歯止め)", () => {
  expect(READ_ROUTES_NOW_PROTECTED).toHaveLength(3);
});

// --- **`AC-G24`(`V17-M6-T04`。2026-09-08)付与の出どころを返す口を1本足した** -------------
//
// **`ADR-0014` §2 の逐語**: 「**保護経路を足したときは境界表に追記する**歯止めを置く。」
// **本段はレコードの読取経路を1本足したので、その1行をここに足す** ——
// **掛かっているのは `records` 5系統とまったく同じ1本の関門である**
// (`app.ts` の `recordsAuthMiddleware`。**2本目の判定を作っていない**)。
//
// **【誇張しない】** **この行が固定するのは「未認証で 401 になる」ことだけである。**
// **誰に何が見えるかは `src/server/record-access-sources.test.ts` が別に固定する。**
const ACCESS_SOURCES_ENDPOINTS: { label: string; method: string; path: string }[] = [
  {
    label: "#27 GET access-sources",
    method: "GET",
    path: `${R}/x/access-sources`,
  },
];

test("AC-G24: 付与の出どころを返す口は未認証で 401(統一形式・boundary メッセージ)を返す", async () => {
  for (const ep of ACCESS_SOURCES_ENDPOINTS) {
    const response = await unauth(ep.method, ep.path);
    expect(response.status, ep.label).toBe(401);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    // handler の偶発的な 401 ではなく、middleware(認証境界)が塞いだことを確かめる。
    expect(body.errors?.[0]?.message, ep.label).toBe(AUTH_REQUIRED_MESSAGE);
  }
});

test("AC-G24: 足した保護経路は1本ちょうどである(歯止め)", () => {
  expect(ACCESS_SOURCES_ENDPOINTS).toHaveLength(1);
});

// --- #24 アプリの作りを書き換える口(V4-FIX1 項目(5)。**2026-08-03 に塞いだ**)-----------
//
// **ユーザ決定の逐語**(本タスクの指示):
//   > **書き換えの口は塞ぐ。どんな画面が存在するのかを未ログインでも見せていいです。**
//   > **アクセスしたらログイン必須です。書き換えの口をふさぐは必須です**
//
// **直す前の実測**(`docs/evidence/cp-v4.md` §9 の 14): **未認証の `POST /diffs`(正当な
// `add_view` 1本)= 201(実際に画面が1本増えた)。未認証の `POST /undo` = 200。**
// **本タスクも参照ショップに対して実 HTTP で再現してから塞いだ**(記録 §項目(5))。

const CHANGE_ENDPOINTS: { label: string; method: string; path: string; body?: unknown }[] = [
  { label: "#24 POST diffs", method: "POST", path: `/api/apps/${APP_ID}/diffs`, body: {} },
  { label: "#24 POST undo", method: "POST", path: `/api/apps/${APP_ID}/undo`, body: {} },
];

test("#24 アプリの作りを書き換える2本は、未認証で 401 になる", async () => {
  for (const ep of CHANGE_ENDPOINTS) {
    const response = await unauth(ep.method, ep.path, ep.body);
    expect(response.status, ep.label).toBe(401);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    expect(body.errors?.[0]?.message, ep.label).toBe(AUTH_REQUIRED_MESSAGE);
  }
});

test("#24 owner のセッションなら今日どおり handler まで届く(塞ぎすぎていない)", async () => {
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "owner" });
  for (const ep of CHANGE_ENDPOINTS) {
    const response = await app.request(
      new Request(`http://localhost${ep.path}`, {
        method: ep.method,
        headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(ep.body),
      }),
    );
    // 空 body / 戻せる変更なし はカーネルが 400 で返す。**401 でも 403 でもないこと**が要点。
    expect(response.status, ep.label).not.toBe(401);
    expect(response.status, ep.label).not.toBe(403);
  }
});

test("#24 owner でないロール(editor / viewer / customer)は 403 になる", async () => {
  // **アプリの作りを書き換えるのは owner だけである** —— 逃げ道 CSS(`escape-hatch-assets`)/
  // AI 能力 / 接続の管理と同じ水準に揃えた。**画面側は既に owner 専用だったが、
  // `web/src/AppWorkspace.tsx` のコメント逐語「**それでも担保はサーバ側に無い**」のとおり、
  // サーバは1件も見ていなかった。**
  for (const role of ["editor", "viewer", "customer"] as const) {
    const { cookie } = seedSession(dataRoot, APP_ID, { role, username: `${role}-chg` });
    for (const ep of CHANGE_ENDPOINTS) {
      const response = await app.request(
        new Request(`http://localhost${ep.path}`, {
          method: ep.method,
          headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify(ep.body),
        }),
      );
      expect(response.status, `${role} ${ep.label}`).toBe(403);
    }
  }
});

test("#24 の台帳は2本である(歯止め。書き換えの口を足したら必ず追記する)", () => {
  expect(CHANGE_ENDPOINTS).toHaveLength(2);
});

// **【`V8-M21` / 台帳 `J-G24a` / ユーザ決定 `D-V8-21` による更新。旧文を1バイトも消していない】**
//
// **旧テスト名**: 「#24【塞いでいない】GET manifest は今日どおり未認証で 200(ユーザ決定に
// より開けたまま)」。**旧の本体(逐語)**:
// ```
// // **ユーザ決定の逐語**: 「**どんな画面が存在するのかを未ログインでも見せていいです。**」
// // **したがって `E-G6`(`GET /manifest` を塞ぐ)は本タスクでは1ミリも実施していない。**
// expect((await unauth("GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(200);
// ```
//
// **`D-V8-21`(選ばれた見出し = 塞ぐ(ログインを要求))が、その「開けたまま」を覆した。**
// **`E-G6` が指していた穴は `V8-M21` が塞いだ** —— **未認証は 401、ログインすれば 200 である。**
// **役割は見ない**(viewer / customer でも読める。`J-G24a` はログインを要求しただけである)。
test("#26【塞いだ】GET manifest は未認証で 401。ログインすれば役割を問わず 200(V8-M21 / D-V8-21)", async () => {
  expect((await unauth("GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(401);
  for (const role of ["owner", "editor", "viewer"] as const) {
    const { cookie } = seedSession(dataRoot, APP_ID, { role });
    const response = await app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/manifest`, { headers: { cookie } }),
    );
    expect(response.status, role).toBe(200);
  }
});

// **【`V8-M26-T05` / 台帳 `T-G27b`(再審査 = 限定採用)/ ユーザ決定 `D-V8-57` による更新。
//   旧文を1バイトも消していない】**
//
// **旧テスト名**: 「#26【未ログインに渡るもの】GET public はアプリ名と、未ログインでも
// 見せると決めた画面の名前だけを返す」。**旧の期待値のうち今日書き換えたのは1本だけである** ——
// ```
//   // **画面の中身(表 / 列 / 種別)は1バイトも渡らない。**
//   for (const view of body.views) {
//     expect(Object.keys(view).sort()).toEqual(["id", "name"]);
//   }
// ```
// **これは `ADR-0314` 限定2 の後半(`docs/adr/0314-app-definition-login-required.md:244` の
// 逐語「**`app` のキーは `id` / `name` の2つ、画面のキーも `id` / `name` の2つちょうど**」)を
// 機械的に固定していた1本である。** **`D-V8-57`(選ばれた見出し = **実際に開けるようにする**。
// 説明文の逐語「未ログインで公開画面の中身が見られるようにします。…**未ログインの相手に
// 画面の作り(項目の並びなど)が渡ります**。」)がそれを覆した。**
//
// **【弱めていない部分を名指しする】** **応答のトップレベルのキー(`app` / `views` / `theme` の
// 3つちょうど)/ 渡ってはならないキー5本の不在 / `app` のキーが2つちょうど /
// 載る画面が `anonymous` の規則を書いた画面ちょうど —— この4本は1バイトも変えていない。**
// **【正直に書く】書き換えた1本は**弱めた**期待値である**(`ADR-0314` 限定5 が「弱めた期待値は
// 今日0件である」と書いた状態は、今日から偽になった)。**代わりに、渡るキーの**全量**を
// `toEqual` で固定し直した** —— **緩めたのではなく、線を引き直した。**
test("#26【未ログインに渡るもの】GET public はアプリ名と、公開画面の定義(描ける分)を返す", async () => {
  const response = await unauth("GET", `/api/apps/${APP_ID}/public`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    app: { id: string; name: string };
    views: (Record<string, unknown> & { id: string; name: string })[];
    theme?: Record<string, string>;
  };
  // **応答のキーは、配色を宣言していないこのアプリでは2つちょうど**(`app` / `views`)。
  // **`tables` も `fields` も `roles` も `workflows` も `functions` も1つも無い。**
  //
  // **【`theme` はメインが足すと決めた3つ目のキーである。黙って足していない】** ——
  // **`V8-M21` の後半の実装は、いったん配色も渡さない形にした。**
  // **メインが `D-V8-34` の逐語「ログイン画面も公開ページも今どおり出る」を根拠に、
  // 配色を1キー足すと判断した。** **配色は「アプリ名と画面の名前**だけ**」の外にある。**
  // **配色を宣言していないアプリではキーごと出ない**(マニフェストの側と同じ形)——
  // **本題材は `app.theme` を書いていないので、ここは2つである。**
  // **配色を宣言したアプリで3つ目が出て、それがログイン画面に実際に当たることは、
  // `web/e2e/theme.e2e.ts` の (iii) / (iv) / (v) が**未ログインのまま**計算値で測る。**
  //
  // ==========================================================================================
  // **【2026-08-14。`V8-M5-T03`。ユーザ決定 `D-V8-114` / `D-V8-115`。`ADR-0338` §3-1】**
  // **旧の期待値の逐語(1バイトも消していない)**:
  // ```
  //   expect(Object.keys(body).sort()).toEqual(["app", "views"]);
  // ```
  // **なぜ変わったか**: **`D-V8-115`(選ばれた見出し = **変更として記録して進める (推奨)**)が、
  // **`ADR-0319` 限定1(応答のトップレベルのキーを4つ目にしない)を引き直す側に倒した。**
  // **足したのは登録に要る事実(`signup`)の1キーである** —— **`D-V8-114` が
  // 「立場の一覧を返して出し分ける」を選んだので、登録前の画面が読む先がここになった。**
  //
  // **【失った性質を明記する】** **`ADR-0319` が「この2本は1バイトも変えていない」と
  // 書いた担保のうち、`Object.keys(body).sort()` の1本は今日から成り立たない。**
  // **緩めてはいない**(`toEqual` の完全一致のままキーが1つ増えただけであり、
  // **5つ目が出れば必ず赤くなる**)。 **渡ってはならないキー5本の不在の側は1バイトも
  // 変えていない。**
  // ==========================================================================================
  expect(Object.keys(body).sort()).toEqual(["app", "signup", "views"]);
  // **渡ってはならないキーを名指しで固定する**(将来キーが1本増えたときに気づけるように)。
  for (const forbidden of ["tables", "roles", "workflows", "functions", "user_kinds"]) {
    expect(Object.keys(body), forbidden).not.toContain(forbidden);
  }
  expect(Object.keys(body.app).sort()).toEqual(["id", "name"]);
  expect(body.app.name).toBe("備品管理");
  // **未ログインでも見せると決めた画面(= `anonymous` の規則が在る画面)だけが載る。**
  expect(body.views.map((view) => view.id)).toEqual(["public-catalog-list"]);
  // **規則を1本も書いていない画面(`item-list`)も、運営専用の画面も載らない** ——
  // **`V8-M20` が開けた「規則の無い画面が未ログインにも開く」は、この口では踏んでいない。**
  expect(body.views.map((view) => view.id)).not.toContain("item-list");
  expect(body.views.map((view) => view.id)).not.toContain("admin-item-list");
  // **【`V8-M26-T05` / `D-V8-57`】旧の期待値の逐語(上のヘッダにも同じものを残した)**:
  // ```
  //   // **画面の中身(表 / 列 / 種別)は1バイトも渡らない。**
  //   for (const view of body.views) {
  //     expect(Object.keys(view).sort()).toEqual(["id", "name"]);
  //   }
  // ```
  // **今日は画面の定義そのものが渡る** —— **名前だけでは画面を描けないからである。**
  // **渡るキーの全量をここで固定する**(`toEqual`。**1本増えたら必ず赤くなる**)。
  // **`tables` はこの画面が描くのに要る表の定義であり、`ADR-0319` 限定5 の形どおり
  // トップレベルではなく画面の中に入っている。**
  for (const view of body.views) {
    expect(Object.keys(view).sort()).toEqual(["columns", "id", "name", "table", "tables", "type"]);
  }
  // **名前を書いていない画面は、旧どおり ID が名前になる**(この題材の `public-catalog-list`
  // は `name` を持たない)。
  expect(body.views[0]?.name).toBe("public-catalog-list");
  // **表の定義は「その画面が使う表」1本ちょうどである** —— **`items` の定義は渡らない。**
  const tables = body.views[0]?.tables as { id: string; fields: { id: string }[] }[];
  expect(tables.map((table) => table.id)).toEqual(["catalog"]);
  // **行(データ)は1行も入っていない**(`D-V8-64`。**渡すのは定義だけである**)。
  expect(Object.keys(tables[0] as object)).not.toContain("records");
});

// --- 公開 read-only 窓(V2-M1-T04 / ADR-0034)。未認証 GET は通り、書込は 401 のまま ------
//
// この2表(RECORD_ENDPOINTS = 保護 / PUBLIC_ENDPOINTS = 公開 GET)を足したら必ず追記する。

const PUB = `/api/apps/${APP_ID}/tables/catalog/records`;

const PUBLIC_ENDPOINTS: { label: string; method: string; path: string }[] = [
  { label: "#14 GET public records(list)", method: "GET", path: PUB },
  { label: "#15 GET public record", method: "GET", path: `${PUB}/x` },
];

test("公開テーブルは未認証 GET が通る(list は 200。単一の不在は 404 で認証境界の 401 ではない)", async () => {
  const list = await unauth("GET", PUB);
  expect(list.status).toBe(200); // 空でも 200(公開窓が開いている)
  const single = await unauth("GET", `${PUB}/does-not-exist`);
  // 未認証でも認証境界(401)に塞がれない。不在は 404。
  expect(single.status).not.toBe(401);
  expect(single.status).toBe(404);
});

test("公開経路でも未認証 POST/PATCH/DELETE は 401(read-only を構造で守る。限定2)", async () => {
  const writes: { method: string; path: string; body?: unknown }[] = [
    { method: "POST", path: PUB, body: { name: "机", st_public: true } },
    { method: "PATCH", path: `${PUB}/x`, body: { name: "机" } },
    { method: "DELETE", path: `${PUB}/x` },
  ];
  for (const w of writes) {
    const response = await unauth(w.method, w.path, w.body);
    expect(response.status, `${w.method} ${w.path}`).toBe(401);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    expect(body.errors?.[0]?.message, `${w.method} ${w.path}`).toBe(AUTH_REQUIRED_MESSAGE);
  }
});

test("非公開テーブル(st_public 無し)は未認証 GET で従来どおり 401", async () => {
  // items は公開規約フィールドを持たないので、GET も 401(公開窓は開かない)。
  const response = await unauth("GET", R);
  expect(response.status).toBe(401);
  const body = (await response.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).toBe(AUTH_REQUIRED_MESSAGE);
});

test("公開 GET 経路は2本(表に載っている数)である(歯止め)", () => {
  expect(PUBLIC_ENDPOINTS).toHaveLength(2);
});

// --- 画像アップロード/配信(V2-M2-T02/T03 / ADR-0035)。境界の網羅台帳に固定 --------
//
// この表(FILE_ENDPOINTS)を足したら必ず追記する。アップロード(#16)は保護(未認証 401)、
// 配信(#17)は公開配信で未認証でも認証境界の 401 では塞がない(不在は 404)。

const F = `/api/apps/${APP_ID}/files`;

const FILE_ENDPOINTS: { label: string; method: string; protected: boolean }[] = [
  { label: "#16 POST /files(アップロード)", method: "POST", protected: true },
  { label: "#17 GET /files/:file_id(配信)", method: "GET", protected: false },
];

test("#16 アップロード POST /files は未認証で 401(書込は一切公開しない・保護)", async () => {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), "x.png");
  const response = await app.request(
    new Request(`http://localhost${F}`, { method: "POST", body: form }),
  );
  expect(response.status).toBe(401);
  const body = (await response.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).toBe(AUTH_REQUIRED_MESSAGE);
});

test("#17 配信 GET /files/:file_id は未認証でも認証境界の 401 では塞がない(公開配信・不在は 404)", async () => {
  // このアプリは画像未アップロード(`_files` 不在)なので、未認証 GET は 404(存在秘匿)。
  // 重要なのは「認証境界の 401 ではない」= records と違い公開配信であること。
  const response = await unauth("GET", `${F}/does-not-exist`);
  expect(response.status).not.toBe(401);
  expect(response.status).toBe(404);
});

test("配信は GET のみ —— /files/:file_id への POST/PATCH/DELETE は経路が無い(404)", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const response = await unauth(method, `${F}/x`);
    // 書込ハンドラを配信側に一切結線しない(read-only を経路分離で守る。限定6)。
    expect(response.status, method).toBe(404);
  }
});

test("file 経路の台帳は2本(アップロード#16 / 配信#17)である(歯止め)", () => {
  expect(FILE_ENDPOINTS).toHaveLength(2);
});

// --- 認証エンドポイント(免除)は未認証で叩ける ------------------------------------

test("register/login(passkey/password)は未認証で叩ける(認証境界に塞がれない)", async () => {
  const cases: { label: string; path: string; body: unknown }[] = [
    {
      label: "passkey/register/options",
      path: `/api/apps/${APP_ID}/auth/passkey/register/options`,
      body: { username: `exempt-reg-${Math.random().toString(36).slice(2)}` },
    },
    {
      label: "passkey/register/verify",
      path: `/api/apps/${APP_ID}/auth/passkey/register/verify`,
      body: { response: {} },
    },
    {
      label: "passkey/login/options",
      path: `/api/apps/${APP_ID}/auth/passkey/login/options`,
      body: {},
    },
    {
      label: "passkey/login/verify",
      path: `/api/apps/${APP_ID}/auth/passkey/login/verify`,
      body: { response: { id: "x" } },
    },
    {
      label: "password/register",
      path: `/api/apps/${APP_ID}/auth/password/register`,
      body: { username: `exempt-pw-${Math.random().toString(36).slice(2)}`, password: "pw12345" },
    },
    {
      label: "password/login",
      path: `/api/apps/${APP_ID}/auth/password/login`,
      body: { username: "nobody", password: "nope" },
    },
  ];
  for (const ep of cases) {
    const response = await app.request(
      new Request(`http://localhost${ep.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: TEST_ORIGIN },
        body: JSON.stringify(ep.body),
      }),
    );
    expect(response.status, ep.label).not.toBe(500);
    // 認証境界のメッセージでは塞がれない(auth/* は認証を掛けない)。
    if (response.status === 401 || response.status === 403) {
      const body = (await response.json()) as { errors?: { message?: string }[] };
      expect(body.errors?.[0]?.message, ep.label).not.toBe(AUTH_REQUIRED_MESSAGE);
    }
  }
});

// --- me / logout / SPA シェル -----------------------------------------------------

test("GET .../auth/me は未認証で 401(handler が返す。認証境界ではない)", async () => {
  const response = await unauth("GET", `/api/apps/${APP_ID}/auth/me`);
  expect(response.status).toBe(401);
  const body = (await response.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).not.toBe(AUTH_REQUIRED_MESSAGE);
});

test("POST .../auth/logout は未認証でも無害に 200 を返す", async () => {
  const response = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/auth/logout`, {
      method: "POST",
      headers: { origin: TEST_ORIGIN },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("SPA シェル(非 /api の GET)は保護対象外で 401 にならない", async () => {
  const response = await app.request(new Request("http://localhost/apps/inventory"));
  expect(response.status).not.toBe(401);
});

// --- 有効な per-app cookie で保護 API が通る(cookie 機構が実際に効いている対) ---------

test("有効な per-app セッション cookie を付けると records 5系統は通る(401 にならない)", async () => {
  const { cookie } = seedSession(dataRoot, APP_ID);
  const withAuth = (method: string, path: string, body?: unknown): Response | Promise<Response> => {
    const init: RequestInit = { method, headers: { cookie, origin: TEST_ORIGIN } };
    if (body !== undefined) {
      init.headers = { cookie, origin: TEST_ORIGIN, "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return app.request(new Request(`http://localhost${path}`, init));
  };

  // list は 200、作成は 201。残りは不在で 404 になるが、いずれも認証境界の 401 ではない。
  expect((await withAuth("GET", R)).status).toBe(200);
  expect((await withAuth("POST", R, { name: "机" })).status).toBe(201);
  for (const ep of RECORD_ENDPOINTS) {
    const response = await withAuth(ep.method, ep.path, ep.body);
    expect(response.status, ep.label).not.toBe(401);
  }
});

test("別アプリのセッション cookie では通らない(アプリ単位の分離)", async () => {
  // 別アプリ books を作って、その cookie で inventory の records を叩くと 401。
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "蔵書管理", { app_id: "books" });
  } finally {
    store.close();
  }
  const { cookie } = seedSession(dataRoot, "books");
  const response = await app.request(new Request(`http://localhost${R}`, { headers: { cookie } }));
  expect(response.status).toBe(401);
  const body = (await response.json()) as { errors?: { message?: string }[] };
  expect(body.errors?.[0]?.message).toBe(AUTH_REQUIRED_MESSAGE);
});

// --- システムテーブル(V4-M1 / B-G6)。未認証読取を塞いだ ---------------------------
//
// この表(SYSTEM_TABLE_ENDPOINTS)を足したら必ず追記する。**下のテストが
// `SYSTEM_TABLE_IDS` と機械的に突き合わせる**ので、システムテーブルが増えたのに
// この表に追記しなければ落ちる(散文の免除が3本目を取りこぼした再発を防ぐ)。

const SYSTEM_TABLE_ENDPOINTS: { label: string; tableId: string }[] = [
  { label: "#18 GET _apps records", tableId: "_apps" },
  { label: "#19 GET _changelog records", tableId: "_changelog" },
  { label: "#20 GET _ai_usage records", tableId: "_ai_usage" },
];

/** システムテーブルの records パス。 */
function systemPath(tableId: string): string {
  return `/api/apps/${APP_ID}/tables/${tableId}/records`;
}

test("システムテーブルの台帳は SYSTEM_TABLES と1件ずつ一致する(歯止め)", () => {
  expect(SYSTEM_TABLE_ENDPOINTS.map((ep) => ep.tableId)).toEqual([...SYSTEM_TABLE_IDS]);
});

test("システムテーブル3本は未認証 GET で 401(統一形式・boundary メッセージ)を返す", async () => {
  for (const ep of SYSTEM_TABLE_ENDPOINTS) {
    const response = await unauth("GET", systemPath(ep.tableId));
    expect(response.status, ep.label).toBe(401);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    expect(Array.isArray(body.errors), ep.label).toBe(true);
    // handler の偶発的な 401 ではなく、middleware(認証境界)が塞いだことを確かめる。
    expect(body.errors?.[0]?.message, ep.label).toBe(AUTH_REQUIRED_MESSAGE);
  }
});

test("システムテーブル3本は未認証 GET(単件)でも 401", async () => {
  for (const ep of SYSTEM_TABLE_ENDPOINTS) {
    const response = await unauth("GET", `${systemPath(ep.tableId)}/does-not-exist`);
    expect(response.status, ep.label).toBe(401);
  }
});

// **【`D-V8-74`(2026-08-11)。テスト名を1文字も変えていない】** —— **`seedSession` の
// ロールの既定は `owner` である**(`test-helpers.ts`)。**したがってこの検査が測っている
// のは「持ち主のセッションなら 200」であり、`D-V8-74` の後も期待値は 200 のままである。**
// **「ログインしていれば誰でも 200」ではないことは、すぐ下の検査が測る。**
test("有効なセッション cookie を付けるとシステムテーブル3本は 200 で読める", async () => {
  const { cookie } = seedSession(dataRoot, APP_ID);
  for (const ep of SYSTEM_TABLE_ENDPOINTS) {
    const response = await app.request(
      new Request(`http://localhost${systemPath(ep.tableId)}`, { headers: { cookie } }),
    );
    expect(response.status, ep.label).toBe(200);
  }
});

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("customer はシステムテーブルを読めない(403。プラットフォーム全体の管理データ)")` /
//       `expect(response.status, ep.label).toBe(403);`**
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **`customer` を止めていたのは `nonAdminTableAccess`(システムの表は `st_owner` も
// `st_public` も持たないので `"denied"`)であり、その層を撤去した。**
// **面はシステムの表を1バイトも守らない** —— **`D-V8-69`(「システムの表は権限の外に置く」)
// が `judgeRoleAccess` の先頭で免除しているためである。**
// **したがってシステムテーブルは、ログインしていれば誰でも読める。**
// **【正直に書く。これは広がりである】** **`_apps` / `_changelog` / `_ai_usage` は
// 今日、非運営の役割にも読める。** **`D-V8-69` が総括に書くと決めた「ここには権限が
// 効かない」の実測がこれである** —— **旧はロールの層が偶然その3本も塞いでいた。**
// **書込は今日どおりカーネルの読み取り専用エラーが止める**(下の検査群)。
//
// =====================================================================================
// **【`D-V8-74`(2026-08-11)。期待値をもう一度反転させた。上の記述を1バイトも消していない】**
// =====================================================================================
//
// **旧のテスト名(逐語)**:
// **`test("customer もシステムテーブルを読める(旧: 403。層の撤去で D-V8-69 の穴が実際に開いた)")`**
// **旧の期待値(逐語)**: **`expect(response.status, ep.label).toBe(200);`**
//
// **反転の根拠**: **ユーザ決定 `D-V8-74`。選ばれた見出しの逐語「持ち主にだけ見せる」。**
// **選ばれた説明文の逐語**:
// > **もっと狭くして、持ち主にだけ見せます。変更履歴を追えるのが持ち主1人だけになりますが、
// > 定義を変えられるのも今日持ち主だけなので、見る人と変える人が揃います。**
//
// **上の段落が「これは広がりである」と正直に書いた穴を、ユーザが塞ぐ側に決めた** ——
// **`src/server/app.ts` の `recordsAuthMiddleware` に、システムが持つ表の**読取だけ**を
// `owner` に限る判定を1本置いた。** **アプリの表には1バイトも掛かっていない。**
//
// **【`D-V8-69` の説明文と食い違う点。黙って合わせない】** —— **`D-V8-69` の説明文の
// 逐語は「変更履歴やアプリ一覧は**今までどおり**見えます」であった。** **その
// 「今までどおり」は**運営3ロールに見えること**を指していた。** **`D-V8-74` はそれより
// **狭い**(持ち主だけ)。** **【禁止の履行】どちらかを「誤り」と書かない。両方を残す。**
//
// **【選ばれなかった見出し2つ】** **「運営の人にだけ見せる」/「今のまま(ログインして
// いれば誰でも)」。** **後者が、まさに旧の期待値(200)だった姿である。**
//
// **【`D-V8-74` が減らすもの。隠さない】** **選ばれた説明文の逐語「変更履歴を追えるのが
// 持ち主1人だけになります」。** **編集者・閲覧者は、誰がいつ何を変えたかを追えなくなる。**
// **その実測が下の `editor` / `viewer` の 403 である。**
//
// **なぜ 404 や「200 + 0件」ではなく 403 なのか**(`ADR-0305` 限定11 を採らなかった理由)
// **は `src/server/app.ts` の `forbiddenSystemTableReadError` の doc に書いた。**
// **要点だけ**: **システムが持つ表は「在ること」自体が製品の仕様として公開されており
// (フロントエンドが `isSystemTableId` を値として import している)、伏せても何も守れない。**
test("customer / editor / viewer はシステムテーブルを読めない(403。旧: 200。D-V8-74 で持ち主だけに戻した)", async () => {
  for (const role of ["customer", "editor", "viewer"] as const) {
    const { cookie } = seedSession(dataRoot, APP_ID, { role, username: `sys-${role}` });
    for (const ep of SYSTEM_TABLE_ENDPOINTS) {
      const response = await app.request(
        new Request(`http://localhost${systemPath(ep.tableId)}`, { headers: { cookie } }),
      );
      // **旧(逐語): `expect(response.status, ep.label).toBe(200);`**
      expect(response.status, `${role} ${ep.label}`).toBe(403);
      const body = (await response.json()) as { errors?: { message?: string }[] };
      // **認証境界(401)とも、面の 403(`forbiddenRoleAccessError`)とも別の文面である。**
      expect(body.errors?.[0]?.message, `${role} ${ep.label}`).toContain("持ち主");
      // **「その表が在ること」は伏せていない** —— **表のIDを文面に出す。**
      expect(body.errors?.[0]?.message, `${role} ${ep.label}`).toContain(ep.tableId);
    }
  }
});

test("システムテーブルは未認証 POST/PATCH/DELETE でも 401(書込は従来どおりカーネルが拒否)", async () => {
  for (const ep of SYSTEM_TABLE_ENDPOINTS) {
    const post = await unauth("POST", systemPath(ep.tableId), { x: 1 });
    expect(post.status, `POST ${ep.label}`).toBe(401);
  }
});

// --- 破壊試験(ADR-0006:251 の性質を壊していないこと。V4-M1 / B-G6)-----------------
//
// ADR-0006:251 の無番号節: 「システムテーブル読み取り時に `app.sqlite` を開かない」。
// **目的は「壊れた / 無い `app.sqlite` を眺めるだけで統一形式でない 500 にしない」ことである**
// (逐語「`_apps` を眺めるだけで 500 になる…管理ツールは壊れた状態を見に行くための道具でも
// あるので、その1件のせいで一覧全体が落ちるのは筋が悪い」)。
//
// `B-G6` は認証を要求するようになったが、**セッション解決は `app.sqlite` を開く**
// (`AuthStore.openForApp` は `create:true`)。そこで:
//   1. `app.sqlite` が無いときは開かない(**ファイルを作らない**)
//   2. 開けた/開けなかったに関わらず、セッション解決の失敗は 500 にせず「セッション無し」に倒す
// を app.ts に入れた。下の3本がそれを固定する。

/** 実在しないセッションを指す cookie(store を開けないアプリでは何を出しても解決しない)。 */
const STRAY_COOKIE = "st_session=no-such-session";

test("破壊試験: app.sqlite を消しても、システムテーブルの GET は 500 にならない(統一形式のまま)", async () => {
  rmSync(join(dataRoot, "apps", APP_ID, "app.sqlite"), { force: true });
  const cookie = STRAY_COOKIE;
  for (const ep of SYSTEM_TABLE_ENDPOINTS) {
    const response = await unauth("GET", systemPath(ep.tableId));
    expect(response.status, `unauth ${ep.label}`).toBe(401);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    expect(body.errors?.[0]?.message, `unauth ${ep.label}`).toBe(AUTH_REQUIRED_MESSAGE);
    // cookie を付けても(そのアプリの認証情報ごと消えているので)500 ではなく 401。
    const withCookie = await app.request(
      new Request(`http://localhost${systemPath(ep.tableId)}`, { headers: { cookie } }),
    );
    expect(withCookie.status, `cookie ${ep.label}`).toBe(401);
  }
});

test("破壊試験: app.sqlite が無いアプリへ未認証で叩いても app.sqlite は作られない", async () => {
  const dbPath = join(dataRoot, "apps", APP_ID, "app.sqlite");
  rmSync(dbPath, { force: true });
  // cookie 付きでも(セッション解決の手前で存在検査するので)作らない。
  await unauth("GET", systemPath("_apps"));
  await app.request(
    new Request(`http://localhost${systemPath("_apps")}`, { headers: { cookie: STRAY_COOKIE } }),
  );
  expect(existsSync(dbPath)).toBe(false);
});

test("破壊試験: app.sqlite を壊しても 500 にならず、健全な別アプリ経由なら _apps は読める", async () => {
  // 別アプリ(健全)を作り、そちらのセッションで読む道が残っていることを示す。
  // システムテーブルの投影はプラットフォーム全体を返すので、内容は同一である。
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "蔵書管理", { app_id: "books" });
  } finally {
    store.close();
  }
  const { cookie } = seedSession(dataRoot, "books");

  // inventory の app.sqlite を「SQLite ではないバイト列」に置き換える(壊す)。
  writeFileSync(join(dataRoot, "apps", APP_ID, "app.sqlite"), "this is not a sqlite database\n");

  for (const ep of SYSTEM_TABLE_ENDPOINTS) {
    // 壊れたアプリの URL: 500 ではない(401。統一形式)。
    const broken = await unauth("GET", systemPath(ep.tableId));
    expect(broken.status, `broken ${ep.label}`).toBe(401);
    const brokenBody = (await broken.json()) as { errors?: { message?: string }[] };
    expect(brokenBody.errors?.[0]?.message, `broken ${ep.label}`).toBe(AUTH_REQUIRED_MESSAGE);

    // 壊れたアプリの URL に健全な別アプリの cookie を付けても 500 にならない。
    const brokenWithCookie = await app.request(
      new Request(`http://localhost${systemPath(ep.tableId)}`, { headers: { cookie } }),
    );
    expect(brokenWithCookie.status, `broken+cookie ${ep.label}`).not.toBe(500);

    // 健全な別アプリの URL からは 200 で読める(管理ツールが壊れた状態を見に行く道は残る)。
    const healthy = await app.request(
      new Request(`http://localhost/api/apps/books/tables/${ep.tableId}/records`, {
        headers: { cookie },
      }),
    );
    expect(healthy.status, `healthy ${ep.label}`).toBe(200);
  }

  // 壊れたアプリ inventory も `_apps` の一覧に載っている(一覧全体が落ちない)。
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。旧の1行を逐語で残す】**
  // **旧: `expect((listBody.records ?? []).map((row) => row.app_id)).toContain(APP_ID);`**
  //
  // **既定が「閉じる」側へ倒れたので、システムテーブルの投影は誰にも1行も返らない。**
  // **これは「規則を足し忘れた」のではなく、足せない** ——
  // **`app.roles[].rules` の `table` は `$defs/resource_id`(`^[a-z][a-z0-9_-]*$`)であり、
  // `_` で始まる `_apps` / `_changelog` / `_ai_usage` を書くと `applyManifest` が
  // 「table の値 "_apps" は識別子の規約に合いません。」で拒否する(実測)。**
  // **したがって今日、システムテーブルを開ける手立てはマニフェストの側に1つも無い。**
  //
  // **失われたのは `ADR-0006:251` の逐語「管理ツールは壊れた状態を見に行くための道具でも
  // ある」である** —— **経路は今日も 200 を返す(500 にならないという性質は保っている)が、
  // 中身は空であり、壊れたアプリの行を見に行く道は塞がっている。**
  //
  // **【`D-V8-69` により再び戻した(2026-08-10)。上の反転の記述は1バイトも消していない】**
  // **ユーザ決定 `D-V8-69`(見出しの逐語「システムの表は権限の外に置く」)により、
  // システムが持つ表は面の判定を1度も受けない** —— **`ADR-0006:251` の逐語の目的
  // (壊れた状態を見に行く道)は、今日ふたたび達成できている。**
  // **反転していたときの期待値(逐語)**:
  // **`expect((listBody.records ?? []).map((row) => row.app_id)).not.toContain(APP_ID);`**
  // **`expect(listBody.records ?? []).toEqual([]);`**
  //
  // **【総括に書く義務】** **その代わり「書いていなければ見えない」が及ばない先が1種類残る。**
  // **総括には `_apps` / `_changelog` / `_ai_usage` を名指しで書くこと。**
  const list = await app.request(
    new Request(`http://localhost/api/apps/books/tables/_apps/records`, { headers: { cookie } }),
  );
  expect(list.status).toBe(200);
  const listBody = (await list.json()) as { records?: { app_id?: string }[] };
  expect((listBody.records ?? []).map((row) => row.app_id)).toContain(APP_ID);
});

// --- #21 画面ごとの「見せる相手」による遮断(V4-M3 / `B-G1` / ADR-0070 限定3)------------
//
// **歯止め: `?view=` の判定を掛ける経路を足したら、必ずこの表に追記する**
// (`ADR-0014:84` の「保護経路を足したときは境界表に追記する」を、条件が増える形にも当てる)。
// **経路(パス)は1本も増えていない** —— 足したのは既存5系統に掛かる拒否条件である。

const AUDIENCE_VIEW = "admin-item-list";

const VIEW_AUDIENCE_ENDPOINTS: {
  label: string;
  method: string;
  path: string;
  body?: unknown;
}[] = [
  { label: "#21 GET records(list) ?view=", method: "GET", path: `${R}?view=${AUDIENCE_VIEW}` },
  { label: "#21 GET record ?view=", method: "GET", path: `${R}/x?view=${AUDIENCE_VIEW}` },
  {
    label: "#21 POST record ?view=",
    method: "POST",
    path: `${R}?view=${AUDIENCE_VIEW}`,
    body: { name: "机" },
  },
  {
    label: "#21 PATCH record ?view=",
    method: "PATCH",
    path: `${R}/x?view=${AUDIENCE_VIEW}`,
    body: { name: "机" },
  },
  { label: "#21 DELETE record ?view=", method: "DELETE", path: `${R}/x?view=${AUDIENCE_VIEW}` },
];

test("#21 宣言外のロール(viewer)は、画面を名乗った5系統すべてで 403 になる", async () => {
  // **viewer を選んだ理由**: viewer は今日 GET を1つも拒否されないロールである
  // (`ADR-0053:40` 逐語「owner / editor / viewer では**1画面も減らない**」)。
  // **したがってここでの 403 は、既存のテーブル単位の遮断ではなく画面の宣言が出したものである。**
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "viewer" });
  for (const ep of VIEW_AUDIENCE_ENDPOINTS) {
    const init: RequestInit = { method: ep.method, headers: { cookie, origin: TEST_ORIGIN } };
    if (ep.body !== undefined) {
      init.headers = {
        ...(init.headers as Record<string, string>),
        "content-type": "application/json",
      };
      init.body = JSON.stringify(ep.body);
    }
    const response = await app.request(new Request(`http://localhost${ep.path}`, init));
    expect(response.status, ep.label).toBe(403);
  }
});

test("#21 の台帳は5本である(歯止め。RECORD_ENDPOINTS と同数)", () => {
  expect(VIEW_AUDIENCE_ENDPOINTS).toHaveLength(RECORD_ENDPOINTS.length);
});

test("#21 未認証も宣言のある画面には入れない(値域に anonymous が無い。ADR-0070 限定2)", async () => {
  // **`items` は公開テーブルではないので今日も 401 だが、画面を名乗った場合は
  // 認証境界より先に画面の宣言が 403 を返す。** どちらにせよ通らないことを固定する。
  const response = await unauth("GET", `${R}?view=${AUDIENCE_VIEW}`);
  expect(response.status).toBe(403);
});

test("#21【守らない】?view= を渡さなければ、viewer は今日どおり 200 で読める(ADR-0070 限定4)", async () => {
  // **これが「表を閉じる遮断ではない」ことの実測である。**
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const response = await app.request(new Request(`http://localhost${R}`, { headers: { cookie } }));
  expect(response.status).toBe(200);
});

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `#21【守らない】#2 GET manifest は今日も非保護で、audience の宣言ごと
// 未ログインに返る`。**旧の本体**:
//   `expect(body.app.views.find((view) => view.id === AUDIENCE_VIEW)?.audience).toEqual(["owner"]);`
// **趣旨(「宣言はそのまま未ログインに漏れる」)は面の規則についても成り立つことを
// 2026-08-09 に実測した** —— **`GET /manifest` は `app.roles` を1バイトも落とさずに返す。**
// **【`V8-M21` / 台帳 `J-G24a` / `D-V8-21` による更新。旧文を1バイトも消していない】**
// **旧テスト名**: 「#21【守らない】#2 GET manifest は今日も非保護で、面の規則(roles)ごと
// 未ログインに返る」。**旧の期待値**: `expect(response.status).toBe(200);` と、未ログインの
// 応答本文の `owner` の規則が `[{ target: "view", view: AUDIENCE_VIEW, can: ["read"] }]` で
// あること。**旧のコメント逐語**: 「`ADR-0070` 限定7 の実測。上の `NON_PROTECTED_ENDPOINTS`
// の #2 と同じ経路を、「宣言が読めてしまう」側から見た検査である。」
//
// **`V8-M21` が塞いだ** —— **未ログインに `app.roles` は1バイトも渡らない。**
// **【緩めていない】** **ログインすれば規則はそのまま読める** ——
// **旧の期待値を「ログインした側」で今日も丸ごと測っている。**
test("#21【塞いだ】#2 GET manifest は未ログインで 401。ログインすれば面の規則(roles)はそのまま返る", async () => {
  expect((await unauth("GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(401);
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const response = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/manifest`, { headers: { cookie } }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    app: {
      roles?: {
        id: string;
        rules?: { target: string; view?: string; table?: string; can: string[] }[];
      }[];
    };
  };
  // **運営だけに開けると書いた規則は、ログインした閲覧者にはそのまま読める。**
  // **【`V8-M26`】題材の `owner` に「表 `items` の読み書き削除」が1本増えた**(上の
  // `beforeEach` の `withDefaultRoleRules`)。**測っているのは「画面の規則がそのまま読めるか」
  // なので、その1本を名指しで含める形に直した。** **旧を1バイトも消さずに残す** ——
  // **旧: `expect(body.app.roles?.find((role) => role.id === "owner")?.rules).toEqual([`**
  // **旧:   `{ target: "view", view: AUDIENCE_VIEW, can: ["read"] },`**
  // **旧: `]);`**
  // **【`V8-M28` / `T-G16a`(2026-08-11)】`owner` の規則がさらに2本増えた** ——
  // **`withDefaultRoleRules` が持ち主に `app`+`write` / `role`+`write` を足すからである
  // (足さないと題材の `applyManifest` が拒否される)。** **旧の期待値を1バイトも消していない。**
  // **旧: `expect(...).toEqual([`**
  // **旧:   `{ target: "view", view: AUDIENCE_VIEW, can: ["read"] },`**
  // **旧:   `{ target: "table", table: "items", can: ["read", "write", "delete"] },`**
  // **旧: `]);`**
  expect(body.app.roles?.find((role) => role.id === "owner")?.rules).toEqual([
    { target: "app", can: ["write"] },
    { target: "role", can: ["write"] },
    { target: "view", view: AUDIENCE_VIEW, can: ["read"] },
    { target: "table", table: "items", can: ["read", "write", "delete"] },
  ]);
});

// --- #22 未ログインにも見せると宣言した画面(V4-M2 / `B-G5` / ADR-0074 / ADR-0075 §2)------
//
// **`ADR-0075` §2 が `ADR-0014:84` の歯止めを両方向にした。** 改訂後の逐語:
//   > **保護経路を足したとき、および保護経路の保護を外した(未認証で到達できるように
//   > した)ときは、`src/server/auth-boundary.test.ts` の境界表に1行ずつ追記する。**
//
// **`ADR-0014:84` の原文は「保護経路を足したときは境界表に追記する」であり、「外したとき」
// とは1文字も書いていない**(`ADR-0075` の「発見した欠落」)。**`B-G5` は保護を外す向きの
// 変更なので、原文の歯止めは本単位を1件も捕まえなかった。** **この節がその履行である。**
//
// **【経路は1本も増えていない】** **`src/server/app.ts` は1バイトも変わっていない**
// (`ADR-0074` 限定9 / 限定10。差分は `V4-M2-T05` 完了条件3 が git で測る)。
// **変わったのは `owner-scope.ts` の述語 `isViewAudienceAllowed` の未認証の枝1本だけである。**
//
//   #22 GET /api/apps/:app/tables/<public>/records?view=<anonymous 宣言の画面>
//        → **未認証でも 200**(**#14 の公開窓の上に、画面の宣言が重なった形**)
//   #22' GET /api/apps/:app/tables/<非公開>/records?view=<anonymous 宣言の画面>
//        → **未認証は今日どおり 401**(**画面を開けることと行が返ることは別である**)

const ANON_VIEW = "public-catalog-list";

test("#22 未認証は、anonymous と宣言した画面を名乗って公開テーブルを読める(ADR-0074 限定1)", async () => {
  // **着手前(`ADR-0070` 限定2 の値域が4ロールだった時点)は 403 だった。**
  // **`ADR-0074` が値域に `anonymous` を足したので、画面の宣言はここを止めなくなった。**
  // **通したのは画面の宣言ではなく、その先の公開窓(`ADR-0034` #14)である** ——
  // **`ADR-0074` は公開窓を1バイトも広げていない。**
  const response = await unauth("GET", `${PUB}?view=${ANON_VIEW}`);
  expect(response.status).toBe(200);
});

test("#22' 宣言しても、公開でないテーブルの行は未認証に返らない(ADR-0074 §3a-2)", async () => {
  // **画面を見せることと行を返すことは別である。**
  // `items` は `st_public` を持たないので、画面を名乗っても認証境界で 401 になる。
  const response = await unauth("GET", `${R}?view=${ANON_VIEW}`);
  // **画面の対象テーブルと URL のテーブルが違うので、まず 400 で弾かれる**
  // (`ADR-0070` 限定3 の「無害な画面を名乗って別の表を読む」を止める検査)。
  expect(response.status).toBe(400);
});

test("#22 未認証の書込は、anonymous と宣言した画面を名乗っても 401 のままである(ADR-0074 限定6)", async () => {
  // **`ADR-0034` 限定2 の構造保証(read-only をミドルウェアの分離で守る)を1ミリも
  // 緩めていない。** **`ADR-0074` が約束したのは UI に書込を出さないことだけであり、
  // 匿名に書込を通すには `ADR-0034` §3a-1 の門が要る**(`ADR-0074` §3a-1)。
  for (const [method, path, body] of [
    ["POST", `${PUB}?view=${ANON_VIEW}`, { name: "机", st_public: true }],
    ["PATCH", `${PUB}/x?view=${ANON_VIEW}`, { name: "机" }],
    ["DELETE", `${PUB}/x?view=${ANON_VIEW}`, undefined],
  ] as const) {
    const response = await unauth(method, path, body);
    expect(response.status, `${method} ${path}`).toBe(401);
  }
});

test("#22 宣言していない画面は、今日どおり未認証を通さない(ADR-0074 限定5)", async () => {
  // **既定は「変えない」。** `item-list` は `audience` を書いていないので、
  // **画面の宣言は何も言わない** —— 止めるのは認証境界そのものである(#3 と同じ 401)。
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。旧の1行を逐語で残す】**
  // **旧: `expect((await unauth("GET", `${R}?view=item-list`)).status).toBe(401);`**
  //
  // **既定が「閉じる」側へ倒れたので、規則を1本も書いていない画面(`item-list`)は
  // 未ログインに対して面が 403 で止める** —— **止める層が「認証境界(401)」から
  // 「役割の規則(403)」へ移った。** **通っていない点は今日も同じである**
  // (**このテストの主題「宣言していない画面は未認証を通さない」は今日も真)。**
  // **【誇張しない】これは「塞ぎ方が強くなった」ではない** —— **未ログインが
  // 何も読めないことは着手前も真であり、変わったのは応答コードだけである。**
  expect((await unauth("GET", `${R}?view=item-list`)).status).toBe(403);
  // **運営だけに宣言した画面は、今日どおり画面の宣言が 403 で止める。**
  expect((await unauth("GET", `${R}?view=${AUDIENCE_VIEW}`)).status).toBe(403);
});

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `#22【守らない】#2 GET manifest は今日も未認証で、anonymous の宣言ごと
// 全ビュー定義を返す`。**旧の本体のうち消えた2行**:
//   `expect(body.app.views.find((view) => view.id === ANON_VIEW)?.audience).toEqual(["anonymous"]);`
//   `expect(body.app.views.find((view) => view.id === AUDIENCE_VIEW)?.audience).toEqual(["owner"]);`
// **画面が3本とも読める部分は1バイトも変えていない。**
// **【`V8-M21` / 台帳 `J-G24a` / `J-G24b` / `D-V8-21` / `D-V8-34` による更新。
//   旧文を1バイトも消していない】**
// **旧テスト名**: 「#22【守らない】#2 GET manifest は今日も未認証で、anonymous の面の規則ごと
// 全ビュー定義を返す」。**旧の期待値**: `expect(response.status).toBe(200);`(未認証)。
// **旧のコメント逐語**: 「`ADR-0074` 限定9 の実測。匿名に見せないと宣言した画面の定義も
// 読める。「宣言で隠す」は情報の遮断ではない。塞ぐのは `E-G6` の担当で、別の審査を通す。」
// **その `E-G6` を `V8-M21` が実施した。** **未ログインは 401 であり、画面が3本とも読めるのは
// ログインした人だけである**(下の期待値は1つも緩めず、ログインした側で丸ごと測っている)。
test("#22【塞いだ】#2 GET manifest は未認証で 401。ログインすれば anonymous の面の規則ごと全ビュー定義を返す", async () => {
  expect((await unauth("GET", `/api/apps/${APP_ID}/manifest`)).status).toBe(401);
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "viewer" });
  const response = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/manifest`, { headers: { cookie } }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    app: {
      views: { id: string }[];
      roles?: {
        id: string;
        rules?: { target: string; view?: string; table?: string; can: string[] }[];
      }[];
    };
  };
  // **3本とも読める**(規則のある2本と、規則の無い1本)。
  expect(body.app.views.map((view) => view.id).sort()).toEqual([
    "admin-item-list",
    "item-list",
    "public-catalog-list",
  ]);
  // **未ログインに開けた規則も、運営だけに開けた規則も、そのまま未ログインで読める。**
  expect(body.app.roles?.find((role) => role.id === "anonymous")?.rules).toEqual([
    { target: "view", view: ANON_VIEW, can: ["read"] },
  ]);
  // **【`V8-M26`】`owner` の規則が1本増えた**(すぐ上の #21 の検査と同じ理由)。
  // **`anonymous` には1本も増えていない** —— **`withDefaultRoleRules` は未ログインへ
  // 1本も配らないからである**(`D-V8-45` / `T-G26a`。上の期待値がそれを実測している)。
  // **旧: `expect(body.app.roles?.find((role) => role.id === "owner")?.rules).toEqual([`**
  // **旧:   `{ target: "view", view: AUDIENCE_VIEW, can: ["read"] },`**
  // **旧: `]);`**
  // **【`V8-M28` / `T-G16a`(2026-08-11)】`owner` の規則がさらに2本増えた** ——
  // **`withDefaultRoleRules` が持ち主に `app`+`write` / `role`+`write` を足すからである
  // (足さないと題材の `applyManifest` が拒否される)。** **旧の期待値を1バイトも消していない。**
  // **旧: `expect(...).toEqual([`**
  // **旧:   `{ target: "view", view: AUDIENCE_VIEW, can: ["read"] },`**
  // **旧:   `{ target: "table", table: "items", can: ["read", "write", "delete"] },`**
  // **旧: `]);`**
  expect(body.app.roles?.find((role) => role.id === "owner")?.rules).toEqual([
    { target: "app", can: ["write"] },
    { target: "role", can: ["write"] },
    { target: "view", view: AUDIENCE_VIEW, can: ["read"] },
    { target: "table", table: "items", can: ["read", "write", "delete"] },
  ]);
});

// --- #23 まとめ書きの経路に画面の宣言を掛けた(V4-FIX1 項目(1) / `B-G1` / ADR-0070 限定3)---
//
// **歯止め: `?view=` の判定を掛ける経路を足したら、必ずこの表に追記する。**
// **`POST /batch` は既に在った経路であり、足したのはその上に掛かる拒否条件である。**

const BATCH = `/api/apps/${APP_ID}/batch`;
const BATCH_OP = { ops: [{ op: "create", table: "items", values: { name: "机" } }] };

function batchAs(cookie: string | undefined, view: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    origin: TEST_ORIGIN,
    "content-type": "application/json",
  };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${BATCH}${view === undefined ? "" : `?view=${view}`}`, {
        method: "POST",
        headers,
        body: JSON.stringify(BATCH_OP),
      }),
    ),
  );
}

test("#23 宣言外のロール(editor)は、画面を名乗ったバッチで 403 になる", async () => {
  // **editor を選んだ理由**: editor はバッチを叩ける2ロールの一方であり、
  // **`?view=` を外せば今日どおり通る**(下の対照)。**したがってこの 403 は
  // 既存の書込ロール判定ではなく、画面の宣言が出したものである。**
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "editor" });
  expect((await batchAs(cookie, AUDIENCE_VIEW)).status).toBe(403);
  // 対照: 同じセッション・同じ ops で `?view=` を外すと今日どおり 200。
  expect((await batchAs(cookie, undefined)).status).toBe(200);
});

test("#23 宣言に載っている owner は今日どおり通る(遮断は一律ではない)", async () => {
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "owner" });
  expect((await batchAs(cookie, AUDIENCE_VIEW)).status).toBe(200);
});

test("#23 実在しない画面IDを名乗ったバッチは 400(単件経路と同じ)", async () => {
  const { cookie } = seedSession(dataRoot, APP_ID, { role: "owner" });
  expect((await batchAs(cookie, "no-such-view")).status).toBe(400);
});

test("#23 未認証は今日どおり通らない(画面を名乗れば 403 / 名乗らなければ 401)", async () => {
  expect((await batchAs(undefined, AUDIENCE_VIEW)).status).toBe(403);
  expect((await batchAs(undefined, undefined)).status).toBe(401);
});

// --- #27 匿名で到達できる書込の口(`V10-M11-T03` / 台帳 `CM-G6` / `ADR-0367` 限定1)-----------
//
// **歯止め: 未ログインで到達できる書込の口を足したら、必ずこの表に追記する。**
//
// **【この台帳が既存の台帳とどう違うか。数え方を先に宣言する】**
// **本ファイルには今日すでに手書きの台帳が在り、`{ label, method, path }` 系の配列の定義行は
// `:336`(`RECORD_ENDPOINTS`)/ `:364`(`NON_PROTECTED_ENDPOINTS`)/ `:433`(`CHANGE_ENDPOINTS`)/
// `:614`(`PUBLIC_ENDPOINTS`)/ `:661`(`FILE_ENDPOINTS`)/ `:1057` の**6本**である。**
// **`:817` の `SYSTEM_TABLE_ENDPOINTS` を口の台帳として数えると**7本**になる**
//(あちらは `{ label, tableId }` で method / path を持たないので、数え方で6にも7にもなる)。
// **`ANONYMOUS_WRITE_ENDPOINTS` は「匿名で到達できる**書込**の口の台帳」であり、
// そのどれとも主題が違う新しい台帳を1本足したものである。**
// **【禁止】「今日の台帳は6本」とだけ書かない**(数え方を宣言せずに書くと偽になる)。
//
// **【この歯止めの限界。丸めずに書く】**
// **本ファイルは、ソースを1バイトも読み込まない。** **`node:fs` の同期読み込みの関数の
// 当たりが **0件** である**(実測。**その関数の綴りをこの注に書かない** —— 書くと注自身が
// 当たってしまい、**実測の 0 が書いたその場で偽になる**。このリポジトリは同じ事故を
// `comment-store.ts` / `comment-visibility.ts` で既に踏んでいる)。 **走査しないので、
// 2本目の匿名の口を足してこの配列に追記し忘れても、この検査は緑のままである。**
// **追記を強いる仕組みはここには無い**(`CP-V10-COMMENT` 条件23 (e))。
//
// **【荒らし対策を入れていない】** **下の検査はレート制限を1つも足していない。**
// **測っているのは「未認証で到達できること」だけであり、遮断できることではない。**

const ANONYMOUS_WRITE_ENDPOINTS: readonly {
  label: string;
  method: string;
  path: string;
  body?: unknown;
}[] = [
  {
    label: "#27 POST comments(V10-M11-T01 が足した口を V10-M11-T03 が匿名に開けた)",
    method: "POST",
    path: `/api/apps/${APP_ID}/comments`,
    body: { anchorForm: "app", anchorParts: [], body: "未ログインからの注文" },
  },
];

test("匿名で到達できる書込の口の台帳は1本である(歯止め。匿名の口を足したら必ず追記する)", () => {
  expect(ANONYMOUS_WRITE_ENDPOINTS).toHaveLength(1);
  expect(ANONYMOUS_WRITE_ENDPOINTS.map((ep) => `${ep.method} ${ep.path}`)).toEqual([
    `POST /api/apps/${APP_ID}/comments`,
  ]);
});

test("#27 台帳の口は未認証で 401 にならない(実 HTTP。Cookie を1バイトも送らない)", async () => {
  for (const ep of ANONYMOUS_WRITE_ENDPOINTS) {
    const response = await unauth(ep.method, ep.path, ep.body);
    expect(response.status, ep.label).toBe(201);
  }
});

test("#27 台帳に載っていない書込の口は、今日どおり未認証で 401 である(塞ぎを緩めていない)", async () => {
  // **陽性対照 —— 同じ Cookie 無しで、既存の書込は1本も開いていない。**
  const anonymous = new Set(ANONYMOUS_WRITE_ENDPOINTS.map((ep) => `${ep.method} ${ep.path}`));
  for (const ep of [...RECORD_ENDPOINTS, ...CHANGE_ENDPOINTS]) {
    if (anonymous.has(`${ep.method} ${ep.path}`)) {
      continue;
    }
    const response = await unauth(ep.method, ep.path, ep.body);
    expect(response.status, ep.label).toBe(401);
  }
});
// --- #28 匿名で到達できる**読出**の口(`V10-M27-T03` / `ADR-0375`)-----------
//
// **歯止め: 未ログインで到達できる**読出**の口を足したら、必ずこの表に追記する。**
//
// **【なぜ3本目の台帳を立てたか】**
// **既存の台帳2本は、条件つきの行を持てない形である。**
// - **`ANONYMOUS_WRITE_ENDPOINTS`** は「**書込**の口」の台帳であり、`toHaveLength(1)` と
//   `toEqual([...])` と **201** を同時に固定している。**読出の `GET` をここへ足すと、
//   本数の式・並びの式・応答コードの式が同時に落ちる。**
//   **本タスクはこの配列と、それを測る3本の検査を1バイトも触っていない。**
// - **`NON_PROTECTED_ENDPOINTS`** は「**そのアプリが何を宣言していても**未認証で
//   認証境界に塞がれない口」の台帳(5本)である。**本口はそこに入らない** ——
//   **同じ口が、規則を1本でも書いているアプリでは今日どおり 401 になるからである。**
//   **本タスクはこの配列と `toHaveLength(5)` を1バイトも触っていない。**
//
// **【この台帳の行は「条件つき」である。丸めない】**
// **`GET /api/apps/:app_id/comments` が未ログインで通るのは、そのアプリが
// 「役割の規則を1本も書いていない」ときだけである。** **開く条件は2つの `AND`
// (定義が読めていること / 規則の要素の総数が 0)であり、判定は
// `comment-visibility.ts` の `declaresNoRules` 1本が持つ。**
//
// **【この歯止めの限界。既存の台帳と同じ限界を引き継ぐ】**
// **本ファイルはソースを1バイトも読み込まないので、2本目の匿名の読出の口を足して
// この配列に追記し忘れても、下の検査は緑のままである。** **追記を強いる仕組みは無い。**
//
// **【荒らし対策を入れていない】** **下の検査はレート制限を1つも足していない。**
// **測っているのは「未認証で到達できること」だけである。**

/** **役割の宣言を1つも持たないアプリ**(`roles` を省略する)。 */
const UNRULED_APP_ID = "kiosk";

/**
 * 規則ゼロのアプリを1本立てる。**`create_app` は持ち主に規則を2行入れるので、
 * `applyManifest` で `roles` を省いた定義に差し替える** —— **「役割の宣言を落とした
 * 古いアプリ」と同じ形である。**
 */
function seedUnruledApp(): void {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "売店", { app_id: UNRULED_APP_ID });
  } finally {
    store.close();
  }
  const unruled = {
    app: { id: UNRULED_APP_ID, name: "売店", tables: [], views: [] },
  } as unknown as Manifest;
  expect(applyManifest(dataRoot, UNRULED_APP_ID, unruled).valid).toBe(true);
}

const ANONYMOUS_READ_ENDPOINTS: readonly {
  label: string;
  method: string;
  /** **規則ゼロのアプリ**に当てたときのパス(未認証で通る側)。 */
  openPath: string;
  /** **規則が在るアプリ**に当てた同じ口のパス(今日どおり 401 になる側)。 */
  closedPath: string;
  /** その口が開く条件(**無条件ではない**ことを、台帳の行そのものに書く)。 */
  condition: string;
}[] = [
  {
    label: "#28 GET comments(V10-M15-T05 が足した読出の口を V10-M27-T02 が条件つきで匿名に開けた)",
    method: "GET",
    openPath: `/api/apps/${UNRULED_APP_ID}/comments`,
    closedPath: `/api/apps/${APP_ID}/comments`,
    condition:
      "そのアプリが役割の規則を1本も書いていないこと(定義が読めていること AND 規則の要素の総数が 0)",
  },
];

test("匿名で到達できる読出の口の台帳は1本である(歯止め。匿名の読出の口を足したら必ず追記する)", () => {
  expect(ANONYMOUS_READ_ENDPOINTS).toHaveLength(1);
  expect(ANONYMOUS_READ_ENDPOINTS.map((ep) => `${ep.method} ${ep.openPath}`)).toEqual([
    `GET /api/apps/${UNRULED_APP_ID}/comments`,
  ]);
  // **台帳の行はすべて条件つきである** —— 条件の欄が空の行を1つも置かない。
  for (const ep of ANONYMOUS_READ_ENDPOINTS) {
    expect(ep.condition.length, ep.label).toBeGreaterThan(0);
  }
});

test("#28 台帳の口は、規則ゼロのアプリでは未認証で 200 である(実 HTTP。Cookie を1バイトも送らない)", async () => {
  seedUnruledApp();
  for (const ep of ANONYMOUS_READ_ENDPOINTS) {
    const response = await unauth(ep.method, ep.openPath);
    expect(response.status, ep.label).toBe(200);
  }
});

test("#28 同じ口でも、規則が在るアプリでは今日どおり未認証で 401 である(条件つきであることの陰性対照)", async () => {
  for (const ep of ANONYMOUS_READ_ENDPOINTS) {
    const response = await unauth(ep.method, ep.closedPath);
    expect(response.status, ep.label).toBe(401);
  }
});

test("#28 台帳に載っていない読出の口は、規則ゼロのアプリでも今日どおり未認証で 401 である(塞ぎを緩めていない)", async () => {
  seedUnruledApp();
  // **陽性対照** —— 同じ規則ゼロのアプリで、レコードの読出も定義の読出も開いていない。
  const records = await unauth("GET", `/api/apps/${UNRULED_APP_ID}/tables/items/records`);
  expect(records.status).toBe(401);
  const manifest = await unauth("GET", `/api/apps/${UNRULED_APP_ID}/manifest`);
  expect(manifest.status).toBe(401);
});
