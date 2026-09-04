/**
 * 参照ショップ(参照 EC)の起動スクリプト(V4-M1-T00 / `D-V4-28`)。
 *
 * ## なぜ要るのか
 *
 * `scripts/ref-ec/manifest.ts` は **`Manifest` を返す関数**であって、ディスク上のアプリでは
 * なかった —— 検査(`manifest.test.ts` / `functions.test.ts` / `journey-e2e.test.ts`)が
 * `mkdtemp` の一時 dataRoot に流し込んで使うだけで、**立ち上げる口が1つも無かった**
 * (04 §2-4 の実測)。`D-V4-28`(ユーザ決定)は「起動できるように作る」= **コマンド1発で
 * 立ち上がる形にする**と定めた。効く先は `V4-M13`(着手前後の全画面計測)だけではなく、
 * `CP-V4`(画面側の変更の実証)と `CP-V4-EC` にも及ぶ(04 §1 `D-V4-28` / §3-0)。
 *
 * ## 使い方(コマンド1発)
 *
 * ```
 * mise exec -- bun run serve:ref-ec        # web フロントをビルドしてから起動する
 * mise exec -- bun run scripts/ref-ec/serve.ts   # ビルド済み前提で起動だけする
 * ```
 *
 * 起動すると **`http://localhost:3211`** で参照ショップが開く。標準出力に
 * 「どの URL で何が見えるか」と「用意したアカウントの平方パスワード」を出す。
 *
 * | env | 既定 | 意味 |
 * |---|---|---|
 * | `ST_REF_EC_DATA_ROOT` | `data-ref-ec` | 書き込み先。**`.gitignore` の `data-*` パターン に掛かる** |
 * | `ST_REF_EC_PORT` | `3211` | 待ち受けポート(`src/server/index.ts` の 3000 / e2e の 3210 と衝突させない) |
 * | `ST_REF_EC_FRESH` | 未設定 | `1`/`true` で dataRoot を消してから組み直す |
 *
 * ## 設計上の決め(計画側の判断。ユーザ決定でも審査の判定でもない)
 *
 * - **置き場は案A**(04 §3-14c)—— `scripts/ref-ec/serve.ts`。宣言(`manifest.ts`)と同じ場所に
 *   置き、`CP-V4` / `CP-V4-EC` / `V4-M13` の3者が同じパスで呼べる。`scripts/` は tsconfig の
 *   `include` に入っているので typecheck と biome の対象になる。
 * - **dataRoot は固定パス**(04 §3-14c #2 の2択のうち固定側)—— 着手前と着手後で同じデータを
 *   見ないと画面の計測が突き合わせられないため。一時ディレクトリは採らない。
 * - **既存があれば再利用する**(作り直さない)。作り直したいときだけ `ST_REF_EC_FRESH=1`。
 *   これは「2回目以降も壊れずに立ち上がる」を、データを捨てずに満たす側の選択である。
 * - **サーバ本体は製品の `src/server/index.ts` をそのまま起動する**(写しを作らない)。
 *   このスクリプトは dataRoot を用意して env を確定させ、あとは製品の起動経路に渡すだけである。
 *   したがってスケジューラ・アウトボックス配送・島ランタイムの事前ロードは製品と同じ挙動になる。
 *
 * ## このスクリプトが**やっていない**こと(誇張しない)
 *
 * - **モック PSP は立てない。** 参照 EC の `wf-order-checkout` は `call_external` で
 *   `http://127.0.0.1/mock-psp/charges` に決済要求を積むが、その宛先は起動していない。
 *   接続(connection)だけは owner 発行の形で用意してあるので**アウトボックスには積まれる**が、
 *   **配送は失敗し続ける**(買い物の「決済まで通る」経路は `journey-e2e.test.ts` の担当である)。
 * - **画像を1枚も入れていない。** `catalog-list` の `image` 列と `product-detail` の画像は空で描かれる。
 * - **`cart_totals` は空のまま。** 参照 EC の `fn-cart-totals` は schedule(`wf-totals-sweep` 03:00)に
 *   しか配線されていない(カート明細の作成では走らない)。走らせたいなら翌日の 03:00 を待つ。
 * - **逃げ道(任意 CSS)の見本はもう置かない。** V4-M30 / `D-V4-113` で1件発行していたが、
 *   V4-M33 / `D-V4-116`(「検査の中だけに残し、店からは取り消す」)で参照ショップからは
 *   発行と参照の両方を外した。**同じバイト列の chromium 検査は `web/e2e/escape-hatch.e2e.ts`
 *   に1本も消さず残っている**(記録: `docs/plan/v4/records/v4-m33.md`)。
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadAuthConfig } from "../../src/auth/config.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { AuthStore } from "../../src/auth/store.ts";
import type { Role } from "../../src/auth/types.ts";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { CapabilityStore } from "../../src/kernel/capability-store.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { ensureIslandRuntimeReady } from "../../src/kernel/island-runner.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import { listRecords } from "../../src/kernel/records.ts";
import { appDbPath } from "../../src/kernel/storage-paths.ts";
import type { Manifest } from "../../src/kernel/types.ts";
import { createServerApp } from "../../src/server/app.ts";
import { PUBLIC_FIELD } from "../../src/server/owner-scope.ts";
import { routePath } from "../../src/shared/route.ts";
import { REF_EC_APP_ID, referenceEcManifest } from "./manifest.ts";

// --- 既定値 -----------------------------------------------------------------

/** 既定の書き込み先。**`.gitignore` の `data-*` パターン に掛かる名前でなければならない**(生成物を git に入れない)。 */
export const REF_EC_DEFAULT_DATA_ROOT = "data-ref-ec";

