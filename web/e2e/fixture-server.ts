/**
 * E2E 用のサーバ起動スクリプト(V0-P3-T03)。
 *
 * 一時ディレクトリ(`fs.mkdtemp`)を dataRoot にして、フィクスチャのマニフェストを
 * `createApp` + `applyManifest` で流し込み、`src/server/app.ts` をそのまま起動する。
 * リポジトリの `data/` には一切触れないので、E2E を何度回しても実データは汚れない。
 *
 * どのアプリを載せるかは**フィクスチャのファイルが決める**。このスクリプトにも
 * フロントにもアプリ固有の名前は書かれていない(CP-3 確認方法4)。
 *
 * ## テスト間の独立(払い出しエンドポイント)
 *
 * サーバは起動時に「手で触るための1個目のアプリ」を作るが、**E2E のテストは
 * これを使わない**。各テストは `POST /__e2e__/apps` を叩いて**自分専用のアプリ
 * インスタンス**を払い出してもらい、その app_id の下だけでデータを作る。
 * アプリが違えば `data/apps/<app_id>/app.sqlite` が別ファイルなので、あるテストが
 * 何件レコードを作っても他のテストからは見えない。結果として:
 *
 * - テストの実行順序に依存しない(どの順で回しても、単体で回しても同じ)
 * - リトライで同じテストが2回走っても、その都度まっさらなアプリから始まる
 * - 「一覧にちょうど N 行」のような期待値が、自分が投入したデータだけで決まる
 *
 * `/__e2e__/*` は**このテスト用スクリプトだけ**が持つ経路であり、`src/server/app.ts`
 * (製品のサーバ)には存在しない。アプリを作る手段を HTTP に足さない方針
 * (ADR-0003)を製品側で崩さないため、ここで前段に挟む形にしてある。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Role } from "../../src/auth/types.ts";
import {
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
  RESOURCE_ID_MAX_LENGTH,
} from "../../src/kernel/index.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
// **【`V8-M26`】面の規則の型だけを受ける**(値は1つも import していない)。
import type { RoleRule } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { seedSession } from "../../src/server/test-helpers.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const fixturePath = resolve(
  repoRoot,
  process.env.ST_E2E_FIXTURE ?? "fixtures/valid/inventory-all-field-types.json",
);
const port = Number(process.env.ST_E2E_PORT ?? 3210);

/**
 * **配る版(実行専用の版)を配る2本目の待ち受け**(`V10-M7-T05`)。
 *
 * **番号は育成用の版の隣**(`ST_E2E_PORT + 1`)。**数字を1つも直書きしていない。**
 * **プロセスを分けていない理由は実測である** —— **`dataRoot` は `mkdtemp` で
 * 起動のたびに変わるので、別プロセスで建てると保管場所が割れ、同じアプリを1本も
 * 見つけられない。**
 */
const runnerPort = port + 1;

/** **待ち受けの番号からオリジンを組む**(数字を書かない)。 */
const originOf = (target: number): string => `http://localhost:${target}`;

/**
 * per-app 認証(ADR-0014 v3)の origin/rpID を **E2E の実オリジンに合わせる**。
 *
 * E2E はビルド済みフロントを fixture-server が配信する構成で、ブラウザは
 * `http://localhost:<port>`(WebAuthn の rpID=localhost 要件のため IP ではなく localhost)で
 * アクセスする。認証エンドポイント・レコード書き込みの Origin 検査(CSRF 多重防御)と
 * WebAuthn の expectedOrigin 検証はこの実オリジンと一致していなければならないので、
 * `createServerApp`(= `loadAuthConfig(process.env)`)が読む前に env を確定させる。
 * rpID は既定の `localhost` のまま(`http://localhost:<port>` の登録可能サフィックス)。
 *
 * **【`V10-M7-T05`】期待オリジンは今日から2つである。**
 * **配る版は別の待ち受け(`runnerPort`)から配られるので、そこのブラウザが送る
 * `Origin: http://localhost:<runnerPort>` を受けられないと、ログインも登録も
 * Origin 検査で 403 になる**(`src/auth/config.ts` は `,` 区切りで複数受ける)。
 */
const e2eOrigin =
  process.env.ST_AUTH_EXPECTED_ORIGIN ?? `${originOf(port)},${originOf(runnerPort)}`;
process.env.ST_AUTH_EXPECTED_ORIGIN = e2eOrigin;

/** テスト側(`fixture-app.ts`)と共有する払い出しエンドポイントのパス。 */
const PROVISION_PATH = "/__e2e__/apps";

