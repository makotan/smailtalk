/**
 * 既定の配信元(`webDistDir` を渡さないとき)が**どこから解かれるか**を測る(`V9-M2`)。
 *
 * **測るのは「明示で渡さないとき」である。** `app.test.ts:728` `:747` は
 * `webDistDir` を明示で渡す先例だが、それは既定を1バイトも通らない —— 引っ越し
 * (`V9-M1` が製品コードを `apps/smailtalk/` へ移した)で壊れたのは**既定のほう**である。
 *
 * **壊れ方**: 既定が `join(process.cwd(), "web", "dist")` だと、配信元は
 * **起動したときの現在地**で決まる。画面ファイルは `apps/smailtalk/web/dist` に移ったので、
 * 正本のルートから起動すると `<正本のルート>/web/dist` を見て**画面が1枚も出ない**。
 * 逃げて `apps/smailtalk` を現在地にすると、今度は `index.ts:114` の `dataRoot` の既定
 * `"data"` が `apps/smailtalk/data` を指し、`.mcp.json`(`<正本のルート>/data`)と
 * **保管場所が2つに割れる**。
 *
 * **したがってここで固定するのは「現在地に依らないこと」である** —— 既定は
 * **サーバ自身の場所**(`src/server/app.ts` から2つ上 = `apps/smailtalk/`)から解く。
 *
 * **ビルド済みかどうかに依存させない。** `web/dist` は git 管理外で、実 CI の `checks`
 * ジョブは `build:web` を打たない。**それでも `test.skip` / `skipIf` は使わない** ——
 * 代わりに、この検査自身が `web/dist` の中に目印のファイルを1つ置き、終わったら消す。
 * 「**`apps/smailtalk/web/dist` の中身が配信される**」を、ビルドの有無に依らず測れる。
 *
 * **`X-G29` による訂正**: もともとこのファイルは `cwd` の1つに、公開単位の根
 * (`apps/smailtalk/`)からさらに2段 `..` を重ねた式で作った値を明示で渡していた。
 * これは公開単位の外へ出る式そのものであり、`apps/smailtalk/` を単独で切り出すと
 * その式が指す先の概念自体が存在しない(2段上は公開単位の外の、無関係な
 * ディレクトリになる)。**測っている対象(サーバの既定解決が `cwd` に依らないこと)
 * は変わっていない** —— `cwd` に何を渡しても結果が変わらないことを示せればよいので、
 * `..` を重ねて作る代わりに、**この検査自身を呼び出した実際の現在地
 * (`process.cwd()`)** をそのまま使う。`bun test` をこのリポジトリの直下で打てば
 * (このリポジトリの通常の打ち方)従来どおり公開単位の外側を現在地にした場合を
 * 実際に覆う。切り出した木で単独インストールして打てば、そのときの `process.cwd()`
 * (=公開単位自身の根)を覆う —— **どちらの場合も、コード自身は1段も `..` で
 * 遡らずに済む。**
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 * このファイルは `apps/smailtalk/src/server/` に在るので、2つ上が `apps/smailtalk/` である
 * (`src/server` → `src` → `apps/smailtalk`)。測る相手の `app.ts` も同じ階層に在るので、
 * 段数は同じ2である。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");
const APP_MODULE = join(import.meta.dir, "app.ts");
const DIST_DIR = join(PRODUCT_ROOT, "web", "dist");

/** 目印。ビルド成果物と名前が衝突しないものにする。 */
const PROBE_NAME = "st-web-dist-default-probe.txt";
const PROBE_BODY = "st-web-dist-default-probe-body";
const MARKER = "__ST_PROBE__";

let dataRoot: string;
/** `web/dist` をこの検査が作ったのか(作ったときだけ後片付けで消す)。 */
let createdDistDir = false;

const SCRIPT = `
const { createServerApp } = await import(process.env.ST_PROBE_MODULE);
const app = createServerApp({ dataRoot: process.env.ST_PROBE_DATA_ROOT });
const res = await app.request("/" + process.env.ST_PROBE_NAME);
console.log(
  "${MARKER}" +
    JSON.stringify({ cwd: process.cwd(), status: res.status, body: await res.text() }),
);
`;

/** 現在地を `cwd` にして、`webDistDir` を渡さずに作ったサーバへ目印を取りに行く。 */
async function probeFrom(cwd: string): Promise<{ cwd: string; status: number; body: string }> {
  const child = Bun.spawn(["bun", "-e", SCRIPT], {
    cwd,
    env: {
      ...process.env,
      ST_PROBE_MODULE: APP_MODULE,
      ST_PROBE_DATA_ROOT: dataRoot,
      ST_PROBE_NAME: PROBE_NAME,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split("\n").find((each) => each.startsWith(MARKER));
  if (line === undefined) {
    throw new Error(
      `子プロセスが目印を出しませんでした(exit=${code} cwd=${cwd})。\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return JSON.parse(line.slice(MARKER.length));
}

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "st-web-dist-default-"));
  if (!existsSync(DIST_DIR)) {
    await mkdir(DIST_DIR, { recursive: true });
    createdDistDir = true;
  }
  await writeFile(join(DIST_DIR, PROBE_NAME), PROBE_BODY, "utf-8");
});

afterAll(async () => {
  await rm(join(DIST_DIR, PROBE_NAME), { force: true });
  if (createdDistDir) {
    await rm(DIST_DIR, { recursive: true, force: true });
  }
  await rm(dataRoot, { recursive: true, force: true });
});

test("この検査を呼び出した現在地(process.cwd())でも、既定の配信元は apps/smailtalk/web/dist の中身を返す", async () => {
  const callerCwd = process.cwd();
  const result = await probeFrom(callerCwd);
  expect(result.cwd).toBe(callerCwd);
  expect(result.status).toBe(200);
  expect(result.body).toBe(PROBE_BODY);
}, 120_000);

test("現在地が apps/smailtalk でも、無関係な一時ディレクトリでも、同じ中身が返る(現在地に依らない)", async () => {
  const [fromProduct, fromElsewhere] = await Promise.all([
    probeFrom(PRODUCT_ROOT),
    probeFrom(tmpdir()),
  ]);
  expect(fromProduct.status).toBe(200);
  expect(fromProduct.body).toBe(PROBE_BODY);
  expect(fromElsewhere.status).toBe(200);
  expect(fromElsewhere.body).toBe(PROBE_BODY);
}, 120_000);
