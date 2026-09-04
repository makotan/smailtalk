/**
 * **配布物のイメージが満たすべき契約**(`V5-M7-T03` / `R-G1` のイメージ側)。
 *
 * ## なぜ定数を別ファイルに切ったのか
 *
 * **検査の本体(`verify-image.ts`)と、その検査を検査する側(`verify-image.test.ts`)が
 * 同じ一覧を見るためである。** 一覧を2箇所に書くと、片方だけ直したときに静かに食い違う。
 *
 * ## ここに書いてある名前の出所(**推測で書いていない**)
 *
 * | 一覧 | 出所 |
 * |---|---|
 * | 編集系5ルート / 編集系 middleware 2本 | `src/server/runner-profile.test.ts` の `EDIT_ROUTES` / `EDIT_MIDDLEWARE`(`v5-m0.md` §6-3 が名指しした5本) |
 * | `D-V5-96` が落とす5エントリ | 同 `OWNER_DROPPED_ROUTES`(`v5-distribution-handover.md` §2-2) |
 * | 残す12本 | 同 `KEPT_OWNER_ROUTES`(`D-V5-96`) |
 * | 画面の禁止マーカー | `web/test/runner-entry-boundary.test.ts` の `FORBIDDEN`(`V5-M4-T02` が実測で「目印が死んでいない」ことを確かめた集合) |
 *
 * **【禁止の履行】この契約は「編集できない」ことを1ミリも主張しない**
 * (`docs/plan/v5/01-distribution-baseline.md` §8-1 の禁止1)。
 * **主張するのは「今日の `Dockerfile` が作るイメージに入っていない」までである。**
 * **`Dockerfile` を書き換えれば、ここに挙げたものはどれも入る。**
 */

/** 起動プロファイルを決める環境変数(`src/server/app.ts` の `SERVER_PROFILE_ENV` と同じ綴り)。 */
export const SERVER_PROFILE_ENV = "ST_SERVER_PROFILE";
/** 配布物が要求する値。 */
export const REQUIRED_SERVER_PROFILE = "runner";

/**
 * **「その口はこの配布物に無い」の 404 本文の目印**(`src/server/app.ts` の `app.notFound`)。
 *
 * **ステータスだけを見てはならない** —— **`V5-M3b` の変異検査が「ステータスだけ見ていたら
 * 通り抜けた」ことを実測している**(`docs/plan/v5/records/v5-m3b.md`)。
 * **401 でも 403 でも 404 でもない別の 404(SPA フォールバックや業務上の不在)と
 * 区別できるのは本文だけである。**
 */
export const ROUTE_ABSENT_BODY_MARKER = "に対応するエンドポイントはありません。";

/** `{app}` を配るアプリのIDに差し替えて使うルートの型。 */
export type RouteProbeSpec = {
  readonly label: string;
  readonly method: string;
  /** `{app}` を含むパス。 */
  readonly path: string;
};

/**
 * **編集系5ルート**(`v5-m0.md` §6-3)。**イメージの中で1本も登録されていないこと。**
 *
 * **middleware 2本(`ALL /diffs` / `ALL /undo`)は HTTP からは見えない** ——
 * 見えるのは「404 か 401 か」の差であり、**本一覧の5本が 404 本文つきで返ることで
 * 間接的に確かめている**(middleware が残っていれば 401 になる。
 * `runner-profile.test.ts` の `EDIT_MIDDLEWARE` の doc 逐語)。
 */
export const EDIT_ROUTE_PROBES: readonly RouteProbeSpec[] = [
  { label: "差分の適用", method: "POST", path: "/api/apps/{app}/diffs" },
  { label: "巻き戻し", method: "POST", path: "/api/apps/{app}/undo" },
  { label: "巻き戻しの下見", method: "GET", path: "/api/apps/{app}/undo/preview" },
  { label: "変更履歴", method: "GET", path: "/api/apps/{app}/changelog" },
  { label: "要件の定義書", method: "GET", path: "/api/apps/{app}/requirements" },
];

/**
 * **`D-V5-96` が追加で落とした5エントリ**(`v5-distribution-handover.md` §2-2)。
 *
 * **逃げ道CSS の発行・失効・一覧・申請一覧の4本 + `GET /api/apps`。**
 *
 * **【`v5-m3b.md` §6 が実測した穴。隠さない】** **`ALL /escape-hatch-assets` の
 * middleware 2本は `runner` にも残っている。** **その結果、`Origin` ヘッダ付きの
 * 越境 POST は 404 ではなく 403 になる。** **本検査は `Origin` を1つも送らない** ——
 * **送らない条件での 404 だけを確かめている。**
 */