/** 既定のポート。製品サーバ(3000)と e2e フィクスチャサーバ(3210)を避ける。 */
export const REF_EC_DEFAULT_PORT = 3211;

/**
 * 用意するアカウント。**平文をここに書いてあるのは意図的である。**
 *
 * この製品は「**最初の1人だけが owner**」であり、AI が先にアカウントを作ると持ち主が
 * 管理者になれない。したがって「誰が owner か」と「その資格情報」を起動のたびに
 * 標準出力へ平文で出す(`D-V4-4` の作法)。**これはローカルの検証用の店であり、
 * この資格情報を本番の実データに使ってはならない。**
 */
export const REF_EC_OWNER = {
  username: "refec-owner",
  password: "refec-owner-password",
} as const;

/**
 * 運営ではない側のアカウント(`customer` ロール。`st_owner` スコープの実演に要る)。
 *
 * **【`V5-M18` / `G-G21`】着手前の逐語は「買い物客側のアカウント」だった。**
 * **`customer` はプラットフォームのロール名であって、この店の言葉ではない** ——
 * `V5-M13` / `G-G4` は画面の表示名を「顧客」から「一般利用者」に変えており、
 * **ここだけ業種の言葉で説明していると、プラットフォームが EC を前提にしているように読める。**
 * **ロールの値(`customer`)は1文字も変えていない**(変えるのは説明文だけである)。
 */
export const REF_EC_CUSTOMER = {
  username: "refec-customer",
  password: "refec-customer-password",
} as const;

/**
 * **プラットフォームの決まりについての説明文**(`V5-M18` / `G-G21`)。
 *
 * **ここに業種の言葉を1語も書かない。** 起動時の出力には「この店のどの表が何行あるか」の
 * ような**アプリの話**と、「所有者の列を宣言した表は本人にしか見えない」のような
 * **プラットフォームの話**が混ざっていた。**後者を業種の言葉で書くと、プラットフォームが
 * EC 専用であるかのように読める** —— それが `G-G21` が直そうとしているものである。
 *
 * **`scripts/ref-ec/platform-wording.test.ts` が、この7本に対して
 * `findIndustryWords`(`scripts/industry-words.ts` の `FACE1` + `FACE5` の全語)を当てて
 * 0件であることを機械的に固定する。**
 *
 * **【この検査が測っていないもの。誇張しない】** **測るのは「あらかじめ決めた語が現れない」
 * ことだけである。** **字面を避けて書かれた業種前提は1件も拾えない**
 * (`scripts/industry-words.ts` の冒頭が持つ限界をそのまま引き継ぐ)。
 * **「参照 EC からプラットフォームの EC 前提が消えた」とは書けない。**
 */
export const PLATFORM_NOTES = {
  firstUserIsOwner:
    "この製品は「最初に登録した1人だけが管理者(owner)」です。下の owner がその第1号で、以後このアプリの管理者はこのアカウントだけです。",
  ownerScope:
    "所有者の列(st_owner)を宣言した表は、その行を作った本人にしか見えません。管理者(owner)で入っても0件に見えます。中身を見るには、その行を作った利用者でログインしてください。",
  // **【`V8-M20` / 台帳 `J-G30` / ユーザ決定 `D-V8-35` / `ADR-0301`】本文を書き直した。**
  // **旧の逐語**: 「運営可視の列(st_admin_readable)を宣言した表だけは、管理者(owner)も
  // 他人の行を読めます。読めるだけで、書き換えはできません。宣言の無い表は今日も1行も
  // 見えません。」
  // **書き直した理由**: **その列は今日存在しない**(廃止された)。**起動時にこの文を読む人に、
  // 実在しない書き方を案内し続けることになる。** **キー名(`adminReadable`)は変えていない** ——
  // **`scripts/ref-ec/platform-wording.test.ts` が7本の名前を順序ごと固定しており、
  // 名前を変えるのは本タスクの射程の外だからである。**
  adminReadable:
    "役割にその表の読取を許す規則を書くと、その役割の人は他人の行も読めます。読めるだけで、書き換えと削除は今日どおり自分の行だけです。規則を1本も書いていない表は1行も見えません。読取を許す相手は管理者に限りません —— 書き方を間違えると、自分の分だけ見えるはずだった人に全員分が見えます。",
  scheduleOnly:
    "決まった時刻に走ると宣言した処理は、その時刻まで1度も走りません。画面を開いても走りません。",
  outboundDestination:
    "外部への送信の宛先は、この起動スクリプトが1つも立てていません。送信は控えに積まれますが、配送は失敗し続けます。",
  manualTrigger:
    "一覧の行のボタンから起こせるのは、発火条件に manual と書いた処理だけです。押した回数だけ走ります(処理中に重ねて押したときだけ断られます)。",
  roleRulesAreNotJustDisplay:
    "役割の規則(roles の rules)は、画面にボタンを出すか出さないかを決めるだけではありません。規則を書いた表・項目・画面・ボタンには壁が立ち、ブラウザからログインして使う人が、規則に載っていない役割でその要求を送るとサーバに断られます(403)。どのボタンから来たかを名乗っても名乗らなくても同じです。止まらないものがあります —— 外から届く通知、アプリを育てる側の口、自動処理が書くとき、コードの島が書くとき。そして表に読取の規則を書くと、その役割の人には持ち主の違う行も全部見えます(2026-08-10 のユーザ決定。書き方を間違えると、本来自分の分だけ見えるはずだった人に全員分が見えます)。",
} as const;

