/**
 * シナリオ `shared-lending-app`(共有型のアプリを1本作り切る)の**事前状態**を作るスクリプト。
 *
 * ## なぜ必要か
 *
 * `V8-M31` 以降、アプリを名指しする MCP ツールは「**名乗った利用者がそのアプリに
 * 登録されていること**」を要求する(`src/mcp/actor-guard.ts` の `requireActorAndApp`)。
 * ところが `create_app` は利用者を1人も作らない。したがって **AI が自分で作ったアプリの中では、
 * 続く `apply_diff` が必ず「名乗った利用者は、このアプリに登録されていません」で落ちる。**
 *
 * これはシナリオの本題(共有型のアプリを会話だけで作り切れるか)とは無関係な壁である。
 * そこで**試行を開始する前に**、空のアプリ1つと、そこに登録済みの利用者1人を用意する。
 * `seed.ts` と同じく、これは会話への介入ではない —— judge の `change_between_turns` /
 * `mtime_outside_run` は「ターンの前後でデータが変わったか」を見るので、最初のスナップショット
 * 採取より前に済ませてある限り検証には影響しない。**run.ts を起動したあとに実行してはならない。**
 *
 * ## 何を作るか(`seed.ts` との違い)
 *
 * `seed.ts` は**育ったプラットフォーム**を作る(アプリ2件 × 差分3本)。ここで作るのは逆に
 * **中身が空のアプリ1つ**である。テーブルも画面も1つも作らない —— **作るのは AI の仕事**であり、
 * ここで先回りするとシナリオが測ろうとしているものが消える。作るのは「入口」だけ:
 * アプリの器と、そこに登録済みの利用者1人。
 *
 * 利用者の役割は `owner` にする。シナリオは**運営者が自分の道具を作る**場面であり、
 * 途中で `set_roles` を含む差分を書けないと作り切れない。
 *
 * ## 使い方
 *
 *   mise exec -- bun run scripts/mcp-trial/seed-shared-app.ts --data-root data-shared-lending-app
 *   mise exec -- bun run scripts/mcp-trial/seed-shared-app.ts --data-root data-shared-lending-app --force
 *
 * ここで指定した `--actor` の値を、そのまま `run.ts --actor` に渡すこと
 * (`ST_MCP_ACTOR` に届かないと24本のツールが全部「名乗っていません」で落ちる)。
 *
 * 既にアプリがある場合は既定で何もしない(冪等ではなく**拒否**する)。`seed.ts` と同じ作法である
 * —— 追い蒔きすると、AI が育てた途中のアプリの上に事前状態を重ねることになるからである。
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { AuthStore } from "../../src/auth/store.ts";
import { createApp, KernelMetaStore } from "../../src/kernel/index.ts";
import { existingAppIds } from "./seed.ts";
import { assertIsolatedDataRoot } from "./snapshot.ts";

/** 事前状態の作り方(すべて既定値を持つので、引数なしでも走れる)。 */
export interface SeedSharedAppOptions {
  /** 評価専用のデータルート。`data-` で始まる名前しか受け付けない。 */
  dataRoot: string;
  /** 作る空アプリのID。 */
  appId: string;
  /** 作る空アプリの表示名。 */
  appName: string;
  /** そのアプリに登録する唯一の利用者のログイン名(= `run.ts --actor` に渡す値)。 */
  actor: string;
  /** 既にアプリがあるとき、データルートごと作り直す。 */
  force: boolean;
}

/** 事前状態の既定値。**`run.ts` の `--data-root` の既定(`data-<シナリオID>`)に合わせてある。** */
export const SEED_SHARED_APP_DEFAULTS: SeedSharedAppOptions = {
  dataRoot: "data-shared-lending-app",
  appId: "bihin-kashidashi",
  appName: "備品貸し出し",
  actor: "unei",
  force: false,
};

/**
 * コマンドライン引数のパース(純関数)。
 *
 * 知らないフラグ・値の無いフラグは落とす。**打ち間違いを既定値で埋めない** ——
 * 事前状態が意図と違うまま本物の LLM を回すと、失敗の原因がシナリオ側に見えてしまう。
 */
export function parseSeedSharedAppOptions(argv: string[]): SeedSharedAppOptions {
  const options: SeedSharedAppOptions = { ...SEED_SHARED_APP_DEFAULTS };
  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} には値が要ります。`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--data-root":
        options.dataRoot = requireValue("--data-root", value);
        i += 1;
        break;
      case "--app-id":
        options.appId = requireValue("--app-id", value);
        i += 1;
        break;
      case "--app-name":
        options.appName = requireValue("--app-name", value);
        i += 1;
        break;
      case "--actor":
        options.actor = requireValue("--actor", value);
        i += 1;
        break;
      case "--force":
        options.force = true;
        break;
      default:
        throw new Error(`知らないフラグです: ${flag}`);
    }
  }
  return options;
}

/**
 * 事前状態を作る(副作用の本体)。
 *
 * **開いた store は必ず閉じる。** `AuthStore.openForApp` は `CREATE TABLE` を走らせる
 * (= 書込)ので、開きっぱなしにすると後続の書込が `SQLITE_BUSY` になりうる
 * (`src/auth/store.ts:556` の逐語)。
 *
 * @returns 作った `app_id` と、登録した `username`
 */
export function seedSharedApp(options: SeedSharedAppOptions): {
  appId: string;
  username: string;
} {
  // リポジトリの `data/` を汚さない。`run.ts` と同じ番人を通す(別の判定を発明しない)。
  const dataRoot = assertIsolatedDataRoot(resolve(process.cwd(), options.dataRoot));

  const existing = existingAppIds(dataRoot);
  if (existing.length > 0) {
    if (!options.force) {
      throw new Error(
        `データルート "${dataRoot}" には既にアプリがあります(${existing.join(", ")})。` +
          `途中まで育ったアプリの上に事前状態を重ねないため、追い蒔きはしません。` +
          `最初からやり直すなら --force を付けてください(データルートごと消します)。`,
      );
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }

  const store = KernelMetaStore.open(dataRoot);
  let appId: string;
  try {
    // **中身は入れない。** テーブルも画面もワークフローも0件のまま渡す。
    appId = createApp(store, options.appName, { app_id: options.appId }).app.app_id;
  } finally {
    store.close();
  }

  const auth = AuthStore.openForApp(dataRoot, appId);
  let username: string;
  try {
    // **1人だけ。** 共有型のアプリだが、他の利用者は AI との会話の中で増える(あるいは増えない)。
    // ここで複数人を先に置くと「誰を招くか」までこちらが決めてしまう。
    username = auth.createUser({ username: options.actor, role: "owner" }).username;
  } finally {
    auth.close();
  }

  return { appId, username };
}

// --- CLI ---------------------------------------------------------------------

if (import.meta.main) {
  const options = parseSeedSharedAppOptions(process.argv.slice(2));
  const created = seedSharedApp(options);
  // **標準エラーに出す** —— 走行スクリプトが目視で確かめるための行であり、
  // パイプで拾って別の処理に食わせるための値ではない。
  console.error(`[seed-shared-app] app_id=${created.appId} username=${created.username}`);
  console.error(
    `[seed-shared-app] run.ts には --data-root ${options.dataRoot} --actor ${created.username} を渡してください。`,
  );
}