/**
 * テスト用ログイン前段(`POST /__e2e__/apps/:app_id/session`)。
 *
 * WebAuthn を使わない既存 E2E を**手早くログイン済みにする**ための経路であって、
 * per-app 認証ガードの検証用ではない(ガードの検証は WebAuthn を使う `auth.e2e.ts` が担う)。
 * 対象アプリの `app.sqlite` 内 `_auth_*` に user+session を1件仕込み、テストが
 * `context.addCookies` / Cookie ヘッダで送るための `{name, value, path}` を返す
 * (cookie 本体はテスト側が入れる)。`/__e2e__/*` はこのテスト用スクリプトだけが持つ経路で、
 * 製品のサーバ(`src/server/app.ts`)には存在しない(ADR-0003)。
 */
const SESSION_PATH_PATTERN = /^\/__e2e__\/apps\/([^/]+)\/session$/;

/**
 * 稼働中のサーバに対するマニフェスト差し替え(`POST /__e2e__/apps/<app_id>/manifest`)。
 *
 * V0-P3-T07 は「サーバを起動したままマニフェストが変わったとき、ブラウザのリロード
 * だけで新しい画面構成が出る」ことを完了条件にしている。ブラウザからその状況を作るには
 * テスト実行中にマニフェストを差し替える手段が要るが、**製品のサーバにその口を作っては
 * ならない**(ADR-0003: マニフェストを変更するエンドポイントは HTTP に存在しない)。
 * そこで払い出しと同じく、このテスト用スクリプトの前段にだけ置く。
 *
 * 差し替えは `applyManifest` をそのまま呼ぶだけで、additive かどうかの判定も
 * DDL もカーネルの担当。ここには検証ロジックを1行も置かない。
 */
const MANIFEST_PATH_PATTERN = /^\/__e2e__\/apps\/([^/]+)\/manifest$/;

/**
 * **稼働中のサーバに対するコメントの出し入れの切り替え**
 * (`POST /__e2e__/apps/<app_id>/comment-visibility`。`V10-M31-T03`)。
 *
 * ## なぜ E2E の側に口が要るのか(**実測**)
 *
 * **`V10-M31-T01` が `GET /api/apps/:app_id/manifest` の応答に兄弟キー
 * `comment_visibility` を載せ、`V10-M31-T02` が器にそれを見せた。**
 * **既定は OFF(利用者決定 `D-V10-40`)なので、払い出したままのアプリでは
 * 「この画面へのコメント」の入力欄が1要素も出ない。**
 * **一方、設定を**書く**口は今日 MCP の道具 `set_comment_visibility` 1本だけであり、
 * HTTP には書く口も読む口も1本も無い**(`ADR-0378`)。
 * **したがって、この前段が無いと E2E には設定を ON にする手立てが1つも無い。**
 *
 * ## **これは E2E の足場であって、製品の口ではない**
 *
 * **`src/server/app.ts` を1バイトも触っていない** —— **`HTTP_ENTRY_POINTS` は
 * 今日も 52 のままである**(`src/server/entry-point-inventory.test.ts` が数えている)。
 * **`/__e2e__/*` は払い出し・セッションの仕込み・マニフェストの差し替えと同じく、
 * このテスト用スクリプトだけが持つ経路である。**
 *
 * ## **`provisionApp` の中で無条件に ON にしない**(**opt-in である**)
 *
 * **払い出しの時点で全部のアプリを ON にすると、E2E は「既定 OFF」を二度と観測できない**
 * —— **製品の既定と違う状態でアプリが生まれることになり、
 * `web/e2e/comment-visibility.e2e.ts` の1本目(既定で欄が出ない)が
 * 「土台が倒したから出ない」のか「製品の既定が OFF だから出ない」のかを
 * 区別できなくなる。** **倒すのはテストが明示的に叩いたときだけにする。**
 */
const COMMENT_VISIBILITY_PATH_PATTERN = /^\/__e2e__\/apps\/([^/]+)\/comment-visibility$/;