export const OWNER_DROPPED_ROUTE_PROBES: readonly RouteProbeSpec[] = [
  { label: "アプリの一覧", method: "GET", path: "/api/apps" },
  { label: "逃げ道CSSの一覧", method: "GET", path: "/api/apps/{app}/escape-hatch-assets" },
  { label: "逃げ道CSSの発行", method: "POST", path: "/api/apps/{app}/escape-hatch-assets" },
  {
    label: "逃げ道CSSの申請一覧",
    method: "GET",
    path: "/api/apps/{app}/escape-hatch-assets/requests",
  },
  {
    label: "逃げ道CSSの失効",
    method: "DELETE",
    path: "/api/apps/{app}/escape-hatch-assets/gp-probe-asset",
  },
];

/**
 * **`D-V5-96` が「配布物に残す」と決めた運営者の口12本。**
 *
 * **【正直に書く。`D-V5-96` の逐語】** **外部との連携と AI の能力は「申請」までであり、
 * 申請を許可する口は AI 側にあって配布物に入らない。** **配った先で申請しても、
 * 許可する手段が無い。**
 */
export const KEPT_OWNER_ROUTE_PROBES: readonly RouteProbeSpec[] = [
  // 利用者の管理(3本)
  { label: "利用者の一覧", method: "GET", path: "/api/apps/{app}/auth/users" },
  { label: "利用者の役割変更", method: "PATCH", path: "/api/apps/{app}/auth/users/gp-probe-user" },
  { label: "認証の記録", method: "GET", path: "/api/apps/{app}/auth/activity" },
  // 外部との連携(4本)
  { label: "接続の一覧", method: "GET", path: "/api/apps/{app}/connections" },
  { label: "接続の発行", method: "POST", path: "/api/apps/{app}/connections" },
  { label: "接続の申請一覧", method: "GET", path: "/api/apps/{app}/connections/requests" },
  {
    label: "接続の失効",
    method: "DELETE",
    path: "/api/apps/{app}/connections/gp-probe-connection",
  },
  // AI の能力(5本)
  { label: "AIの能力の一覧", method: "GET", path: "/api/apps/{app}/ai-capabilities" },
  { label: "AIの能力の発行", method: "POST", path: "/api/apps/{app}/ai-capabilities" },
  { label: "AIの能力の申請一覧", method: "GET", path: "/api/apps/{app}/ai-capabilities/requests" },
  {
    label: "AIの能力の上限変更",
    method: "PATCH",
    path: "/api/apps/{app}/ai-capabilities/gp-probe-capability/limit",
  },
  {
    label: "AIの能力の失効",
    method: "DELETE",
    path: "/api/apps/{app}/ai-capabilities/gp-probe-capability",
  },
];

/**
 * **アプリ一覧の画面と運営/育成用パネルの目印**(`web/test/runner-entry-boundary.test.ts`
 * の `FORBIDDEN` と同じ集合。**同じ理由で選ばれている**)。
 *
 * **`V5-M4-T02` は「既存エントリの成果物にはこの目印が実在する」ことを (a) で実測済みである。**
 * **本ファイルはその実測を借りている** —— **借りていることを明記する。**
 * **目印が改名されたとき、赤くなるのは `V5-M4-T02` の (a) であって本検査ではない。**
 *
 * ## **【2026-08-26 訂正。`V10-M33-T03`。台帳 `CM-G43`。上の doc を1バイトも書き換えていない】**
 *
 * **上の「`FORBIDDEN` と同じ集合」は今日は偽である。そして着手前から偽であった。**
 *
 * - **今日の実数**(本タスクが機械で数え直した): 本定数 **20要素** /
 *   `web/test/runner-entry-boundary.test.ts` の `FORBIDDEN` **27要素**。
 *   数え方は `awk` で宣言から `];` までを切り出し、`LC_ALL=C /usr/bin/grep -c 'marker: "'`
 *   (**型宣言の行 `readonly marker: string;` を数えないために `"` まで含める。**
 *   含めないと両方とも1多く出る)。陽性対照として同じ範囲の `label: "` も同数になる。
 * - **差は `V10-M33` が作ったものではない。着手前(sha `45e032ab`)から在った** ——
 *   そのとき本定数は **11要素**、`FORBIDDEN` は **18要素**であり、**すでに一致していなかった。**
 * - **本工程が埋めたのは、`V10-M33-T01` が `FORBIDDEN` へ足した9本ぶんだけである**
 *   (**11 → 20**)。**残る差は埋めていない。**
 *   **【禁止】これを「2つの集合を揃えた」と書かない** —— **揃えていない。**
 *
 * **足した9本についても、上の「`V5-M4-T02` の (a) から借りている」という作法は壊していない**
 * —— **9本とも `FORBIDDEN` に在るので、(a) が「既存エントリの成果物に実在する」ことを見ている。**
 *
 * ## **なぜイメージ層にも足すのか**(バンドルの検査だけでは足りない理由)
 *
 * **`web/test/runner-entry-boundary.test.ts` が見ているのは `web/runner/dist/` のバイト列であり、
 * 「イメージに何が焼かれたか」は1バイトも見ていない。**
 * **`Dockerfile` の `COPY` や `scripts/runner-image/prepare-context.ts` が変わって
 * 別のバンドル(例えば既存エントリの `web/dist/`)が焼かれたとき、
 * バンドルの検査は緑のまま、書く欄が配布物に入る。**
 * **本定数はイメージのバイト列を見る (N4) の入力なので、その形の素通りを止める。**
 */
