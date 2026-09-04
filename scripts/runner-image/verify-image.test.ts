/**
 * **否定形の検査そのものを検査する**(`V5-M7-T03`)。
 *
 * ## なぜ要るのか
 *
 * `verify-image.ts` の判定は `checkImage` という純関数に閉じている。
 * **本ファイルは docker を1回も呼ばず、「事実」を手で壊して赤くなることを固定する。**
 *
 * **これは `Dockerfile` に対する本物の変異の代わりにはならない** ——
 * **本物の変異(`Dockerfile` を実際に壊してイメージを組み直す)は
 * `docs/plan/v5/records/v5-m7.md` §3 に実測として貼ってある。**
 * **本ファイルが守るのは「判定の側が壊れていないこと」だけである。**
 *
 * ## この検査が言えないこと(**丸めない**)
 *
 * - **事実の採取(`gatherFacts`)を1バイトも通っていない。** `find` / `grep` /
 *   `docker image inspect` の綴りが間違っていても、本ファイルは緑のままである。
 * - **`bun test` は docker を要求しない。** イメージに対する本物の検査は
 *   `.github/workflows/ci.yml` の `container` ジョブと、手元の
 *   `scripts/runner-image/verify-image.ts` が走らせる。
 */
import { describe, expect, test } from "bun:test";
import {
  COMMENT_TABLE,
  EDIT_ROUTE_PROBES,
  FORBIDDEN_SCREEN_MARKERS,
  IMAGE_DATA_ROOT,
  KEPT_OWNER_ROUTE_PROBES,
  OWNER_DROPPED_ROUTE_PROBES,
  REQUIRED_SERVER_PROFILE,
  ROUTE_ABSENT_BODY_MARKER,
  SERVER_PROFILE_ENV,
  SNAPSHOTS_DIR_NAME,
} from "./image-contract.ts";
import {
  checkImage,
  type ImageFacts,
  isRouteAbsent,
  type RouteProbeResult,
  resolvePath,
} from "./verify-image.ts";

const APP = "runner-demo";

/** 一覧の n 番目を、無いときに黙って `undefined` にせず取り出す。 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`一覧の ${index} 番目が無い(契約の一覧が空になっている)`);
  }
  return value;
}

/** 「その口はこの配布物に無い」の応答。 */
function absent(method: string, path: string): RouteProbeResult {
  return {
    label: "",
    method,
    path,
    status: 404,
    body: `{"errors":[{"path":"","message":"${method} ${path} ${ROUTE_ABSENT_BODY_MARKER}"}]}`,
  };
}

/** 「その口は在るが認証が要る」の応答。 */
function unauthorized(method: string, path: string): RouteProbeResult {
  return {
    label: "",
    method,
    path,
    status: 401,
    body: '{"errors":[{"path":"","message":"認証されていません。"}]}',
  };
}

/** **全部緑になる事実**(ここを1点ずつ壊す)。 */
function greenFacts(): ImageFacts {
  return {
    paths: [
      "/app/src/server/index.ts",
      "/app/src/server/runner-version-gate.ts",
      "/app/src/kernel/apply-diff.ts",
      "/app/web/dist/index.html",
      "/app/web/dist/assets/index-abc.js",
      "/app/image-data/kernel.sqlite",
      `/app/image-data/apps/${APP}/manifest.json`,
      "/usr/local/bin/runner-entrypoint.sh",
    ],
    contentHits: {},
    imageEnv: [`${SERVER_PROFILE_ENV}=${REQUIRED_SERVER_PROFILE}`, "PORT=3000"],
    imageAppDirs: [APP],
    kernelAppIds: [APP],
    kernelChangelogAppIds: [APP],
    // **【2026-08-26。`V10-M33-T03`。台帳 `CM-G43`】(N9) の入力。**
    // **`0` が緑である** —— **配布データにコメントの過去の行を1件も入れない(`D-V10-39`)。**
    kernelCommentRows: 0,
    routeProbes: [
      ...EDIT_ROUTE_PROBES.map((s) => absent(s.method, resolvePath(s, APP))),
      ...OWNER_DROPPED_ROUTE_PROBES.map((s) => absent(s.method, resolvePath(s, APP))),
      ...KEPT_OWNER_ROUTE_PROBES.map((s) => unauthorized(s.method, resolvePath(s, APP))),
    ],
    // **【`V8-M21` / `J-G24a`】旧: `manifestProbe`(`/api/apps/<app>/manifest`)。**
    // **`GET /manifest` が今日からログインを要求するので、起動確認は未認証で 200 が返る
    // `GET /api/apps/<app>/public` に移った**(`verify-image.ts` の `startupProbe` の doc)。
    startupProbe: {
      label: "アプリの入口(未ログインに渡る最小限)",
      method: "GET",
      path: `/api/apps/${APP}/public`,
      status: 200,
      body: `{"app":{"id":"${APP}","name":"見本"},"views":[]}`,
    },
    wrongProfileRun: {
      exitCode: 1,
      stderr: `[smailtalk runner] 起動を中止します: ${SERVER_PROFILE_ENV} が "runner" ではありません`,
    },
    appId: APP,
  };
}