// =====================================================================================
// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65`。台帳 `T-G26a`】
// フィクスチャに「面の規則」(`app.roles[].rules`)を注入する**
//
// **`V8-M26-T03` が既定を「閉じる」側へ倒した** —— **規則を1本も名指ししていない
// `table` / `view` / `action` は今日から拒否される**(`field` だけは今日どおり開いたまま。
// 台帳 `T-G1b` = 却下)。**`fixtures/valid/inventory-all-field-types.json` は
// `app.roles` を1本も持たないので、注入しないと E2E の題材は
// 「画面が1枚も出ず、レコードが1行も読めない」アプリになる。**
//
// **【フィクスチャそのものは1バイトも編集していない】** —— **`fixtures/` は本タスクの
// 担当範囲外である。** **注入はこのテスト用スクリプトの中だけで起きる。**
//
// ## **なぜ `V8-M26-T04`(作るたびの自動付与)では足りないのか(実測)**
//
// **`T04` が発火するのは差分の畳み込み(`foldAddTable` / `foldAddView` / `foldUpdateView`)
// だけであり、`applyManifest` には1バイトも入っていない。** **`installFixtureApp` が
// 呼ぶのは `applyManifest` なので、フィクスチャの表・画面には1本も入らない。**
// **さらに `T04` は「アプリが既に `app.roles` を持っているときだけ」足すので、
// `roles` を1つも持たないフィクスチャには何も起きない。**
//
// ## **注入の設計 —— 「閉じる前の重ね方」を面の言葉で書き直したものである**
//
// **既定が開いていた頃、この題材の可否を決めていたのは面ではなく別の3層だった**:
// 個人所有(`st_owner`)・公開(`st_public`)・非運営ロールの表の区分
// (`nonAdminTableAccess`)。**注入はその3層と同じ形を面の側にも書く** ——
// **面を「素通し」に戻すのではなく、閉じる前と同じ範囲だけを開ける。**
//
//  - **運営3ロール(`owner` / `editor` / `viewer`)**: 全画面 × 読取。表は
//    `owner` = 読取/書込/削除・`editor` = 読取/書込・`viewer` = 読取。
//  - **個人所有(`st_owner`)の表の**読取**にだけ条件(`when`)を付ける** ——
//    **面が表の読取を許すと `st_owner` の絞り込みを読取について越えるからである**
//    (`src/server/owner-scope.ts` の `roleReadCrossesOwnerScope`)。
//    **条件を付けないと、他人の個人行が運営に見えてしまい、題材の意味が変わる。**
//    **書込・削除には条件を付けない** —— **そちらは `st_owner` が今日も `AND` で効く。**
//  - **`customer`**: **`st_owner` か `st_public` を宣言した表だけ**(= 閉じる前に
//    `nonAdminTableAccess` が `scoped` / `public` と判定していた表だけ)。
//    **どちらの規約も持たない表(`denied`)には1本も足さない。**
//  - **`anonymous`**: **`st_public` を宣言した表と、その表を写す画面だけ。**
//    **それ以外の画面・表には1本も足さない**(未ログインの既定は閉じたままである)。
//  - **画面は `customer` にも全部足してよい** —— **`canUseView` は「表を読めるか」と
//    `AND` なので、画面の規則だけでは表の区分を1ミリも広げない。**
//
// ## **【正直に書く】ここに書いてあることは1つも検証していない**
//
// **本タスクは E2E を1度も走らせていない**(担当の明文)。**したがって
// 「足りない」「多すぎる」のどちらも実測で否定できていない。** **既知のリスクは
// 実施記録に残すこと。**
// =====================================================================================

/** 個人所有の目印(`src/server/owner-scope.ts` の `OWNER_FIELD` と同じ綴り)。 */
const OWNER_FIELD = "st_owner";

/** 公開の目印(同 `PUBLIC_FIELD`)。 */
const PUBLIC_FIELD = "st_public";

/** その表が規約フィールドを宣言しているか(型まで見る。`required` は付かない規約)。 */
function declaresConvention(table: Manifest["app"]["tables"][number], fieldId: string): boolean {
  return table.fields.some(
    (field) => field.id === fieldId && field.required !== true && field.type !== "reference",
  );
}

/**
 * **`st_owner`(作った人だけの表)の読取に付ける条件**(`V8-M26` / ユーザ決定 `D-V8-70`)。
 *
 * **`src/kernel/apply-diff.ts` の `defaultTableGrantPlan` が入れるのとまったく同じ形である。**
 * **毎回新しいオブジェクトを返す** —— **同じ参照を複数の規則で共有すると、あとで1本を
 * 書き換えたときに他まで変わる**(自動付与の側が `structuredClone` している理由と同じ)。
 *
 * **【正直に書く】同じ形が2箇所にある。** **片方だけを変えると黙ってずれる** ——
 * **E2E のフィクスチャはカーネルを import して規則を組み立てているわけではない。**
 */
const OWNER_SCOPE_READ_CONDITION = () => ({
  or: [
    { field: OWNER_FIELD, equals_current_user: true },
    { field: OWNER_FIELD, is_empty: true },
  ],
});

/** 運営3ロールが表に持つ動詞(`V8-M26-T04` の `DEFAULT_ROLE_RULE_VERBS` と同じ組)。 */
const ADMIN_TABLE_VERBS = {
  owner: ["read", "write", "delete"],
  editor: ["read", "write"],
  viewer: ["read"],
} as const;