export const FORBIDDEN_SCREEN_MARKERS: readonly {
  readonly label: string;
  readonly marker: string;
}[] = [
  { label: "台帳の全アプリを並べる画面", marker: "アプリがまだありません。" },
  { label: "別のアプリへ移る口(器)", marker: "app-switcher" },
  { label: "別のアプリへ移る口(文言)", marker: "アプリを切り替える" },
  { label: "シェルの未知パス表示", marker: "アプリ一覧から選び直してください" },
  { label: "利用者の管理(器)", marker: "user-admin" },
  { label: "接続まわりの管理(器)", marker: "connection-admin" },
  { label: "逃げ道の管理(器)", marker: "escape-hatch-admin" },
  { label: "テーマ候補の下見", marker: "theme-preview-preface" },
  { label: "テーマの取り込み", marker: "theme-import" },
  { label: "テーマの持ち出し", marker: "theme-export-preface" },
  { label: "要件の定義書", marker: "requirements-preface" },
  // --- **【2026-08-26。`V10-M33-T03`。台帳 `CM-G43`】ここから9本を足した(11 → 20)** ---
  //
  // **`V10-M33-T01` が `web/test/runner-entry-boundary.test.ts` の `FORBIDDEN` へ足した9本を
  // そのまま写した**(**`marker` はバイト列としてそのまま探すので、写し間違いは検査を素通りさせる**)。
  // **`(名乗りなし)` の括弧は半角(`0x28` / `0x29`)である** —— **全角にすると
  // イメージのバイト列と一致せず、この行は「常に緑」の飾りになる。**
  //
  // **【誇張しない】読む場所の4本は「外した」ものではない** —— **`V10-M33-T01` の実測では
  // 着手前から実行専用エントリの成果物に1バイトも入っていなかった。**
  // **ここに足したのは「今日どおり入っていない」をイメージの側でも壊せなくするためである。**
  //
  // --- コメントの書く欄5本 ---
  { label: "コメントの書く欄の器", marker: "comment-panel" },
  { label: "コメントの書く欄の本文入力", marker: "comment-body" },
  { label: "コメントの書く欄の送信", marker: "comment-submit" },
  { label: "コメントの書く欄の送信後の知らせ", marker: "comment-sent" },
  { label: "コメントの書く欄の前置きの文言", marker: "直したいところを書いて送れます" },
  // --- コメントの読む場所4本 ---
  { label: "コメントの読む場所の器", marker: "comment-list" },
  { label: "コメントの読む場所への導線", marker: "open-comment-list" },
  { label: "コメントの読む場所の本文", marker: "comment-item-body" },
  { label: "コメントの読む場所の名乗りの既定", marker: "(名乗りなし)" },
];

/**
 * **MCP が入っていないことの目印**(`v5-m9.md` §5 の 1 / 2)。
 *
 * **`src/mcp/index.ts`(stdio)だけを見る検査では足りない** —— **`http-entry.ts` /
 * `http-transport.ts` も、`package.json` の `mcp` / `mcp:http` スクリプトも見る。**
 */
export const FORBIDDEN_MCP_PATH_FRAGMENTS: readonly string[] = [
  "/src/mcp/",
  "/http-entry.ts",
  "/http-transport.ts",
  "/node_modules/@modelcontextprotocol/",
];

/** **`package.json` そのものを入れない**(`v5-m9.md` §5 の 2 への答え)。 */
export const FORBIDDEN_EXACT_PATHS: readonly string[] = ["/app/package.json"];