/** 赤くなった検査の ID。 */
function redIds(facts: ImageFacts): string[] {
  return checkImage(facts)
    .filter((r) => r.violations.length > 0)
    .map((r) => r.id);
}

describe("V5-M7-T03 否定形の検査の判定", () => {
  // **【2026-08-26 訂正。`V10-M33-T03`。台帳 `CM-G43`。旧行を1バイトも消していない】**
  // **旧行の逐語**:
  //   `test("(前提) 壊していない事実では11項目すべて緑である", () => {`
  //   `  expect(redIds(greenFacts())).toEqual([]);`
  //   `  expect(checkImage(greenFacts())).toHaveLength(11);`
  // **`11` → `12` に動かしたのは、本タスクが (N9) を1本足したからである。**
  // **【隠さない】これは既存の凍結値を動かした唯一の箇所である。**
  // **弱めてはいない** —— **「検査の本数が減ったら赤くなる」という担保の強さは同じで、
  // 数え直した実数に合わせただけである。**
  test("(前提) 壊していない事実では12項目すべて緑である", () => {
    expect(redIds(greenFacts())).toEqual([]);
    expect(checkImage(greenFacts())).toHaveLength(12);
  });

  test("(N1) 編集系ルートが 401 を返す(middleware だけ残った形)と赤になる", () => {
    // **ステータスだけを見る検査だと、これは 404 ではないので気づく。**
    // **本当に危ないのは下の「404 だが本文が別」である。**
    const facts = greenFacts();
    const first = at(EDIT_ROUTE_PROBES, 0);
    const path = resolvePath(first, APP);
    const routeProbes = facts.routeProbes.map((p) =>
      p.path === path && p.method === first.method ? unauthorized(p.method, p.path) : p,
    );
    expect(redIds({ ...facts, routeProbes })).toContain("N1");
  });

  test("(N1) 【本丸】404 だが本文が違う応答は赤になる(ステータスだけ見ていたら通り抜ける)", () => {
    // **`V5-M3b` の変異検査が「ステータスだけ見ていたら通り抜けた」ことを実測している。**
    // ここはその実測に対する歯止めである。
    const facts = greenFacts();
    const first = at(EDIT_ROUTE_PROBES, 0);
    const path = resolvePath(first, APP);
    const routeProbes = facts.routeProbes.map((p) =>
      p.path === path && p.method === first.method
        ? {
            ...p,
            status: 404,
            body: '{"errors":[{"path":"","message":"レコードが見つかりません。"}]}',
          }
        : p,
    );
    expect(redIds({ ...facts, routeProbes })).toContain("N1");
    // **ステータスだけを見る判定なら緑になることを、同じ事実で示す。**
    const statusOnly = routeProbes.filter((p) => p.path === path).every((p) => p.status === 404);
    expect(statusOnly).toBe(true);
  });

  test("(N2) GET /api/apps が 200 を返すと赤になる", () => {
    const facts = greenFacts();
    const routeProbes = facts.routeProbes.map((p) =>
      p.path === "/api/apps" ? { ...p, status: 200, body: '{"apps":[]}' } : p,
    );
    expect(redIds({ ...facts, routeProbes })).toContain("N2");
  });

  test("(N3) 残すはずの12本が「その口は無い」の 404 を返すと赤になる", () => {
    const facts = greenFacts();
    const kept = at(KEPT_OWNER_ROUTE_PROBES, 0);
    const path = resolvePath(kept, APP);
    const routeProbes = facts.routeProbes.map((p) =>
      p.path === path && p.method === kept.method ? absent(p.method, p.path) : p,
    );
    expect(redIds({ ...facts, routeProbes })).toContain("N3");
  });

  test("(N4) アプリ一覧の目印がバンドルに入っていると赤になる", () => {
    const facts = greenFacts();
    const marker = at(FORBIDDEN_SCREEN_MARKERS, 0).marker;
    expect(
      redIds({ ...facts, contentHits: { [marker]: ["/app/web/dist/assets/index-abc.js"] } }),
    ).toContain("N4");
  });

  test("(N4) 画面のソース(AppListPage.tsx)がイメージに入っていると赤になる", () => {
    const facts = greenFacts();
    expect(redIds({ ...facts, paths: [...facts.paths, "/app/web/src/AppListPage.tsx"] })).toContain(
      "N4",
    );
  });

  test("(N5) MCP の stdio の入口が入っていると赤になる", () => {
    const facts = greenFacts();
    expect(redIds({ ...facts, paths: [...facts.paths, "/app/src/mcp/index.ts"] })).toContain("N5");
  });

  test("(N5) MCP の HTTP の入口(http-entry / http-transport)が入っていると赤になる", () => {
    for (const path of ["/app/src/mcp/http-entry.ts", "/app/somewhere/http-transport.ts"]) {
      const facts = greenFacts();
      expect(redIds({ ...facts, paths: [...facts.paths, path] })).toContain("N5");
    }
  });

  test("(N5) package.json が入っていると赤になる(mcp / mcp:http の script ごと)", () => {
    const facts = greenFacts();
    expect(redIds({ ...facts, paths: [...facts.paths, "/app/package.json"] })).toContain("N5");
  });

  test("(N5) MCP の SDK が node_modules に残っていると赤になる", () => {
    const facts = greenFacts();
    expect(
      redIds({
        ...facts,
        paths: [...facts.paths, "/app/node_modules/@modelcontextprotocol/sdk/package.json"],
      }),
    ).toContain("N5");
  });

  test("(N6) 移行器が入っていると赤になる(ADR-0252 限定4)", () => {
    const facts = greenFacts();
    expect(
      redIds({ ...facts, paths: [...facts.paths, "/app/scripts/migrate-volume.ts"] }),
    ).toContain("N6");
  });

  test("(N7) 他アプリの行が1件でもあると赤になる(3経路それぞれ)", () => {
    const base = greenFacts();
    expect(redIds({ ...base, imageAppDirs: [APP, "tokiwa"] })).toContain("N7");
    expect(redIds({ ...base, kernelAppIds: [APP, "tokiwa"] })).toContain("N7");
    expect(redIds({ ...base, kernelChangelogAppIds: [APP, "tokiwa"] })).toContain("N7");
  });

  test("(N7) 配るアプリの行が無いと赤になる(空の kernel.sqlite で緑にしない)", () => {
    const facts = greenFacts();
    expect(redIds({ ...facts, kernelAppIds: [] })).toContain("N7");
  });

  // **【2026-08-26。`V10-M33-T03`。台帳 `CM-G43`。独立点検の指摘】**
  // **陽性対照つきである** —— **「コメントの行が在る kernel.sqlite を渡すと赤くなる」
  // ところまで打つ。** 「0 なら緑」だけでは、判定が丸ごと抜けていても緑のままである。
  test("(N9) コメントの行が1件でも入っていると赤になる(D-V10-39。陽性対照)", () => {
    const facts = greenFacts();
    // **陰性(今日の正)**: 0 件なら (N9) は赤くならない。
    expect(redIds({ ...facts, kernelCommentRows: 0 })).not.toContain("N9");
    // **陽性対照**: 1 件でも赤になる。
    expect(redIds({ ...facts, kernelCommentRows: 1 })).toContain("N9");
    expect(redIds({ ...facts, kernelCommentRows: 42 })).toContain("N9");
    // **件数が本文に出る**(「入っている」だけでなく、いくつかを人に見せる)。
    const detail = checkImage({ ...facts, kernelCommentRows: 42 })
      .filter((r) => r.id === "N9")
      .flatMap((r) => r.violations)
      .map((v) => v.detail)
      .join("\n");
    expect(detail).toContain("42");
    expect(detail).toContain(COMMENT_TABLE);
  });

  // **【誇張しない】表そのものが無いことは (N9) の違反にしていない。**
  // **配った先で新しくコメントを書けることは `D-V10-38` が決めており、
  // 表が在るかどうかは本検査の主題ではない** —— **この行はその選択を固定するだけであり、
  // 「表が消えても気づく」担保ではない。**
  test("(N9) 表そのものが無いとき(null)は赤にしない(見ているのは行数だけである)", () => {
    const facts = greenFacts();
    expect(redIds({ ...facts, kernelCommentRows: null })).not.toContain("N9");
  });

  test("(N8) 過去の控えが1件でも入っていると赤になる(D-V5-97)", () => {
    const facts = greenFacts();
    expect(
      redIds({
        ...facts,
        paths: [
          ...facts.paths,
          `${IMAGE_DATA_ROOT}/apps/${APP}/${SNAPSHOTS_DIR_NAME}/0001-d-${APP}-001/app.sqlite`,
        ],
      }),
    ).toContain("N8");
  });

  test("(N8) 控えの中の manifest.json だけでも赤になる(app.sqlite だけを見ていない)", () => {
    const facts = greenFacts();
    expect(
      redIds({
        ...facts,
        paths: [
          ...facts.paths,
          `${IMAGE_DATA_ROOT}/apps/${APP}/${SNAPSHOTS_DIR_NAME}/0002-d-${APP}-002/manifest.json`,
        ],
      }),
    ).toContain("N8");
  });

  test("(N8) ボリューム側(/data)の控えでは赤にならない —— 見ているのはイメージの中である", () => {
    // **利用者のボリュームに控えが在ること自体は、この検査の対象ではない。**
    // **`D-V5-97` が決めたのは「配る器に入れない」ことである。**
    const facts = greenFacts();
    expect(
      redIds({
        ...facts,
        paths: [...facts.paths, `/data/apps/${APP}/${SNAPSHOTS_DIR_NAME}/0001-x/app.sqlite`],
      }),
    ).not.toContain("N8");
  });

  test("(P1) 【V5-M5 が名指しした穴】ST_SERVER_PROFILE=runner の焼き忘れは赤になる", () => {
    const facts = greenFacts();
    expect(redIds({ ...facts, imageEnv: ["PORT=3000"] })).toContain("P1");
    expect(redIds({ ...facts, imageEnv: [`${SERVER_PROFILE_ENV}=full`, "PORT=3000"] })).toContain(
      "P1",
    );
  });

  test("(P2) runner 以外を渡しても起動してしまうと赤になる", () => {
    const facts = greenFacts();
    expect(redIds({ ...facts, wrongProfileRun: { exitCode: 0, stderr: "" } })).toContain("P2");
    // **終了コードだけでなく、止めた理由が書かれていることも見る。**
    expect(redIds({ ...facts, wrongProfileRun: { exitCode: 1, stderr: "" } })).toContain("P2");
  });

  test("(Y1) 空のイメージでは肯定形が赤になる(否定形だけが全部緑になるのを防ぐ)", () => {
    const facts = greenFacts();
    const red = redIds({
      ...facts,
      paths: [],
      startupProbe: { ...facts.startupProbe, status: 404 },
    });
    expect(red).toContain("Y1");
  });
});