/**
 * **面の規則をその場で書き足して、同じ参照を返す。**
 *
 * **足すのは「どの役割からも1度も名指しされていない対象」だけである**(**追記であって
 * 上書きではない**)—— **題材が自分で書いた規則を1バイトも書き換えない。**
 * **`V8-M26-T04`(作るたびの自動付与)が「同じ対象を名指しした規則が既に在るなら
 * 足さない」としているのと同じ作法である。**
 *
 * **稼働中の差し替え(`POST /__e2e__/apps/:app_id/manifest`)でも呼ぶ** ——
 * **そこは `applyManifest` であって差分の畳み込みではないので、`T04` の自動付与が
 * 1本も入らないからである。** **テストが後から足した表・画面も、ここで面に載る。**
 */
function grantFixtureRoleRules(source: Manifest): Manifest {
  const app = source.app as Manifest["app"] & {
    roles?: { id: string; rules?: RoleRule[] }[];
  };
  const declared = app.roles ?? [];
  /** どの役割かによらず、その対象を1度でも名指ししている規則が在るか。 */
  const named = (predicate: (rule: Record<string, unknown>) => boolean): boolean =>
    declared.some((role) =>
      (role.rules ?? []).some((rule) => predicate(rule as unknown as Record<string, unknown>)),
    );
  const namedTable = (tableId: string): boolean =>
    named((rule) => rule.target === "table" && rule.table === tableId);
  const namedView = (viewId: string): boolean =>
    named((rule) => rule.target === "view" && rule.view === viewId);
  const namedAction = (viewId: string, actionId: string): boolean =>
    named((rule) => rule.target === "action" && rule.view === viewId && rule.action === actionId);

  const rulesOf: Record<string, RoleRule[]> = {
    owner: [],
    editor: [],
    viewer: [],
    customer: [],
    anonymous: [],
  };
  const publicTables = new Set<string>();
  /** **購入者(`customer`)が届く表**(個人所有か、公開規約を宣言した表)。 */
  const customerTables = new Set<string>();

  for (const table of app.tables) {
    const scoped = declaresConvention(table, OWNER_FIELD);
    const shared = declaresConvention(table, PUBLIC_FIELD);
    if (shared) {
      publicTables.add(table.id);
    }
    if (namedTable(table.id)) {
      continue;
    }
    // **行ごとの付与(v7 の `access_control`)を宣言した表には1本も足さない**
    // (`V8-M26`)。**面と点は `OR` なので、面で表の読取を許すと、付与を1件も持たない
    // 相手にまで行が見えてしまう** —— **それはその題材が測っている当のものである。**
    // **【正直に書く】この歯止めが効くのはここを通る表だけである** ——
    // **`POST /api/apps/:app_id/diffs` で作られた表には `V8-M26-T04`(作るたびの自動付与)が
    // 無条件の規則を入れるので、そちらは1ミリも止められていない。**
    if ((table as { access_control?: unknown }).access_control !== undefined) {
      continue;
    }
    for (const roleId of ["owner", "editor", "viewer"] as const) {
      const verbs = ADMIN_TABLE_VERBS[roleId];
      if (scoped) {
        // **読取だけ「自分の行」に絞る**(面が `st_owner` を越えるのを防ぐ)。
        // **【`V8-M26` / ユーザ決定 `D-V8-70`。旧の1行を逐語で残す】**
        // **旧: `when: { field: OWNER_FIELD, equals_current_user: true },`**
        // **今日は「自分の行、または持ち主が空の行」である** ——
        // **`src/kernel/apply-diff.ts` の自動付与とまったく同じ形にそろえてある**
        // (ここが古いままだと、共有化した行が E2E からだけ見えなくなる)。
        rulesOf[roleId]?.push({
          target: "table",
          table: table.id,
          can: ["read"],
          when: OWNER_SCOPE_READ_CONDITION(),
        } as RoleRule);
        const writes = verbs.filter((verb) => verb !== "read");
        if (writes.length > 0) {
          rulesOf[roleId]?.push({ target: "table", table: table.id, can: [...writes] } as RoleRule);
        }
      } else {
        rulesOf[roleId]?.push({ target: "table", table: table.id, can: [...verbs] } as RoleRule);
      }
    }
    if (scoped) {
      rulesOf.customer?.push({
        target: "table",
        table: table.id,
        can: ["read"],
        // **【`V8-M26` / `D-V8-70`】旧: `{ field: OWNER_FIELD, equals_current_user: true }`。**
        when: OWNER_SCOPE_READ_CONDITION(),
      } as RoleRule);
      rulesOf.customer?.push({ target: "table", table: table.id, can: ["write"] } as RoleRule);
      customerTables.add(table.id);
    } else if (shared) {
      rulesOf.customer?.push({ target: "table", table: table.id, can: ["read"] } as RoleRule);
      rulesOf.anonymous?.push({ target: "table", table: table.id, can: ["read"] } as RoleRule);
      customerTables.add(table.id);
    }
  }

  for (const view of app.views) {
    if (!namedView(view.id)) {
      for (const roleId of ["owner", "editor", "viewer"] as const) {
        rulesOf[roleId]?.push({ target: "view", view: view.id, can: ["read"] } as RoleRule);
      }
      // **【`V8-M26`。配りすぎを1つ削った。実測で緑を確かめてある】**
      // **旧: 上の `for` に `"customer"` が入っており、購入者にもアプリの**全画面**の
      // 読取が配られていた。** **製品として現実的でない** —— **買う人に運営の画面まで
      // 開いてしまう。** **今日は「購入者が届く表の画面」だけに絞る**
      // (個人所有の表か、公開規約を宣言した表。**表を持たない画面は今日どおり配る**)。
      // **`test:e2e` は 98 passed / 0 failed のままである**(削る前と同じ本数)。
      if (view.table === undefined || customerTables.has(view.table)) {
        rulesOf.customer?.push({ target: "view", view: view.id, can: ["read"] } as RoleRule);
      }
      if (view.table !== undefined && publicTables.has(view.table)) {
        rulesOf.anonymous?.push({ target: "view", view: view.id, can: ["read"] } as RoleRule);
      }
    }
    // **操作起点(ボタン)は識別子を持つものだけ名指しできる**(持たないものは今日も出る)。
    for (const action of (view as { actions?: { id?: string }[] }).actions ?? []) {
      if (typeof action.id !== "string" || namedAction(view.id, action.id)) {
        continue;
      }
      // **【`V8-M26`。ここは削れなかった。実測を残す】**
      // **画面(上のブロック)と同じ線で `customer` を「届く表のボタンだけ」に絞ったところ、
      // `web/e2e/ref-ec-cart-to-order.e2e.ts` の `(C-6)` が 403 で落ちた** ——
      // **応答の逐語: 「表 "cart_line" に対する作成は、あなたの役割に許されていません。」**
      // **原因は書込の壁である** —— **`withoutWriteWallOn()` はテスト側でボタンを名指しする
      // 規則を落とすが、その後にこの関数が「名指しされていないボタン」として同じ規則を
      // 配り直す。** **`customer` に配り直すのをやめると、壁が復活してその表への作成が
      // 止まる。** **したがってここの配りすぎは、壁の再生と表裏一体であり、
      // このブロックだけでは削れない。**
      for (const roleId of ["owner", "editor", "viewer", "customer"] as const) {
        rulesOf[roleId]?.push({
          target: "action",
          view: view.id,
          action: action.id,
          can: ["read"],
        } as RoleRule);
      }
    }
  }

  // **既存の宣言に併合する**(役割ごと。**規則が0本の役割は宣言しない** ——
  // スキーマの `rules` は `minItems: 1`)。
  const merged = [...declared];
  for (const [id, rules] of Object.entries(rulesOf)) {
    if (rules.length === 0) {
      continue;
    }
    const existing = merged.find((role) => role.id === id);
    if (existing === undefined) {
      merged.push({ id, rules });
    } else {
      existing.rules = [...(existing.rules ?? []), ...rules];
    }
  }
  if (merged.length > 0) {
    // **【`V8-M28` / `T-G16a` / ユーザ決定 `D-V8-59`】持ち主に定義の2行を必ず持たせる。**
    // **役割を宣言したアプリは、`owner` の `rules` に
    // `{"target":"app","can":["write"]}` と `{"target":"role","can":["write"]}` の
    // 2本が無いと、適用時検査(類型17 の拡張)が丸ごと拒否する** ——
    // **実測の逐語(直す前の E2E の起動失敗): 「既定の役割 "owner" から "app" + "write" /
    // "role" + "write" の規則が消えています。」**
    // **直したのは題材の側だけである** —— **判定を1ミリも緩めていない。**
    // **既に在れば足さない**(この関数の他の追記とまったく同じ作法)。
    // **`src/server/test-helpers.ts` の `grantOwnerDefinitionRules` と同じ形が
    // ここにも写しとして在る**(`ADR-0009` により層をまたいで import できない)——
    // **片方だけ変えると黙ってずれる。**
    const ownerRole = merged.find((role) => role.id === "owner");
    if (ownerRole !== undefined) {
      const ownerRules = [...(ownerRole.rules ?? [])];
      for (const target of ["app", "role"] as const) {
        const has = ownerRules.some(
          (rule) => (rule as unknown as Record<string, unknown>).target === target,
        );
        if (!has) {
          ownerRules.push({ target, can: ["write"] } as unknown as RoleRule);
        }
      }
      ownerRole.rules = ownerRules;
    }
    app.roles = merged;
  }
  return source;
}