/**
 * **MCP の実体を指す文字列。** イメージのどこにも現れてはならない。
 *
 * **【最初に選んだ目印は使えなかった。隠さない】** **`"src/mcp/index.ts"` を目印にしたら
 * 2件当たった** —— `/app/src/server/index.ts` と `/app/src/kernel/workflow-runner.ts` の
 * **doc コメントの中の言及**である(2026-08-06 実測。全文は
 * `docs/plan/v5/records/v5-m7.md` §3)。**MCP の実体は1バイトも入っていないのに赤くなる。**
 * **走査がコメントと実装を区別しないことの実例であり、検査が本当にバイト列を見ている
 * 証拠でもある。** **目印の側を「実装にしか現れない綴り」へ替えた。**
 */
export const FORBIDDEN_CONTENT_MARKERS: readonly {
  readonly label: string;
  readonly marker: string;
}[] = [
  { label: "MCP(HTTP)の起動口(package.json の script 名)", marker: "mcp:http" },
  { label: "MCP の SDK の参照", marker: "@modelcontextprotocol" },
  { label: "MCP(stdio)の輸送", marker: "StdioServerTransport" },
];

/** **移行器が入っていないことの目印**(`ADR-0252` 限定4)。 */
export const FORBIDDEN_MIGRATOR_PATH_FRAGMENTS: readonly string[] = [
  "/migrate-volume.ts",
  "/app/scripts/",
];

/**
 * **イメージに焼いたデータの置き場**(`Dockerfile` の `COPY data-runner-image/data ./image-data`)。
 *
 * **`/data`(利用者のボリューム)ではない。** 検査が見るのは**イメージの中**である。
 */
export const IMAGE_DATA_ROOT = "/app/image-data";

/**
 * **過去の控えの置き場のディレクトリ名**(`ADR-0002` のレイアウト。
 * `src/kernel/storage-paths.ts` の `appSnapshotsDir` と同じ綴り)。
 *
 * **`D-V5-97`(ユーザ決定。2026-08-06)により、配る器にこれを入れない。**
 * **入れると、開発中に消したレコードを含むそのアプリの過去の全状態が配布先に渡る**
 * (`docs/plan/v5/records/v5-m2.md` §4-1 の 1)。
 *
 * **【代償。隠さない】配った先で「配る前の状態に戻す」ことはできなくなる。**
 * **【禁止】これを「安全になった」と書かない。**
 *
 * **綴りを値 import していない理由**: `scripts/runner-image/` から
 * `src/kernel/storage-paths.ts` を値 import すると `scripts/kernel-import-snapshot.txt` が
 * 動く(`ADR-0009` 限定2 の審査対象)。**`src/server/runner-version-gate.ts` が同じ理由で
 * レイアウトを手で書いているのと同型であり、同じ代償(レイアウトが変わっても自動では
 * 追随しない)を負っている。**
 */
export const SNAPSHOTS_DIR_NAME = "snapshots";

/**
 * **配布データに行を1件も入れない表の名前**(`D-V10-39` / `CM-G43` / `V10-M33-T03`)。
 *
 * **選り分けているのは `scripts/build-runner-data.ts` の `RUNNER_EXCLUDED_TABLES` である。**
 * **ここはその結果を、組み立て側ではなく「イメージの `kernel.sqlite`」で見る**
 * (`SNAPSHOTS_DIR_NAME` が `cpSync` の `filter` の結果をバイト列で見ているのと同型)。
 *
 * **綴りを値 import していない理由は `SNAPSHOTS_DIR_NAME` の doc と同じである** ——
 * `scripts/build-runner-data.ts` を値 import すると `bun:sqlite` ごと引き込む。
 * **同じ代償(表名が変わっても自動では追随しない)を負っている。**
 *
 * **【誇張しない】表そのものは配布データにも在る**(DDL は張る)——
 * **配った先で新しくコメントを書けることは `D-V10-38` が決めた。**
 * **持ち込まないのは元の環境で書かれた過去の行だけである。**
 */
export const COMMENT_TABLE = "gp_comments";

/**
 * **入っていなければならないもの**(**空のイメージで否定形が全部緑になることを防ぐ**)。
 *
 * **これは「動く」ことの証明ではない。**
 */
export const REQUIRED_PATH_FRAGMENTS: readonly string[] = [
  "/app/src/server/index.ts",
  "/app/src/server/runner-version-gate.ts",
  "/app/web/dist/index.html",
  "/app/image-data/kernel.sqlite",
];