describe("V5-M7-T03 判定の部品", () => {
  test("isRouteAbsent はステータスと本文の両方を見る", () => {
    expect(isRouteAbsent(absent("GET", "/x"))).toBe(true);
    // 404 だが本文が違う
    expect(isRouteAbsent({ ...absent("GET", "/x"), body: "not found" })).toBe(false);
    // 本文は同じだがステータスが違う
    expect(isRouteAbsent({ ...absent("GET", "/x"), status: 200 })).toBe(false);
  });

  test("resolvePath は {app} を差し替える", () => {
    expect(resolvePath({ label: "", method: "GET", path: "/api/apps/{app}/manifest" }, "a1")).toBe(
      "/api/apps/a1/manifest",
    );
  });

  test("検査する口の本数(5 + 5 + 12)が D-V5-96 の数と一致する", () => {
    expect(EDIT_ROUTE_PROBES).toHaveLength(5);
    expect(OWNER_DROPPED_ROUTE_PROBES).toHaveLength(5);
    expect(KEPT_OWNER_ROUTE_PROBES).toHaveLength(12);
  });
});

describe("V5-M7-T03 変異2 で見つかった穴の歯止め", () => {
  test("(N3) コンテナに繋がらなかった(status=0)ときも赤になる", () => {
    // **変異2(`ENV ST_SERVER_PROFILE=runner` を消す)を実測したとき、コンテナが
    // 起動せず (N3) だけが緑のままになった。** 「叩けなかった」は「登録されている」の
    // 証拠ではない。**その穴を塞いだことをここで固定する。**
    const facts = greenFacts();
    const routeProbes = facts.routeProbes.map((p) =>
      p.status === 401 ? { ...p, status: 0, body: "(繋がらなかった)" } : p,
    );
    expect(redIds({ ...facts, routeProbes })).toContain("N3");
  });
});