const manifest = grantFixtureRoleRules(JSON.parse(readFileSync(fixturePath, "utf8")) as Manifest);

const dataRoot = mkdtempSync(join(tmpdir(), "gp-e2e-"));

/** フィクスチャのマニフェストをそのままの app_id で1個入れる(手動確認用)。 */
function installFixtureApp(appId: string, appName: string, source: Manifest): Manifest {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, appName, { app_id: appId });
  } finally {
    store.close();
  }

  const applied = applyManifest(dataRoot, appId, source);
  if (!applied.valid) {
    throw new Error(`フィクスチャの適用に失敗しました: ${JSON.stringify(applied.errors)}`);
  }
  return applied.manifest;
}

installFixtureApp(manifest.app.id, manifest.app.name, manifest);

/**
 * **配る版が描くアプリのID**(`V10-M7-T05`)。
 *
 * **配る版はビルド時にアプリIDを焼き込む**(`web/vite.config.ts` の `runner` モードの
 * `define` が `GP_RUNNER_APP_ID` を入れる)。**実行時に差し替える口は1つも無い。**
 * **したがって、ここで入れるアプリのIDと、`package.json` の `test:e2e` が
 * `bun run build:runner` に渡す `GP_RUNNER_APP_ID` と、`web/e2e/runner-flow.e2e.ts` の
 * `RUNNER_APP_ID` は、同じ綴りでなければならない**(3箇所に同じ値が在る。
 * **`PROVISION_PATH` などと同じく、テストとサーバで綴りを共有する形である**)。
 *
 * **払い出し(`provisionApp`)を使えない** —— **払い出しは毎回違うIDを作るが、
 * 配る版が描く先は焼き込まれた1つだけだからである。**
 * **結果として、配る版の検査は1本のアプリを共有する。**
 */
