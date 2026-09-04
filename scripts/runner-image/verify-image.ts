/**
 * **組み上がったイメージの中身に対する否定形の検査**(`V5-M7-T03` / `R-G1` のイメージ側)。
 *
 * ## `V5-M4` / `V5-M3` の検査との違い(**先に書く**)
 *
 * | 誰が | 何を見ているか |
 * |---|---|
 * | `src/server/runner-profile.test.ts`(`V5-M3-T02`) | **Hono に登録されたルートの一覧**(プロセス内)。**イメージを1バイトも見ていない** |
 * | `web/test/runner-entry-boundary.test.ts`(`V5-M4-T02`) | **`web/runner/dist/` のバイト列**。**イメージを1バイトも見ていない**(同ファイルが自ら申告) |
 * | **本ファイル**(`V5-M7-T03`) | **`docker build` が作ったイメージの中のファイル**と、**そのイメージから起動した実コンテナへの実 HTTP** |
 *
 * ## 検査の形は2つある(発注書の完了条件2)
 *
 * 1. **イメージの中のファイルを走査する** —— `docker run --entrypoint /bin/sh` で
 *    `find` と `grep` を回す。**イメージのルートファイルシステム全体**が対象である。
 * 2. **走っているコンテナを実 HTTP で叩く** —— **ステータスだけでなく本文まで見る。**
 *    **`V5-M3b` の変異検査が「ステータスだけ見ていたら通り抜けた」ことを実測している。**
 *
 * ## 判定の本体は純関数である
 *
 * `checkImage` は**集めた事実だけ**を受け取り、`docker` を1回も呼ばない。
 * **`verify-image.test.ts` が、docker の無い環境でも変異(壊した事実)で赤くなることを固定する。**
 *
 * ## 【禁止の履行】
 *
 * **本ファイルは「編集できない」ことを1ミリも主張しない**(`01` §8-1 の禁止1)。
 * **主張するのは「今日の `Dockerfile` が作ったこのイメージに入っていない」までである。**
 * **`Dockerfile` を書き換えれば入る。**
 * **「利用者環境で実証した」とも書かない**(同 禁止6)—— **叩いたのは手元のコンテナである。**
 *
 * ## 使い方
 *
 * ```
 * mise exec -- bun run scripts/runner-image/verify-image.ts \
 *   --image smailtalk-runner:local --app runner-demo --base-url http://127.0.0.1:33000
 * ```
 */
import {
  COMMENT_TABLE,
  EDIT_ROUTE_PROBES,
  FORBIDDEN_CONTENT_MARKERS,
  FORBIDDEN_EXACT_PATHS,
  FORBIDDEN_MCP_PATH_FRAGMENTS,
  FORBIDDEN_MIGRATOR_PATH_FRAGMENTS,
  FORBIDDEN_SCREEN_MARKERS,
  IMAGE_DATA_ROOT,
  KEPT_OWNER_ROUTE_PROBES,
  OWNER_DROPPED_ROUTE_PROBES,
  REQUIRED_PATH_FRAGMENTS,
  REQUIRED_SERVER_PROFILE,
  ROUTE_ABSENT_BODY_MARKER,
  type RouteProbeSpec,
  SERVER_PROFILE_ENV,
  SNAPSHOTS_DIR_NAME,
} from "./image-contract.ts";

/** 実 HTTP で1本叩いた結果。 */
export type RouteProbeResult = {
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** **本文。ステータスだけでは足りない**(`V5-M3b` の実測)。 */
  readonly body: string;
};