/** 参照 EC が宣言している外部接続の名前(`wf-order-checkout` / `wf-payment-received` が参照する)。 */
const CONNECTION_NAMES = ["mock-psp", "mail-gateway"] as const;

/** 接続の secret の取得元(非保管。値そのものは持たない)。宛先が動いていないので使われない。 */
const CONNECTION_SECRET_ENV = "ST_REF_EC_OUTBOUND_SECRET";

// --- 設定 -------------------------------------------------------------------

export type ServeConfig = {
  /** 書き込み先(`ST_DATA_ROOT` に渡す)。 */
  dataRoot: string;
  /** 待ち受けポート。 */
  port: number;
  /** 期待 origin。**必ず `localhost`** —— `127.0.0.1` 表記だと Origin 検査で POST が全部 403 になる。 */
  origin: string;
  /** 真なら dataRoot を消してから組み直す。 */
  fresh: boolean;
};

/** `"1"` / `"true"`(大小無視)だけを真とみなす。未設定は偽。 */
function parseFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/** env から起動設定を組み立てる(既定値の適用だけ。副作用なし)。 */
export function resolveServeConfig(env: Record<string, string | undefined>): ServeConfig {
  const dataRoot = env.ST_REF_EC_DATA_ROOT ?? REF_EC_DEFAULT_DATA_ROOT;
  const rawPort = env.ST_REF_EC_PORT;
  const parsed = rawPort === undefined || rawPort.trim() === "" ? Number.NaN : Number(rawPort);
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : REF_EC_DEFAULT_PORT;
  return {
    dataRoot,
    port,
    // **`127.0.0.1` にしない。** 04 §2-9 の【必須】: Origin 検査(`src/server/app.ts`)は
    // expectedOrigin と厳密一致で、`127.0.0.1` で開くと POST が全部 403 になる。
    origin: `http://localhost:${port}`,
    fresh: parseFlag(env.ST_REF_EC_FRESH),
  };
}

// --- 用意の結果 ---------------------------------------------------------------

export type ProvisionedAccount = {
  username: string;
  /** 平文。標準出力にそのまま出す(`D-V4-4`)。 */
  password: string;
  role: Role;
  userId: string;
  /** 今回このスクリプトが作ったか(false = 既存を再利用し、パスワードだけ貼り直した)。 */
  created: boolean;
  /** `st_session=<id>`。スクリプトからの検査(curl / probe)にそのまま使える。 */
  sessionCookie: string;
};

export type ProvisionResult = {
  dataRoot: string;
  appId: string;
  /** 今回アプリ実体を作ったか(false = 既存を再利用した)。 */
  appCreated: boolean;
  /** 今回種データを入れたか(false = 既に行があったので1行も足していない)。 */
  seeded: boolean;
  /** ディスクに適用された後のマニフェスト。 */
  manifest: Manifest;
  accounts: { owner: ProvisionedAccount; customer: ProvisionedAccount };
  /** 用意し終わった時点の実測行数(テーブルid → 行数)。 */
  rowCounts: Record<string, number>;
  /** detail_view の URL を組むための代表 `_id`(テーブルid → `_id`)。 */
  sampleRecordIds: Record<string, string>;
};

export type ProvisionOptions = {
  dataRoot: string;
  origin: string;
  fresh?: boolean;
};

// --- HTTP の薄いラッパ(製品の経路をそのまま叩く)--------------------------------

type ServerApp = ReturnType<typeof createServerApp>;

/** レコード API のパス。 */
const recordsPath = (table: string): string => `/api/apps/${REF_EC_APP_ID}/tables/${table}/records`;