const RUNNER_APP_ID = "runner-e2e";
const runnerSource = structuredClone(manifest);
runnerSource.app.id = RUNNER_APP_ID;
runnerSource.app.name = `${manifest.app.name} (runner)`;
installFixtureApp(RUNNER_APP_ID, runnerSource.app.name, runnerSource);

/**
 * テスト1件分のアプリインスタンスを払い出す。
 *
 * 差し替えるのは `app.id` と `app.name` だけで、テーブル・ビュー・フィールドは
 * フィクスチャのまま。したがってテストの期待値は今までどおり**フィクスチャの JSON
 * から導ける**(アプリ固有の名前はどこにも増えない)。
 */
let provisioned = 0;
function provisionApp(): Response {
  provisioned += 1;
  const suffix = `-e2e-${provisioned}`;
  const appId = `${manifest.app.id.slice(0, RESOURCE_ID_MAX_LENGTH - suffix.length)}${suffix}`;
  const appName = `${manifest.app.name} (e2e ${provisioned})`;

  const instance = structuredClone(manifest);
  instance.app.id = appId;
  instance.app.name = appName;

  const applied = installFixtureApp(appId, appName, instance);
  return Response.json({ app_id: appId, app_name: appName, manifest: applied }, { status: 201 });
}

/**
 * 稼働中のアプリのマニフェストを差し替える(V0-P3-T07)。
 * サーバは**再起動しない**。この呼び出しの後、次のリクエストからもう新しい
 * マニフェストで応答するはずである、というのが検証したい性質そのもの。
 */
function replaceManifest(appId: string, next: unknown): Response {
  // **【`V8-M26`】差し替えた先の表・画面にも面の規則を載せる**(上の `grantFixtureRoleRules`
  // の doc)。**`applyManifest` は差分の畳み込みではないので `V8-M26-T04` の自動付与が
  // 1本も入らず、テストが足した表・画面は既定で閉じたままになる。**
  // **既に名指しされている対象には1バイトも足さない**(追記であって上書きではない)。
  const source =
    typeof next === "object" && next !== null && "app" in next
      ? grantFixtureRoleRules(next as Manifest)
      : next;
  const applied = applyManifest(dataRoot, appId, source);
  if (!applied.valid) {
    return Response.json({ errors: applied.errors }, { status: 400 });
  }
  return Response.json({ manifest: applied.manifest, plan: applied.plan });
}