/** イメージから集めた事実の全量。**判定はここから先で行う。** */
export type ImageFacts = {
  /** イメージのルートファイルシステムの全ファイルパス(絶対パス)。 */
  readonly paths: readonly string[];
  /** 文字列の目印 → それを含んでいたファイルのパス。 */
  readonly contentHits: Readonly<Record<string, readonly string[]>>;
  /** `docker image inspect` の `Config.Env`。 */
  readonly imageEnv: readonly string[];
  /** `image-data/apps/` の直下(= イメージに焼いたアプリのディレクトリ)。 */
  readonly imageAppDirs: readonly string[];
  /** イメージの `kernel.sqlite` の `apps` テーブルの `app_id` 全量。 */
  readonly kernelAppIds: readonly string[];
  /** 同 `changelog` テーブルの `app_id` の異なり値。 */
  readonly kernelChangelogAppIds: readonly string[];
  /**
   * **【2026-08-26。`V10-M33-T03`。台帳 `CM-G43`】**
   * 同 `gp_comments`(`COMMENT_TABLE`)テーブルの**行数**。**表そのものが無いときは `null`。**
   *
   * **`null` は (N9) の違反ではない** —— **表が在ること自体は `D-V10-38`(配った先でも
   * 新しくコメントを書ける)の持ち物であって、本検査の主題ではない。**
   * **本検査が見るのは「元の環境で書かれた過去の行が渡っていないこと」だけである。**
   */
  readonly kernelCommentRows: number | null;
  /** 起動中のコンテナへの実 HTTP の結果。 */
  readonly routeProbes: readonly RouteProbeResult[];
  /**
   * **起動確認の1本**(**空のイメージで否定形が緑になるのを防ぐ**)。
   *
   * **【`V8-M21` / `J-G24a` / `D-V8-21` で probe 先を変えた。旧文を1バイトも消していない】**
   * **旧: `GET /api/apps/<app>/manifest` の結果。**
   * **`GET /manifest` は今日からログインを要求するので、器の外から未認証で叩くと 401 に
   * なる** —— **肯定形の検査が「アプリが焼けている」ではなく「認証が効いている」を
   * 測ることになってしまう。** **そこで未ログインでも読める
   * `GET /api/apps/<app>/public`(アプリ名と匿名に開いた画面の名前だけ)へ移した。**
   * **見ているもの(200 で配るアプリのIDが本文に出る)は1バイトも変えていない。**
   */
  readonly startupProbe: RouteProbeResult;
  /** `ST_SERVER_PROFILE` を `runner` 以外にして起動したときの終了コードと標準エラー。 */
  readonly wrongProfileRun: { readonly exitCode: number; readonly stderr: string };
  /** 配るアプリのID。 */
  readonly appId: string;
};

/** 1件の違反。 */
export type Violation = { readonly check: string; readonly detail: string };

/** 検査1件の結果。 */
export type CheckResult = {
  readonly id: string;
  readonly title: string;
  readonly violations: readonly Violation[];
};

/** `{app}` を差し替える。 */
export function resolvePath(spec: RouteProbeSpec, appId: string): string {
  return spec.path.replaceAll("{app}", appId);
}

/**
 * **「その口はこの配布物に無い」の応答か。**
 *
 * **ステータスと本文の両方を見る。** 片方だけでは足りない ——
 * ステータスだけなら SPA フォールバックの 404 や業務上の不在と区別できず、
 * 本文だけなら 200 で同じ文言を返す形と区別できない。
 */
export function isRouteAbsent(probe: RouteProbeResult): boolean {
  return probe.status === 404 && probe.body.includes(ROUTE_ABSENT_BODY_MARKER);
}

function probeOf(facts: ImageFacts, spec: RouteProbeSpec): RouteProbeResult | undefined {
  const path = resolvePath(spec, facts.appId);
  return facts.routeProbes.find((p) => p.method === spec.method && p.path === path);
}

/** パスの断片を含むファイルを列挙する。 */
function pathsContaining(facts: ImageFacts, fragment: string): string[] {
  return facts.paths.filter((p) => p.includes(fragment));
}

/**
 * **否定形8項目 + 起動プロファイル2項目 + 肯定形1項目**を判定する。
 *
 * **`docker` を1回も呼ばない純関数である。**
 */