/** `origin` 付きの POST。**製品の HTTP 経路をそのまま通す**(裏口から書かない)。 */
async function post(
  app: ServerApp,
  origin: string,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin,
  };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return app.request(
    new Request(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

/** レコードを1件作り、その `_id` を返す。失敗は黙らせず投げる(憲法6)。 */
async function createRecordViaHttp(
  app: ServerApp,
  origin: string,
  cookie: string,
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const response = await post(app, origin, recordsPath(table), values, cookie);
  if (response.status !== 201) {
    throw new Error(`${table} の作成に失敗しました(${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as { record: { _id: string } };
  return body.record._id;
}

/** ログインして `st_session=<id>` を返す。 */
async function login(
  app: ServerApp,
  origin: string,
  username: string,
  password: string,
): Promise<string> {
  const response = await post(app, origin, `/api/apps/${REF_EC_APP_ID}/auth/password/login`, {
    username,
    password,
  });
  if (response.status !== 200) {
    throw new Error(
      `${username} のログインに失敗しました(${response.status}): ${await response.text()}`,
    );
  }
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const [name, value] = (pair ?? "").split("=");
    if (name === "st_session" && value !== undefined) {
      return `st_session=${value}`;
    }
  }
  throw new Error(`${username} のログインで st_session cookie が発行されませんでした。`);
}

// --- アカウント ---------------------------------------------------------------

/**
 * アカウントを1つ用意する。
 *
 * - **居なければ製品のサインアップ経路(HTTP)で作る。** 誰が owner になるかは製品の規則
 *   (`countUsers()===0 ? "owner" : "viewer"`)が決めるのであって、このスクリプトが決めない。
 *   したがって **owner を必ず第1号として登録する**(呼ぶ順序がそのまま役割になる)。
 * - **居れば作らず、パスワードだけ貼り直す。** ハッシュからは平文を復元できないので、
 *   「標準出力に出した平文で必ずログインできる」を再実行後も成り立たせるには貼り直すしかない。
 */
async function ensureAccount(
  app: ServerApp,
  origin: string,
  dataRoot: string,
  credentials: { username: string; password: string },
  registerPath: string,
): Promise<ProvisionedAccount> {
  const store = AuthStore.openForApp(dataRoot, REF_EC_APP_ID);
  let existingId: string | undefined;
  try {
    existingId = store.findUserByUsername(credentials.username)?.id;
    if (existingId !== undefined) {
      // 既存 —— 平文は復元できないので貼り直す(出力した資格情報を必ず通す)。
      store.setPassword(existingId, await hashPassword(credentials.password));
    }
  } finally {
    store.close();
  }

  if (existingId === undefined) {
    const response = await post(app, origin, registerPath, credentials);
    if (response.status !== 200) {
      throw new Error(
        `${credentials.username} の登録に失敗しました(${response.status}): ${await response.text()}`,
      );
    }
  }

  const cookie = await login(app, origin, credentials.username, credentials.password);

  const after = AuthStore.openForApp(dataRoot, REF_EC_APP_ID);
  try {
    const user = after.findUserByUsername(credentials.username);
    if (user === undefined) {
      throw new Error(`${credentials.username} が登録直後に見つかりませんでした。`);
    }
    return {
      username: credentials.username,
      password: credentials.password,
      role: user.role,
      userId: user.id,
      created: existingId === undefined,
      sessionCookie: cookie,
    };
  } finally {
    after.close();
  }
}

// --- 種データ -----------------------------------------------------------------

/**
 * 種データの価格設定。**集計島(`fn-order-totals` / `fn-cart-totals`)が読むマスタ3表に
 * そのまま入れる値**であり、注文行に焼き付ける金額もこの3つから決めている。
 *
 * **ずらしてはならない** —— ずらすと、アプリが注文行に書いた `total` と、集計ワークフローが
 * `order_totals` に書いた `total` が食い違う(実測で踏んだ)。参照 EC には「行内の計算列」が
 * 無く、金額はアプリが焼き付けたスナップショットと島の集計の2箇所に別々に在るためである。
 */
const SHIPPING_BASE_FEE = 500;
const SHIPPING_FREE_OVER = 5000;
const TAX_RATE = 0.1;
/**
 * 店舗共通の割引額。**注文別クーポンは今日の語彙では成立しない**(`functions.ts` の
 * 「動かなかったもの」3)—— 有効なクーポンがちょうど1行のとき、島はそれを全注文に当てる。
 */
const STORE_WIDE_DISCOUNT = 500;

/**
 * 種データを入れる(**製品の HTTP 経路だけを使う**)。
 *
 * 単票(`detail_view` 4本)は行が1件も無いと踏めないので、10ビュー全部が「空でない画面」に
 * なるところまで入れる。**注文を2本作る順序に意味がある** —— 参照 EC の `fn-order-totals` は
 * `order` の `on_create` にしか配線されていないので、注文#2 を作った時点で初めて注文#1 の
 * 明細が `order_totals` に集計される。**注文#2 のぶんは集計されない**(限界として記録する)。
 */
async function seed(
  app: ServerApp,
  origin: string,
  ownerCookie: string,
  customerCookie: string,
): Promise<Record<string, string>> {
  const sample: Record<string, string> = {};
  const create = (cookie: string, table: string, values: Record<string, unknown>) =>
    createRecordViaHttp(app, origin, cookie, table, values);

  // --- 運営が作るもの(カテゴリ / 商品 / 配送方法 / 税率 / クーポン)-----------------
  const categories: string[] = [];
  for (const [index, name] of ["調味料", "乾物", "ギフト"].entries()) {
    categories.push(
      await create(ownerCookie, "category", {
        name,
        slug: `cat-${index + 1}`,
        sort_order: index + 1,
        [PUBLIC_FIELD]: true,
      }),
    );
  }
  sample.category = categories[0] as string;

  const products: string[] = [];
  const catalog = [
    { name: "藻塩 150g", price: 1200, stock: 40, description: "海藻を焼き込んだ塩。" },
    { name: "昆布だし 500ml", price: 980, stock: 25, description: "北海道産真昆布のだし。" },
    { name: "醤油 1L", price: 1500, stock: 18, description: "木桶仕込みの濃口醤油。" },
    { name: "干し椎茸 80g", price: 860, stock: 60, description: "肉厚の原木栽培。" },
    { name: "詰め合わせ ギフト箱", price: 4800, stock: 12, description: "3点入りの化粧箱。" },
  ];
  for (const [index, item] of catalog.entries()) {
    products.push(
      await create(ownerCookie, "product", {
        name: item.name,
        description: item.description,
        sku: `SKU-${String(index + 1).padStart(4, "0")}`,
        price: item.price,
        category: categories[index % categories.length],
        stock: item.stock,
        status: "active",
        [PUBLIC_FIELD]: true,
      }),
    );
  }
  sample.product = products[0] as string;

  // 価格設定のマスタ3表。**集計島(`fn-order-totals`)はこの3表の全行を入力に取る**ので、
  // ここに入れた値がそのまま `order_totals` の計算に効く(`functions.ts` の配列形入力)。
  await create(ownerCookie, "shipping_method", {
    name: "宅配便",
    base_fee: SHIPPING_BASE_FEE,
    free_over: SHIPPING_FREE_OVER,
  });
  await create(ownerCookie, "tax_rate", { name: "標準税率", rate: TAX_RATE });
  // **有効なクーポンがちょうど1行のとき、島はそれを店舗共通で全注文に当てる**
  // (注文別クーポンは今日の語彙では解けない。`functions.ts` の「動かなかったもの」3)。
  await create(ownerCookie, "coupon", {
    code: "WELCOME500",
    discount_type: "fixed",
    discount_value: STORE_WIDE_DISCOUNT,
    is_active: true,
  });

  // --- 買い物客が作るもの(顧客 / 住所 / カート / 明細 / 注文)---------------------
  // **`st_owner` が効くので、これらは customer のセッションで作る。**
  const customerId = await create(customerCookie, "customer", {
    name: "見本 太郎",
    email: "taro@example.test",
    display_name: "たろう",
    joined_at: "2026-08-01",
  });
  sample.customer = customerId;

  await create(customerCookie, "address", {
    customer: customerId,
    postal_code: "150-0001",
    prefecture: "東京都",
    city: "渋谷区",
    line: "神宮前1-2-3",
    is_default: true,
  });

  // カート(`wf-cart-line-total` が明細の `line_total` を島で書く)。
  const cartId = await create(customerCookie, "cart", {
    customer: customerId,
    status: "open",
    created_at: "2026-08-02",
  });
  sample.cart = cartId;
  await create(customerCookie, "cart_line", {
    cart: cartId,
    product: products[0] as string,
    quantity: 2,
    unit_price: catalog[0]?.price,
  });
  await create(customerCookie, "cart_line", {
    cart: cartId,
    product: products[1] as string,
    quantity: 1,
    unit_price: catalog[1]?.price,
  });

  // 注文(2本)。**#2 の作成が #1 の明細を order_totals へ集計する。**
  const orderIds: string[] = [];
  const orders = [
    { number: "ORD-1001", lines: [0, 1], quantities: [2, 1] },
    { number: "ORD-1002", lines: [2, 4], quantities: [1, 1] },
  ];
  for (const spec of orders) {
    const subtotal = spec.lines.reduce(
      (sum, productIndex, i) =>
        sum + (catalog[productIndex]?.price ?? 0) * (spec.quantities[i] ?? 0),
      0,
    );
    const shippingFee = subtotal >= SHIPPING_FREE_OVER ? 0 : SHIPPING_BASE_FEE;
    const tax = Math.floor(subtotal * TAX_RATE);
    const orderId = await create(customerCookie, "order", {
      order_number: spec.number,
      customer: customerId,
      status: "pending_payment",
      subtotal,
      discount: STORE_WIDE_DISCOUNT,
      shipping_fee: shippingFee,
      tax,
      total: subtotal - STORE_WIDE_DISCOUNT + shippingFee + tax,
      payment_status: "unpaid",
      currency: "JPY",
      placed_at: "2026-08-02",
      // **【`V8-M20` / `J-G30`】`st_admin_readable` は撤去した。**
      // **運営(owner)が購入者の注文を読めるのは、今日は `app.roles` の規則による。**
    });
    orderIds.push(orderId);
    for (const [i, productIndex] of spec.lines.entries()) {
      const unitPrice = catalog[productIndex]?.price ?? 0;
      const quantity = spec.quantities[i] ?? 0;
      await create(customerCookie, "order_line", {
        order: orderId,
        product: products[productIndex] as string,
        quantity,
        unit_price: unitPrice,
        line_total: unitPrice * quantity,
      });
    }
  }
  sample.order = orderIds[0] as string;

  return sample;
}

// --- 行数と代表 _id の実測 -------------------------------------------------------

/** ビューが当たるテーブルと、種データの有無を判定するテーブル。 */
const COUNTED_TABLES = [
  "category",
  "product",
  "customer",
  "address",
  "cart",
  "cart_line",
  "order",
  "order_line",
  "order_totals",
  "cart_totals",
  "order_events",
  "coupon",
  "shipping_method",
  "tax_rate",
  "payment_events",
  "wf_runs",
] as const;

/**
 * 行数を数える。
 *
 * **HTTP の一覧経路は使わない** —— `st_owner` の post-filter が掛かって「誰から見た行数か」に
 * 化けるためである。**素の行数**が要るので、アプリ DB を読み取り専用で開いて数える。
 */
function measureRows(dataRoot: string, manifest: Manifest): Record<string, number> {
  const db = new Database(appDbPath(dataRoot, REF_EC_APP_ID), { readonly: true });
  try {
    const counts: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      const result = listRecords(db, manifest, table);
      counts[table] = result.ok ? result.value.length : 0;
    }
    return counts;
  } finally {
    db.close();
  }
}

// V4-M30 / `D-V4-113` はここに `issueEscapeHatchSample()`(逃げ道 CSS の見本を owner の
// HTTP 経路で1件だけ発行する冪等関数)を置いていたが、V4-M33 / `D-V4-116`(「検査の中だけに
// 残し、店からは取り消す」)で関数ごと削除した。参照ショップはもう逃げ道資産を1件も発行しない
// (`docs/plan/v4/records/v4-m33.md` §1)。

// --- 用意の本体 ---------------------------------------------------------------

/**
 * 参照ショップを dataRoot 上に用意する(**冪等**)。
 *
 * 1. `fresh` なら dataRoot を消す。
 * 2. 台帳にアプリが無ければ作る(あれば再利用する)。
 * 3. 参照 EC のマニフェストを適用する(同じものの再適用は差分ゼロ)。
 * 4. 参照 EC が宣言している接続(`mock-psp` / `mail-gateway`)を owner 発行の形で用意する。
 * 5. アカウントを2つ用意する(**owner を第1号として登録する**)。
 * 6. 商品が1件も無いときだけ種データを入れる。
 *
 * (V4-M30 が足していた「5b. 逃げ道 CSS の見本を owner の HTTP 経路で発行する」は、
 * V4-M33 / `D-V4-116` で取り消した。参照ショップはもう見本を発行しない。)
 */
export async function provisionReferenceShop(options: ProvisionOptions): Promise<ProvisionResult> {
  const { dataRoot, origin } = options;

  if (options.fresh === true && existsSync(dataRoot)) {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  // 島(QuickJS-WASM)を先にロードする。未ロードだと `wf-cart-line-total` の `run_function` が
  // 同期経路で fail-closed し、カート明細の `line_total` が空のまま静かに残る。
  await ensureIslandRuntimeReady();

  const store = KernelMetaStore.open(dataRoot);
  let appCreated = false;
  try {
    if (store.getApp(REF_EC_APP_ID) === undefined) {
      createApp(store, "参照EC", { app_id: REF_EC_APP_ID });
      appCreated = true;
    }
  } finally {
    store.close();
  }

  const applied = applyManifest(dataRoot, REF_EC_APP_ID, referenceEcManifest());
  if (!applied.valid) {
    throw new Error(`参照 EC マニフェストの適用に失敗しました: ${JSON.stringify(applied.errors)}`);
  }
  const manifest = applied.manifest;

  // 参照 EC が宣言している外部接続。**人間 owner が発行するもの**であって AI は申請しかできない
  // ので、この仕込みスクリプトが owner の代わりに発行する(名前が既にあれば作らない)。
  const capabilities = CapabilityStore.openForKernel(dataRoot);
  try {
    for (const name of CONNECTION_NAMES) {
      if (capabilities.findConnectionByName(REF_EC_APP_ID, name) === undefined) {
        capabilities.createConnection({
          appId: REF_EC_APP_ID,
          name,
          allowedHosts: ["127.0.0.1"],
          secretSource: { kind: "env", value: CONNECTION_SECRET_ENV },
        });
      }
    }
  } finally {
    capabilities.close();
  }

  const app = createServerApp({
    dataRoot,
    authConfig: loadAuthConfig({ ST_AUTH_EXPECTED_ORIGIN: origin }),
  });

  // **順序が役割を決める。** owner を先に登録しないと第1号にならない
  // (`src/server/auth-routes.ts` の `countUsers()===0 ? "owner" : "viewer"`)。
  const owner = await ensureAccount(
    app,
    origin,
    dataRoot,
    REF_EC_OWNER,
    `/api/apps/${REF_EC_APP_ID}/auth/password/register`,
  );
  if (owner.role !== "owner") {
    throw new Error(
      `${owner.username} が owner になりませんでした(実際は ${owner.role})。` +
        "この dataRoot には既に別のユーザが居ます。ST_REF_EC_FRESH=1 で作り直してください。",
    );
  }
  // V4-M30 / `D-V4-113` はここで逃げ道(任意 CSS)の見本を owner の HTTP 経路で発行していたが、
  // V4-M33 / `D-V4-116`(「検査の中だけに残し、店からは取り消す」)で削除した。参照ショップの
  // 逃げ道資産は再び0件のままである。

  const customer = await ensureAccount(
    app,
    origin,
    dataRoot,
    REF_EC_CUSTOMER,
    `/api/apps/${REF_EC_APP_ID}/auth/signup/password/register`,
  );

  // 種データは**商品が1件も無いときだけ**入れる(2回目以降は1行も足さない)。
  const before = measureRows(dataRoot, manifest);
  let sampleRecordIds: Record<string, string>;
  let seeded = false;
  if ((before.product ?? 0) === 0) {
    sampleRecordIds = await seed(app, origin, owner.sessionCookie, customer.sessionCookie);
    seeded = true;
  } else {
    sampleRecordIds = firstRecordIds(dataRoot, manifest);
  }

  return {
    dataRoot,
    appId: REF_EC_APP_ID,
    appCreated,
    seeded,
    manifest,
    accounts: { owner, customer },
    rowCounts: measureRows(dataRoot, manifest),
    sampleRecordIds,
  };
}

/**
 * 既存データから代表 `_id` を拾う(再実行時。**種データを入れ直さずに URL を組むため**)。
 * 並びは挿入順ではなく `listRecords` の既定順であり、「どれか1件」であることだけを保証する。
 */
function firstRecordIds(dataRoot: string, manifest: Manifest): Record<string, string> {
  const db = new Database(appDbPath(dataRoot, REF_EC_APP_ID), { readonly: true });
  try {
    const ids: Record<string, string> = {};
    for (const table of ["category", "product", "customer", "cart", "order"]) {
      const result = listRecords(db, manifest, table);
      const first = result.ok ? result.value[0] : undefined;
      if (first !== undefined) {
        ids[table] = first._id;
      }
    }
    return ids;
  } finally {
    db.close();
  }
}

// --- 出力 ---------------------------------------------------------------------

export type ReferenceShopUrl = {
  /** 画面の見出し(ビュー名 + 種別)。 */
  label: string;
  url: string;
  /** ビューID(アプリのトップだけ undefined)。 */
  viewId?: string;
};

/** ビュー種別の日本語表記。 */
const VIEW_TYPE_LABEL: Record<string, string> = {
  list_view: "一覧",
  detail_view: "単票",
  form: "入力フォーム",
};

/**
 * 踏める URL を全部組み立てる。
 *
 * **必ず `localhost`** —— `127.0.0.1` 表記だと `src/server/app.ts` の Origin 検査で POST が
 * 全部 403 になる(04 §2-9 の【必須】)。`detail_view` には代表レコードの `_id` を付ける
 * (付けないと単票が空になり、画面の計測に使えない)。
 */
export function referenceShopUrls(
  port: number,
  result: Pick<ProvisionResult, "appId" | "manifest" | "sampleRecordIds">,
): ReferenceShopUrl[] {
  const base = `http://localhost:${port}`;
  const urls: ReferenceShopUrl[] = [
    {
      label: `${result.manifest.app.name}(アプリのトップ)`,
      url: `${base}${routePath({ kind: "app", appId: result.appId })}`,
    },
  ];
  for (const view of result.manifest.app.views) {
    const recordId = view.type === "detail_view" ? result.sampleRecordIds[view.table] : undefined;
    urls.push({
      label: `${view.name ?? view.id}(${VIEW_TYPE_LABEL[view.type] ?? view.type} / ${view.table})`,
      url: `${base}${routePath({
        kind: "view",
        appId: result.appId,
        viewId: view.id,
        recordId,
      })}`,
      viewId: view.id,
    });
  }
  return urls;
}

/**
 * **`manual` と宣言したワークフローのID**(宣言順)。
 *
 * **手で書き写さずにマニフェストから引く**(`V5-M18`)—— 起動時の出力に古い名前が
 * 残っていた事故を、実際に起動して踏んだためである。
 */
export function manualWorkflowIds(manifest: Manifest): string[] {
  return (manifest.app.workflows ?? [])
    .filter((workflow) => workflow.trigger.type === "manual")
    .map((workflow) => workflow.id);
}

/** 起動時に標準出力へ出す本文。**平文の資格情報をそのまま出す**(`D-V4-4`)。 */
export function formatStartupReport(port: number, result: ProvisionResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(78));
  lines.push("参照ショップ(参照 EC)が起動しました。");
  lines.push("=".repeat(78));
  lines.push(`  データの置き場: ${result.dataRoot}(git 管理外。.gitignore の data-*/)`);
  lines.push(
    `  今回の用意     : アプリ=${result.appCreated ? "新規作成" : "既存を再利用"} / ` +
      `種データ=${result.seeded ? "投入した" : "既にあるので入れていない"}`,
  );
  lines.push("");
  lines.push("--- アカウント(平文。ローカル検証用) -----------------------------------");
  // **【`V5-M18` / `G-G21`】着手前はここに「以後この店の管理者は」と書いてあった。**
  // **プラットフォームの決まりを店の言葉で説明していた** —— `PLATFORM_NOTES` へ移した。
  lines.push(`  ${PLATFORM_NOTES.firstUserIsOwner}`);
  for (const account of [result.accounts.owner, result.accounts.customer]) {
    lines.push(
      `  - ${account.role.padEnd(8)} ユーザ名: ${account.username}  パスワード: ${account.password}`,
    );
  }
  lines.push("");
  lines.push("--- 踏める画面 ----------------------------------------------------------");
  for (const entry of referenceShopUrls(port, result)) {
    lines.push(`  ${entry.label}`);
    lines.push(`    ${entry.url}`);
  }
  lines.push("");
  lines.push("--- 行数(実測) --------------------------------------------------------");
  lines.push(
    `  ${Object.entries(result.rowCounts)
      .map(([table, count]) => `${table}=${count}`)
      .join(" / ")}`,
  );
  lines.push("");
  // **【`V5-M18` / `D-V5-86`】会計(支払い)の入力画面までの道順を出す。**
  // **着手前、この店には支払いを人が入力する画面が1本も無かった** —— 足したので、
  // 「どこを押せばカートから注文まで行けるか」を起動時に名指しする。
  lines.push("--- 会計まで(一覧の行の操作だけで通る道順) ------------------------------");
  lines.push(`  ${PLATFORM_NOTES.roleRulesAreNotJustDisplay}`);
  lines.push("  1. 商品一覧(catalog-list)の行の「買い物かごに入れる」");
  lines.push("     → cart-line-form に ?prefill.product=<商品の_id> が付いて開く");
  lines.push("  2. 買い物かご一覧(cart-list)の行の「会計に進む」");
  lines.push(
    "     → checkout-form に ?prefill.cart=<買い物かごの_id> が付いて開く(会計の入力画面)",
  );
  lines.push("  3. 買い物かご一覧の行の「この買い物かごを締める」");
  lines.push("     → wf-cart-close(manual)を押した行1行に対して起こす");
  lines.push("  4. 注文一覧(order-list)の行の「会計の控えを見る」");
  lines.push("     → order-receipt へ行く(宣言が無ければ order-detail へ行く。宣言が勝つ)");
  lines.push("");
  lines.push("--- 見えないものがある(黙らせない) ------------------------------------");
  // **【`V5-M18` / `G-G21`】プラットフォームの決まり(前半)とこの店の当てはめ(後半)を
  // 分けて書く。** 着手前は1文の中で混ざっていた。
  lines.push(`  - ${PLATFORM_NOTES.ownerScope}`);
  lines.push(
    `    この店では cart / cart_line / order / order_action がそれに当たります(customer=${result.accounts.customer.username})。`,
  );
  lines.push(`  - ${PLATFORM_NOTES.adminReadable}`);
  lines.push("    この店で宣言があるのは order だけで、order_line には無いため、owner から見た");
  lines.push("    注文詳細の明細は0件になります。");
  lines.push(`  - ${PLATFORM_NOTES.scheduleOnly}`);
  lines.push("    この店では cart_totals がそれに当たります(wf-totals-sweep は 03:00 だけ)。");
  lines.push(`  - ${PLATFORM_NOTES.outboundDestination}`);
  lines.push("    この店では mock-psp(決済要求)と mail-gateway(確認メール)の2つが宛先です。");
  lines.push(`  - ${PLATFORM_NOTES.manualTrigger}`);
  lines.push(`    この店で manual なのは ${manualWorkflowIds(result.manifest).join(" / ")} です。`);
  // **【`V5-M18` が実測で踏んだ】** 着手前のこの行は、実装で名前を変えたワークフローの
  // **古い名前を書いたまま**だった(起動して初めて気づいた)。**手で書き写した名前は腐る。**
  // **マニフェストから引くようにした** —— 名前を変えれば出力も追随する。
  lines.push("=".repeat(78));
  lines.push("");
  return lines.join("\n");
}

// --- CLI ---------------------------------------------------------------------

async function main(): Promise<void> {
  const config = resolveServeConfig(process.env);

  // 製品のサーバ起動経路(`src/server/index.ts`)が読む env を、import する前に確定させる。
  process.env.ST_DATA_ROOT = config.dataRoot;
  process.env.PORT = String(config.port);
  process.env.ST_AUTH_EXPECTED_ORIGIN = config.origin;
  process.env.ST_AUTH_RP_NAME = process.env.ST_AUTH_RP_NAME ?? "参照EC";
  process.env[CONNECTION_SECRET_ENV] = process.env[CONNECTION_SECRET_ENV] ?? "ref-ec-local-dummy";

  const result = await provisionReferenceShop(config);

  if (!existsSync(join(process.cwd(), "web", "dist", "index.html"))) {
    console.error(
      "[ref-ec] web/dist/index.html がありません。画面は出ません。" +
        "`mise exec -- bun run build:web` を先に走らせるか、`bun run serve:ref-ec` を使ってください。",
    );
  }

  // **製品のサーバをそのまま起動する**(写しを作らない)。ポートを開き、スケジューラと
  // アウトボックス配送と島の事前ロードを行うのは `src/server/index.ts` の責任である。
  await import("../../src/server/index.ts");

  console.log(formatStartupReport(config.port, result));
}

if (import.meta.main) {
  await main();
}