/**
 * **稼働中のアプリのコメントの出し入れを倒す**(`V10-M31-T03`)。
 * **サーバは再起動しない** —— **倒した後の `GET /manifest` からもう新しい値が載る、
 * というのが `web/e2e/comment-visibility.e2e.ts` の2本目が測る性質そのものである。**
 *
 * **中身は `KernelMetaStore.open(dataRoot)` → `setCommentVisibility` → `close()` の3行**
 * (`installFixtureApp` と同じ形。`replaceManifest` は store を開かないので、あちらの形ではない)。
 * **判定も既定値の計算もここに1行も置かない** —— **片側だけを渡せることも、省いた側が
 * 今の値のまま残ることも、`src/kernel/meta-store.ts` の担当である。**
 *
 * **返すのは倒した後の実物**(`setCommentVisibility` が `UPDATE` の後に読み直した値)。
 */
function flipCommentVisibility(
  appId: string,
  patch: { write?: boolean; read?: boolean },
): Response {
  const store = KernelMetaStore.open(dataRoot);
  try {
    return Response.json({
      app_id: appId,
      comment_visibility: store.setCommentVisibility(appId, patch),
    });
  } catch (reason) {
    // **台帳に無い app_id は例外になる**(カーネルの決め)。**500 にせず 400 で綴りを返す** ——
    // **テスト側が「アプリを間違えた」と読めるようにするためである。**
    return Response.json({ errors: [{ path: "", message: String(reason) }] }, { status: 400 });
  } finally {
    store.close();
  }
}

/**
 * **切り替えの本文を読む**(`{"write"?: boolean, "read"?: boolean}`)。
 *
 * **`D-V10-36` が2つの切り替えを1つに畳むことを禁じているので、片側だけを送れる形にする**
 * —— **省いた側はここで既定値を作らず、キーごと落とす**(カーネルが今の値を残す)。
 */
async function readCommentVisibilityPatch(
  request: Request,
): Promise<{ write?: boolean; read?: boolean }> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  const body = JSON.parse(text) as { write?: unknown; read?: unknown };
  const patch: { write?: boolean; read?: boolean } = {};
  if (typeof body.write === "boolean") {
    patch.write = body.write;
  }
  if (typeof body.read === "boolean") {
    patch.read = body.read;
  }
  return patch;
}

/**
 * 対象アプリにテスト用の user+session を仕込み、cookie の材料を返す。
 * cookie の Path は `/api/apps/:app_id`(サーバ側 setCookie と同じスコープ)。
 *
 * V1-M3-T02: リクエストボディに `{"role": "owner"|"editor"|"viewer"}` があれば
 * その role のユーザを仕込む(権限シナリオの E2E 用)。ボディが無ければ `seedSession`
 * の既定(owner)。仕込んだユーザの id / username / role も返し、テスト側が
 * ユーザ管理画面の行(`data-user-id`)を同定できるようにする。
 */
async function provisionSession(appId: string, request: Request): Promise<Response> {
  const role = await readRole(request);
  const seeded = seedSession(dataRoot, appId, role === undefined ? undefined : { role });
  return Response.json(
    {
      name: "st_session",
      value: seeded.sessionId,
      path: `/api/apps/${appId}`,
      userId: seeded.userId,
      username: seeded.username,
      role: seeded.role,
    },
    { status: 201 },
  );
}

/** POST ボディ(任意)から role を読む。空ボディ = 指定なし(seedSession の既定)。 */
async function readRole(request: Request): Promise<Role | undefined> {
  const text = await request.text();
  if (text.trim() === "") {
    return undefined;
  }
  const body = JSON.parse(text) as { role?: Role };
  return body.role;
}

/**
 * **島(`function`)のランタイムを、待ち受けを始める前に用意する**(`V5-M26-T01`)。
 *
 * **【なぜ足したか。実測で踏んだ】** **足す前、`run_function` を含むワークフローを
 * 発火させるレコード書込は 400 で断られていた** —— 応答の逐語は
 * 「**関数 "fn-line-total" の実行に失敗しました(error): island runtime not ready**」であり、
 * **ワークフローが失敗した書込は1バイトも残らない**(カーネルの既定)。
 * **したがって参照 EC の「カートに入れる」は、この行が無いとブラウザから1度も通らない。**
 *
 * **製品の起動経路(`src/server/index.ts` / `scripts/ref-ec/serve.ts`)は着手前から
 * これを呼んでいる。** **呼んでいなかったのは E2E のフィクスチャサーバだけである** ——
 * **`V5-M18` の e2e が「`cart_line` を1行も作っていない」と申告していたのは、
 * 実際にはここで断られるからでもある**(`docs/plan/v5/records/v5-m26.md` §5-1)。
 *
 * **既存の E2E の挙動を1つも変えない** —— **`fixtures/valid/inventory-all-field-types.json`
 * は `function` を1本も持たないので、この待ち合わせは既存23本にとって空振りである。**
 * **【2026-08-16 訂正(`V8-M13-T04`)。直前の1行を1バイトも書き換えていない】この「23本」は今日は24本である**
 * (`V8-M13-T02` が `read_report` を足した)。**空振りであることは1ミリも変わっていない。**
 */