export function checkImage(facts: ImageFacts): CheckResult[] {
  const results: CheckResult[] = [];

  // --- (N1) 編集系ルートが1本も登録されていない -----------------------------
  results.push({
    id: "N1",
    title: "編集系5ルートが1本も登録されていない(実 HTTP。本文まで見る)",
    violations: EDIT_ROUTE_PROBES.flatMap((spec) => {
      const probe = probeOf(facts, spec);
      if (probe === undefined) {
        return [{ check: "N1", detail: `叩いていない: ${spec.method} ${spec.path}` }];
      }
      return isRouteAbsent(probe)
        ? []
        : [
            {
              check: "N1",
              detail:
                `${spec.label}(${probe.method} ${probe.path})が「無い」応答ではない: ` +
                `status=${probe.status} body=${probe.body.slice(0, 200)}`,
            },
          ];
    }),
  });

  // --- (N2) D-V5-96 が落とした5エントリも 404 -------------------------------
  results.push({
    id: "N2",
    title: "D-V5-96 が落とした5エントリ(逃げ道CSS 4本 + GET /api/apps)も 404 である",
    violations: OWNER_DROPPED_ROUTE_PROBES.flatMap((spec) => {
      const probe = probeOf(facts, spec);
      if (probe === undefined) {
        return [{ check: "N2", detail: `叩いていない: ${spec.method} ${spec.path}` }];
      }
      return isRouteAbsent(probe)
        ? []
        : [
            {
              check: "N2",
              detail:
                `${spec.label}(${probe.method} ${probe.path})が「無い」応答ではない: ` +
                `status=${probe.status} body=${probe.body.slice(0, 200)}`,
            },
          ];
    }),
  });

  // --- (N3) 残す12本は登録されている ----------------------------------------
  //
  // **「404 ではない」ではなく「『その口は無い』の 404 ではない」を見る。**
  // 認証が要る口なので 401 / 403 が返るのが今日の正常である。
  results.push({
    id: "N3",
    title: "D-V5-96 が残す12本(利用者の管理3 / 外部との連携4 / AI の能力5)は登録されている",
    violations: KEPT_OWNER_ROUTE_PROBES.flatMap((spec) => {
      const probe = probeOf(facts, spec);
      if (probe === undefined) {
        return [{ check: "N3", detail: `叩いていない: ${spec.method} ${spec.path}` }];
      }
      // **繋がらなかった(`status = 0`)を緑にしない。** 「叩けなかったので『その口は無い』
      // の 404 ではなかった」は、**登録されている証拠ではない**(変異2 の実測で
      // 実際にこの穴が出た。`docs/plan/v5/records/v5-m7.md` §3)。
      if (probe.status === 0) {
        return [
          {
            check: "N3",
            detail: `${spec.label}(${probe.method} ${probe.path})を叩けなかった: ${probe.body}`,
          },
        ];
      }
      return isRouteAbsent(probe)
        ? [
            {
              check: "N3",
              detail:
                `${spec.label}(${probe.method} ${probe.path})が「その口は無い」の 404 を返した ` +
                `(残すはずの12本である)`,
            },
          ]
        : [];
    }),
  });

  // --- (N4) アプリ一覧の画面がイメージに入っていない -------------------------
  results.push({
    id: "N4",
    title: "アプリ一覧の画面と運営/育成用パネルがイメージに入っていない(ファイル走査)",
    violations: [
      ...FORBIDDEN_SCREEN_MARKERS.flatMap((entry) =>
        (facts.contentHits[entry.marker] ?? []).map((path) => ({
          check: "N4",
          detail: `${entry.label}(${entry.marker})が ${path} に入っている`,
        })),
      ),
      // 画面のソースそのものが入っていないこと(成果物だけを配る形)。
      ...["/app/web/src/", "/AppListPage.tsx", "/AppWorkspace.tsx"].flatMap((fragment) =>
        pathsContaining(facts, fragment).map((path) => ({
          check: "N4",
          detail: `画面のソース(${fragment})が ${path} に入っている`,
        })),
      ),
    ],
  });

  // --- (N5) MCP が入っていない -----------------------------------------------
  results.push({
    id: "N5",
    title: "MCP が入っていない(stdio の入口も HTTP の入口も package.json の起動口も)",
    violations: [
      ...FORBIDDEN_MCP_PATH_FRAGMENTS.flatMap((fragment) =>
        pathsContaining(facts, fragment).map((path) => ({
          check: "N5",
          detail: `MCP のファイル(${fragment})が ${path} に入っている`,
        })),
      ),
      ...FORBIDDEN_EXACT_PATHS.flatMap((exact) =>
        facts.paths.includes(exact)
          ? [{ check: "N5", detail: `${exact} が入っている(scripts の mcp / mcp:http ごと)` }]
          : [],
      ),
      ...FORBIDDEN_CONTENT_MARKERS.flatMap((entry) =>
        (facts.contentHits[entry.marker] ?? []).map((path) => ({
          check: "N5",
          detail: `${entry.label}(${entry.marker})が ${path} に入っている`,
        })),
      ),
    ],
  });

  // --- (N6) 移行器が入っていない(ADR-0252 限定4)-----------------------------
  results.push({
    id: "N6",
    title: "移行器(scripts/migrate-volume.ts)が入っていない(ADR-0252 限定4)",
    violations: FORBIDDEN_MIGRATOR_PATH_FRAGMENTS.flatMap((fragment) =>
      pathsContaining(facts, fragment).map((path) => ({
        check: "N6",
        detail: `移行器側のファイル(${fragment})が ${path} に入っている`,
      })),
    ),
  });

  // --- (N7) 他アプリの行が1件も入っていない ---------------------------------
  const otherAppDirs = facts.imageAppDirs.filter((dir) => dir !== facts.appId);
  const otherKernelApps = facts.kernelAppIds.filter((id) => id !== facts.appId);
  const otherChangelogApps = facts.kernelChangelogAppIds.filter((id) => id !== facts.appId);
  results.push({
    id: "N7",
    title: "他アプリの行が1件も入っていない(イメージの kernel.sqlite とアプリディレクトリ)",
    violations: [
      ...otherAppDirs.map((dir) => ({
        check: "N7",
        detail: `image-data/apps/ に他アプリのディレクトリが在る: ${dir}`,
      })),
      ...otherKernelApps.map((id) => ({
        check: "N7",
        detail: `kernel.sqlite の apps に他アプリの行が在る: ${id}`,
      })),
      ...otherChangelogApps.map((id) => ({
        check: "N7",
        detail: `kernel.sqlite の changelog に他アプリの行が在る: ${id}`,
      })),
      ...(facts.kernelAppIds.includes(facts.appId)
        ? []
        : [
            {
              check: "N7",
              detail: `配るアプリ(${facts.appId})の行が kernel.sqlite の apps に無い`,
            },
          ]),
    ],
  });

  // --- (N8) 過去の控えが1件も入っていない(D-V5-97)---------------------------
  //
  // **`D-V5-97`(ユーザ決定。2026-08-06)= 「器から外す」。**
  // **入っていると、開発中に消したレコードを含むそのアプリの過去の全状態が
  //   配布先に渡る**(`docs/plan/v5/records/v5-m2.md` §4-1 の 1 が名指しし、
  //   `V5-M7` は「入れたままにした」と書いて `CP-V5` へ送った)。
  //
  // **【代償。隠さない】配った先で「配る前の状態に戻す」ことはできなくなる。**
  // **【禁止】これを「安全になった」と書かない。**
  //
  // **選り分けているのは `scripts/build-runner-data.ts` の `cpSync` の `filter` である。**
  // ここは**その結果をイメージのバイト列で見る**(組み立て側の検査とは別の場所を見る)。
  results.push({
    id: "N8",
    title: `過去の控え(${SNAPSHOTS_DIR_NAME}/)が1件も入っていない(D-V5-97)`,
    violations: facts.paths
      .filter(
        (path) =>
          path.startsWith(`${IMAGE_DATA_ROOT}/`) && path.includes(`/${SNAPSHOTS_DIR_NAME}/`),
      )
      .map((path) => ({
        check: "N8",
        detail: `過去の控えが ${path} に入っている(配布先にアプリの過去の全状態が渡る)`,
      })),
  });

  // --- (N9) コメントの行が1件も入っていない(D-V10-39)-------------------------
  //
  // **【2026-08-26。`V10-M33-T03`。台帳 `CM-G43`。独立点検の指摘】**
  //
  // **`D-V10-39`(利用者決定)= 「配った先ではコメントを丸ごと使わない」。**
  // **`V10-M33-T02` は `scripts/build-runner-data.ts` の `RUNNER_EXCLUDED_TABLES` で
  //   コピーの対象から外し、その検査を `scripts/build-runner-data.test.ts` に置いた。**
  // **それは組み立て側の検査であって、「イメージに何が焼かれたか」は1バイトも見ていない。**
  // **`Dockerfile` の `COPY` や `prepare-context.ts` が変わって、
  //   別の `kernel.sqlite`(選り分けを通していないもの)が焼かれたとき、
  //   組み立て側の検査は緑のまま、元の環境で書かれた過去のコメントが配布先へ渡る。**
  // ここは **`N7` / `N8` と同じく、イメージの中身を実際に読んで判定する。**
  //
  // **【誇張しない】表そのものが在ることは違反ではない**(`D-V10-38`)——
  // **見ているのは行数だけである。** 表が無いとき(`null`)も違反にしない
  // (理由は `ImageFacts.kernelCommentRows` の doc)。
  results.push({
    id: "N9",
    title: `コメント(${COMMENT_TABLE})の行が1件も入っていない(D-V10-39。表そのものは在ってよい)`,
    violations:
      facts.kernelCommentRows !== null && facts.kernelCommentRows > 0
        ? [
            {
              check: "N9",
              detail:
                `kernel.sqlite の ${COMMENT_TABLE} に行が ${facts.kernelCommentRows} 件入っている ` +
                `(元の環境で書かれた過去のコメントが配布先に渡る)`,
            },
          ]
        : [],
  });

  // --- (P1) ST_SERVER_PROFILE=runner がイメージに焼かれている -----------------
  //
  // **【V5-M5 が名指しした穴】** `v5-m5.md` の逐語:
  // 「V5-M7 が ST_SERVER_PROFILE=runner を渡し忘れると配布物は full で起動しゲートも
  //   走らない。渡し忘れを赤にする検査は1本もありません」
  const profileEnv = facts.imageEnv.find((entry) => entry.startsWith(`${SERVER_PROFILE_ENV}=`));
  results.push({
    id: "P1",
    title: `イメージに ${SERVER_PROFILE_ENV}=${REQUIRED_SERVER_PROFILE} が焼かれている`,
    violations:
      profileEnv === `${SERVER_PROFILE_ENV}=${REQUIRED_SERVER_PROFILE}`
        ? []
        : [
            {
              check: "P1",
              detail:
                `イメージの Config.Env に ${SERVER_PROFILE_ENV}=${REQUIRED_SERVER_PROFILE} が無い ` +
                `(実際: ${profileEnv ?? "(未設定)"})。渡し忘れると full で起動する`,
            },
          ],
  });

  // --- (P2) runner 以外の値を渡すと起動しない --------------------------------
  results.push({
    id: "P2",
    title: `${SERVER_PROFILE_ENV} に runner 以外を渡すと起動が止まる(黙って full にならない)`,
    violations:
      facts.wrongProfileRun.exitCode !== 0 &&
      facts.wrongProfileRun.stderr.includes(SERVER_PROFILE_ENV)
        ? []
        : [
            {
              check: "P2",
              detail:
                `${SERVER_PROFILE_ENV}=full で起動したのに止まらなかった ` +
                `(exit=${facts.wrongProfileRun.exitCode} stderr=${facts.wrongProfileRun.stderr.slice(0, 300)})`,
            },
          ],
  });

  // --- (Y1) 肯定形。空のイメージで否定形が全部緑になるのを防ぐ ---------------
  results.push({
    id: "Y1",
    title: "配るアプリの定義とファイルが実在する(空のイメージで否定形が緑になるのを防ぐ)",
    violations: [
      ...REQUIRED_PATH_FRAGMENTS.flatMap((fragment) =>
        pathsContaining(facts, fragment).length > 0
          ? []
          : [{ check: "Y1", detail: `入っているべきファイルが無い: ${fragment}` }],
      ),
      ...(facts.startupProbe.status === 200 && facts.startupProbe.body.includes(facts.appId)
        ? []
        : [
            {
              check: "Y1",
              detail:
                `GET ${facts.startupProbe.path} が 200 で配るアプリを返さない ` +
                `(status=${facts.startupProbe.status})`,
            },
          ]),
    ],
  });

  return results;
}