await ensureIslandRuntimeReady();

const app = createServerApp({ dataRoot, webDistDir: join(repoRoot, "web", "dist") });

/**
 * **配る版(実行専用の版)を配る2本目のサーバ**(`V10-M7-T05`)。
 *
 * **育成用の版と違うのは3つだけである**:
 *
 * 1. **配信元が `web/runner/dist`** —— `bun run build:runner` の出力先
 *    (`web/vite.config.ts` の `runner` モード)。
 * 2. **起動プロファイルが `runner`** —— **編集系5ルートと `GET /api/apps` を1本も
 *    登録しない**(`src/server/app.ts` の `profile === "full"` の分岐)。
 *    **配る版を測っていることの証拠は、ここから出る** ——
 *    **同じ `POST /api/apps/:app_id/diffs` が、育成用の版では 404 にならず、
 *    こちらでは 404 になる。**
 * 3. **`/__e2e__/*` の前段を1本も持たない** —— **払い出しもセッションの仕込みも
 *    マニフェストの差し替えも、育成用の版の側(1本目)だけに在る。**
 *
 * **`dataRoot` は同じ**である。**同じアプリを、2つの版が別の入口から配る形になる。**
 *
 * **【`web/runner/dist/index.html` が要る】** **`runner` モードの入口は
 * `web/runner.html` なので、成果物には `runner.html` しか無い。**
 * **`src/server/app.ts` の SPA フォールバックが見るのは `index.html` 1本だけである** ——
 * **`Dockerfile` が `mv web/runner/dist/runner.html web/runner/dist/index.html` で
 * 埋めているのと同じ穴を、`package.json` の `test:e2e` の前段でも踏む。**
 *
 * **先に建てる** —— **playwright が待つのは1本目(`readyURL`)なので、
 * 1本目が応え始めた時点で2本目も待ち受けている、という順序にしておく。**
 */
const runnerApp = createServerApp({
  dataRoot,
  webDistDir: join(repoRoot, "web", "runner", "dist"),
  profile: "runner",
});

const runnerServer = Bun.serve({
  hostname: "127.0.0.1",
  port: runnerPort,
  async fetch(request: Request): Promise<Response> {
    return runnerApp.fetch(request);
  },
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === PROVISION_PATH) {
      return provisionApp();
    }
    const sessionMatched = SESSION_PATH_PATTERN.exec(pathname);
    if (request.method === "POST" && sessionMatched !== null) {
      return provisionSession(decodeURIComponent(sessionMatched[1] ?? ""), request);
    }
    const matched = MANIFEST_PATH_PATTERN.exec(pathname);
    if (request.method === "POST" && matched !== null) {
      return replaceManifest(decodeURIComponent(matched[1] ?? ""), await request.json());
    }
    // **【`V10-M31-T03`】コメントの出し入れを倒す前段**(上の3本と同じ作法で1本足しただけ)。
    // **`app.fetch` へ落ちる前に捕まえる** —— **製品のサーバはこの綴りを知らない。**
    const visibilityMatched = COMMENT_VISIBILITY_PATH_PATTERN.exec(pathname);
    if (request.method === "POST" && visibilityMatched !== null) {
      return flipCommentVisibility(
        decodeURIComponent(visibilityMatched[1] ?? ""),
        await readCommentVisibilityPatch(request),
      );
    }
    return app.fetch(request);
  },
});

let cleaned = false;
function cleanup(): void {
  if (cleaned) {
    return;
  }
  cleaned = true;
  // **【`V10-M7-T05`】待ち受けは2本ある。** **どちらも閉じてから一時ディレクトリを消す**
  // —— **開いたままだと、消した先を掴んだ接続が残る。**
  runnerServer.stop(true);
  server.stop(true);
  rmSync(dataRoot, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}
process.on("exit", cleanup);

console.log(
  `e2e fixture server: http://${server.hostname}:${server.port} ` +
    `(dataRoot=${dataRoot}, expectedOrigin=${e2eOrigin})`,
);
// **【`V10-M7-T05`】配る版の待ち受けも名乗る**(どちらの版を見ているかをログで区別できる)。
console.log(
  `e2e runner server: http://${runnerServer.hostname}:${runnerServer.port} ` +
    `(profile=runner, app=${RUNNER_APP_ID}, dist=web/runner/dist)`,
);