/** 検査結果を人が読む形にする。 */
export function formatCheckResults(results: readonly CheckResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const mark = result.violations.length === 0 ? "OK  " : "NG  ";
    lines.push(`${mark}(${result.id}) ${result.title}`);
    for (const violation of result.violations) {
      lines.push(`      - ${violation.detail}`);
    }
  }
  const failed = results.filter((r) => r.violations.length > 0);
  lines.push("");
  lines.push(
    failed.length === 0
      ? `全 ${results.length} 項目が緑である。`
      : `${failed.length} / ${results.length} 項目が赤である: ${failed.map((r) => r.id).join(" / ")}`,
  );
  return lines.join("\n");
}

// ===========================================================================
// ここから下は事実の採取(docker を呼ぶ)。**判定は1つも行わない。**
// ===========================================================================

function run(cmd: readonly string[]): { exitCode: number; out: string; err: string } {
  const proc = Bun.spawnSync([...cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

/**
 * **イメージの中のファイルを走査する**(検査の形 1)。
 *
 * `docker run --entrypoint /bin/sh` で `find` を回す。**起動口(entrypoint)を
 * 迂回しているのは走査のためであって、起動の検査ではない** —— 起動の検査は (P2) が行う。
 */
function collectPaths(image: string): string[] {
  const script = "find / -xdev -type f -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null";
  const result = run(["docker", "run", "--rm", "--entrypoint", "/bin/sh", image, "-c", script]);
  if (result.exitCode !== 0) {
    throw new Error(`イメージのファイル走査に失敗しました: ${result.err}`);
  }
  return result.out.split("\n").filter((line) => line !== "");
}

/** **イメージの中の文字列を走査する**(検査の形 1)。目印ごとに当たったパスを返す。 */
function collectContentHits(image: string, markers: readonly string[]): Record<string, string[]> {
  // 目印は引数として渡す(ヒアドキュメントを使うと、標準入力から読ませたスクリプトと
  // 入力が混ざる)。`grep -F` で正規表現として解釈させない。
  const script = [
    'for m in "$@"; do',
    '  grep -rlF -- "$m" /app 2>/dev/null | while IFS= read -r p; do',
    '    printf "%s\\t%s\\n" "$m" "$p";',
    "  done;",
    "done",
  ].join("\n");
  const result = run([
    "docker",
    "run",
    "--rm",
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    script,
    "sh",
    ...markers,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`イメージの文字列走査に失敗しました: ${result.err}`);
  }
  const hits: Record<string, string[]> = {};
  for (const marker of markers) {
    hits[marker] = [];
  }
  for (const line of result.out.split("\n")) {
    if (line === "") {
      continue;
    }
    const tab = line.indexOf("\t");
    const marker = line.slice(0, tab);
    const path = line.slice(tab + 1);
    const bucket = hits[marker];
    if (bucket === undefined) {
      hits[marker] = [path];
    } else {
      bucket.push(path);
    }
  }
  return hits;
}

/** **イメージの `kernel.sqlite` を読む**(検査の形 1)。イメージの中の bun で読む。 */
function collectKernelRows(image: string): {
  appIds: string[];
  changelogAppIds: string[];
  appDirs: string[];
  commentRows: number | null;
} {
  const js = [
    'const { Database } = require("bun:sqlite");',
    'const { readdirSync } = require("node:fs");',
    'const db = new Database("/app/image-data/kernel.sqlite", { readonly: true });',
    'const appIds = db.query(`SELECT "app_id" FROM "apps" ORDER BY "app_id"`).all().map((r) => r.app_id);',
    'const changelogAppIds = db.query(`SELECT DISTINCT "app_id" FROM "changelog" ORDER BY "app_id"`).all().map((r) => r.app_id);',
    // **【2026-08-26。`V10-M33-T03`。台帳 `CM-G43`】**
    // **表が無いときに `SELECT count(*)` を投げると例外で落ち、採取が丸ごと失敗する。**
    // **そこで先に `sqlite_master` を引き、無ければ `null` を持ち帰る**
    // (**`null` は (N9) の違反ではない。理由は `ImageFacts.kernelCommentRows` の doc**)。
    `const commentTableExists = db.query(\`SELECT count(*) AS n FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ?\`).get(${JSON.stringify(COMMENT_TABLE)}).n > 0;`,
    `const commentRows = commentTableExists ? db.query(\`SELECT count(*) AS n FROM "${COMMENT_TABLE}"\`).get().n : null;`,
    "db.close();",
    'const appDirs = readdirSync("/app/image-data/apps").sort();',
    "console.log(JSON.stringify({ appIds, changelogAppIds, appDirs, commentRows }));",
  ].join("\n");
  const result = run(["docker", "run", "--rm", "--entrypoint", "bun", image, "-e", js]);
  if (result.exitCode !== 0) {
    throw new Error(`イメージの kernel.sqlite の読み取りに失敗しました: ${result.err}`);
  }
  return JSON.parse(result.out.trim());
}

/** `docker image inspect` の `Config.Env`。 */
function collectImageEnv(image: string): string[] {
  const result = run(["docker", "image", "inspect", "--format", "{{json .Config.Env}}", image]);
  if (result.exitCode !== 0) {
    throw new Error(`docker image inspect に失敗しました: ${result.err}`);
  }
  return JSON.parse(result.out.trim());
}

/**
 * **`runner` 以外の起動プロファイルで実際に起動してみる**(検査の形 2 の一部)。
 *
 * ## **前面実行にしない理由**(`V5-M7d-T03`)
 *
 * **ここは「起動口が止まること」を確かめる場所であり、止まらなくなったときに
 * 呼ばれる。** 起動口の門番が消えれば `exec bun run index.ts` に進み、
 * **`full` プロファイルのサーバが起きて永久に走る。**
 * 前面実行の `docker run` にはタイムアウトが無いので、**この検査が赤くなる代わりに
 * ハングする。** それが `ci-container-check.sh` の手順6 で実際に起きた形である
 * (`docs/plan/v5/records/v5-m7d.md` §1)。
 *
 * そこで `-d` で起こし、締切まで見張り、超えたら**コンテナごと**始末して
 * 「終わらなかった」を事実として持ち帰る(`exitCode` に `TIMED_OUT_EXIT_CODE`)。
 * **`checkImage` の (P2) は `exitCode !== 0` を見ているので、
 * 「終わらなかった」は素通りせずに赤になる** —— ただし `stderr` に
 * `SERVER_PROFILE_ENV` を含めないので、**(P2) は必ず赤になる。**
 *
 * **【`timeout(1)` を使わない理由】** macOS の素の環境に無く、
 * **`timeout` は `docker` の CLI を殺すだけでコンテナは走り続ける**(手元で実測)。
 */
const WRONG_PROFILE_DEADLINE_MS = 60_000;
/** 「締切までに終わらなかった」を表す終了コード。**0 ではない**(素通りさせない)。 */
export const TIMED_OUT_EXIT_CODE = -1;

function runWithWrongProfile(image: string): { exitCode: number; stderr: string } {
  const started = run([
    "docker",
    "run",
    "-d",
    "-e",
    `${SERVER_PROFILE_ENV}=full`,
    "--entrypoint",
    "/usr/local/bin/runner-entrypoint.sh",
    image,
  ]);
  if (started.exitCode !== 0) {
    return { exitCode: started.exitCode, stderr: `${started.err}${started.out}` };
  }
  const containerId = started.out.trim();
  try {
    const deadline = Date.now() + WRONG_PROFILE_DEADLINE_MS;
    while (Date.now() < deadline) {
      const state = run(["docker", "inspect", "-f", "{{.State.Running}}", containerId]);
      if (state.out.trim() !== "true") {
        const code = run(["docker", "inspect", "-f", "{{.State.ExitCode}}", containerId]);
        const logs = run(["docker", "logs", containerId]);
        return {
          exitCode: Number.parseInt(code.out.trim(), 10),
          stderr: `${logs.err}${logs.out}`,
        };
      }
      Bun.sleepSync(500);
    }
    const logs = run(["docker", "logs", containerId]);
    return {
      exitCode: TIMED_OUT_EXIT_CODE,
      stderr:
        `${WRONG_PROFILE_DEADLINE_MS / 1000}秒たっても終わらなかった` +
        `(起動口が止めなかった疑い。コンテナID=${containerId})。ログ:\n${logs.err}${logs.out}`,
    };
  } finally {
    // 【握り潰す理由】後始末である。**既に結果は持ち帰っており、
    // 片付けの失敗で判定を壊したくない。**
    run(["docker", "rm", "-f", containerId]);
  }
}

/** 実 HTTP 1本あたりの待ちの上限(`V5-M7d-T03`)。 */
const PROBE_TIMEOUT_MS = 15_000;

/** **走っているコンテナを実 HTTP で叩く**(検査の形 2)。**本文まで持ち帰る。** */
async function probeRoute(
  baseUrl: string,
  spec: RouteProbeSpec,
  appId: string,
): Promise<RouteProbeResult> {
  const path = resolvePath(spec, appId);
  try {
    return await probeRouteOnce(baseUrl, spec, path);
  } catch (error) {
    // **繋がらなかったことを黙って落とさない。** 変異でコンテナが起動しなくなった場合、
    // ここが `status = 0` を返し、`checkImage` の (N1)〜(N3) / (Y1) が赤になる
    // (**「叩けなかった」を「口が無い」と読み替えない**)。
    return {
      label: spec.label,
      method: spec.method,
      path,
      status: 0,
      body: `(繋がらなかった) ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function probeRouteOnce(
  baseUrl: string,
  spec: RouteProbeSpec,
  path: string,
): Promise<RouteProbeResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: spec.method,
    // **待ちに上限を置く**(`V5-M7d-T03`)。**`fetch` は既定でタイムアウトを持たない** ——
    // 繋がったまま1バイトも返さないサーバに当たると永久に待つ。
    // ここで諦めると `probeRoute` の catch が `status = 0` を持ち帰り、
    // (N1)〜(N3) / (Y1) が**赤になる**(「叩けなかった」を「口が無い」と読み替えない)。
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    // **`Origin` を1つも送らない。** 送ると逃げ道CSS の middleware が 403 を返す
    // (`v5-m3b.md` §6 の実測)。**送らない条件での 404 を見ている。**
    headers:
      spec.method === "POST" || spec.method === "PATCH"
        ? { "content-type": "application/json" }
        : {},
    ...(spec.method === "POST" || spec.method === "PATCH" ? { body: "{}" } : {}),
  });
  return {
    label: spec.label,
    method: spec.method,
    path,
    status: response.status,
    body: await response.text(),
  };
}

export type GatherOptions = {
  readonly image: string;
  readonly appId: string;
  readonly baseUrl: string;
};

/** 事実を全部集める。**判定は1つも行わない。** */
export async function gatherFacts(options: GatherOptions): Promise<ImageFacts> {
  const markers = [
    ...FORBIDDEN_SCREEN_MARKERS.map((entry) => entry.marker),
    ...FORBIDDEN_CONTENT_MARKERS.map((entry) => entry.marker),
  ];
  const paths = collectPaths(options.image);
  const contentHits = collectContentHits(options.image, markers);
  const kernel = collectKernelRows(options.image);
  const imageEnv = collectImageEnv(options.image);
  const wrongProfileRun = runWithWrongProfile(options.image);

  const specs = [...EDIT_ROUTE_PROBES, ...OWNER_DROPPED_ROUTE_PROBES, ...KEPT_OWNER_ROUTE_PROBES];
  const routeProbes: RouteProbeResult[] = [];
  for (const spec of specs) {
    routeProbes.push(await probeRoute(options.baseUrl, spec, options.appId));
  }
  // **【`V8-M21`】旧: `{ label: "マニフェスト", …, path: "/api/apps/{app}/manifest" }`。**
  // **未認証で 200 が返る口へ移した**(理由は `startupProbe` の doc)。
  const startupProbe = await probeRoute(
    options.baseUrl,
    {
      label: "アプリの入口(未ログインに渡る最小限)",
      method: "GET",
      path: "/api/apps/{app}/public",
    },
    options.appId,
  );

  return {
    paths,
    contentHits,
    imageEnv,
    imageAppDirs: kernel.appDirs,
    kernelAppIds: kernel.appIds,
    kernelChangelogAppIds: kernel.changelogAppIds,
    // **【2026-08-26。`V10-M33-T03`。台帳 `CM-G43`】(N9) の入力。**
    kernelCommentRows: kernel.commentRows,
    routeProbes,
    startupProbe,
    wrongProfileRun,
    appId: options.appId,
  };
}

function parseArgs(argv: readonly string[]): GatherOptions {
  let image: string | undefined;
  let appId: string | undefined;
  let baseUrl: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--image") {
      image = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--app") {
      appId = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--base-url") {
      baseUrl = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`読めない引数です: ${argv[i]}`);
    }
  }
  if (image === undefined || appId === undefined || baseUrl === undefined) {
    throw new Error(
      "使い方: bun run scripts/runner-image/verify-image.ts --image <tag> --app <app_id> --base-url <url>",
    );
  }
  return { image, appId, baseUrl };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const facts = await gatherFacts(options);
  const results = checkImage(facts);
  console.log(formatCheckResults(results));
  if (results.some((r) => r.violations.length > 0)) {
    process.exit(1);
  }
}
