/**
 * **`V7-M3-T02`**: **8経路すべてが判定を受ける(抜けを機械で捕まえる)。**
 *
 * **`v7-m0.md` §5-4 の (viii) の裁定** —— **一覧 `GET` / 単件 `GET` / `POST` / `PATCH` /
 * `DELETE` / 画面の操作起点 / バッチ / ファイル配信の8経路**。
 *
 * ## **本ファイルが採った形(自分で決めた。記録にも書く)**
 *
 * **8経路を全件列挙し、経路ごとに「今日配線されているか」を `expected` として固定する。**
 * **今日の実測は 6本が配線済み・2本が未配線である**(`DELETE` = `V7-M3-T06` /
 * ファイル配信 = `V7-M3-T07`)。**未配線の2本は「配線されていないこと」を検査が固定する。**
 *
 * **【なぜ「T06 / T07 の完了後に緑になる形」にしなかったか】** —— **その形にすると、
 * 今日から `V7-M3-T06` の完了までのあいだ検査が赤いままになり、`bun test` 全体の緑が
 * 失われる。** **本ファイルの形なら、`T06` が `DELETE` を配線した瞬間に本ファイルが**赤くなる**
 * —— **配線した人が `expected` を `"wired"` に書き換えるまで緑に戻らない。**
 * **どちらの向きでも抜けを捕まえる。** **黙って6本だけを数える形にはしていない**(8本すべてが
 * 下の `ROUTES` に在り、2本は担当タスク名つきで `"pending"` と書いてある)。
 *
 * **【したがって、起票の完了条件 (i) の逐語「8経路すべてで `judgeRecordAccess` が呼ばれる」は
 * 今日は成り立っていない。】** **成り立っているのは「8経路すべてが検査に列挙され、うち6本は
 * 呼ばれること・2本は呼ばれていないことが機械で固定されている」までである。**
 *
 * ## **本タスクが配線したもの**
 *
 * **`POST` / 画面の操作起点 / バッチ**の3本。**`DELETE`(`V7-M3-T06`)とファイル配信
 * (`V7-M3-T07`)は本タスクの範囲外である。**
 *
 * ## **本ファイルが測っていないもの(先に書く。憲法6)**
 *
 *  1. **MCP / 受信口 / ワークフロー / 島 / `GET /manifest` の5経路**(`Z-G21`〜`Z-G24`)——
 *     **今日も素通りする。** **本ファイルはそれを止めていない。**
 *  2. **`src/server/auth-routes.ts` が登録する経路**(`_auth_users` などのシステム表)——
 *     **1本も数えていない。**
 *  3. **画面(`web/`)を1バイトも触っていない。**
 *
 * ## **【`V8-M21` による追記。上の 1 は今日は 5経路のうち 3経路について偽である】**
 * **(旧文を1バイトも消していない)**
 *
 * **`D-V8-18`(判定が効く入口)に従い、`V8-M21` が **受信口 / 登録をきっかけに動く処理 /
 * コードの島** の3経路に判定を配線した**(台帳 `J-G21` / `J-G22a` / `J-G23` の限定採用)。
 * **したがって `ROUTES` は 8本 → 14本 になった** —— **表は1本のままである**
 * (`ADR-0176` 限定6 の「入口の本数の全量表を1つだけ持つ。表を2つに分けない」に倣った)。
 *
 * **【素通りするのは2本である。名指しする】**
 *  - **AI(MCP)**(`D-V8-20` = 常に管理者として扱う)。
 *  - **決まった時刻に動く処理**(`D-V8-33` / 台帳 `J-G22b` = **保留** /
 *    `docs/plan/undecided.md` の `U-3`)。
 *
 * **この2本は `expected: "pending"` の行として同じ表に載せた** —— **(B-2) が
 * 「今日ほんとうに呼んでいない」ことを機械で固定するので、誰かが配線したらここが赤くなる。**
 * **【禁止】したがって本ファイルに「全部の入口に効く」と書いてはならない**
 * (`04-rbac-abac-baseline.md` §9 の 1)。
 *
 * **`GET /api/apps/:app_id/manifest`(`J-G24a` / `J-G24b`)は本ファイルの担当ではない** ——
 * **`V8-M21` の後半(定義の取得)が扱う。** **今日も素通りするが、`ROUTES` には
 * 足していない**(足すと、まだ来ていない担当の仕事を「測った」と読める)。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_PATH = join(PRODUCT_ROOT, "src", "server", "app.ts");

// ---------------------------------------------------------------------------
// (A) `src/server/app.ts` の経路の全列挙 —— **1本増えたら赤くなる**
// ---------------------------------------------------------------------------

/** 登録行の正規表現(`app.get("…"` / `app.post("…"` …)。**登録順に返す。** */
const ROUTE_PATTERN = /\bapp\.(get|post|patch|delete|put|all|options|head)\(\s*"([^"]+)"/g;

type Registration = { readonly key: string; readonly index: number };

function registrationsOf(source: string): Registration[] {
  const found: Registration[] = [];
  ROUTE_PATTERN.lastIndex = 0;
  let match = ROUTE_PATTERN.exec(source);
  while (match !== null) {
    found.push({ key: `${match[1]?.toUpperCase()} ${match[2]}`, index: match.index });
    match = ROUTE_PATTERN.exec(source);
  }
  return found;
}

/** ハンドラ1本の本文(登録行から次の登録行の直前まで。最後の1本はファイル末尾まで)。 */
function bodyOf(source: string, registrations: Registration[], key: string): string {
  const at = registrations.findIndex((registration) => registration.key === key);
  if (at < 0) {
    throw new Error(`経路 "${key}" が app.ts に見つからない`);
  }
  const start = registrations[at]?.index ?? 0;
  const end = registrations[at + 1]?.index ?? source.length;
  return source.slice(start, end);
}

/**
 * **8経路の状態表**(`v7-m0.md` §5-4 の (viii))。
 *
 * **`wiredBy` は「誰が配線したか」、`expected` は「今日配線されているか」である。**
 * **`"pending"` の行は、担当タスクが配線した瞬間に (B-2) が赤くなる** —— **そのとき
 * `expected` を `"wired"` に、`wiredBy` を担当タスク名に書き換えること。**
 */
/**
 * **【`V8-M21` による移動。1文字も書き換えていない】** **判定の綴りの4つの `const`
 * (`JUDGE_PIPE` / `JUDGE_HOME` / `JUDGE_RESOLVER` / `JUDGE_COMBINER`)は、以前
 * `ROUTES` の**後ろ**に在った。** **`ROUTES` の行がその値を使うようになったので、
 * ここへ**そのまま**移した**(`const` は巻き上がらないため)。**doc も値も1文字も変えていない。**
 */
/** 判定の配管(`recordAccessJudge`)と判定そのもの(`judgeRecordAccess`)の綴り。 */
const JUDGE_PIPE = "recordAccessJudge(";
const JUDGE_HOME = "judgeRecordAccess(";
/**
 * **段ごとの点の解決**(`V17-M10B-T06`)。 **混ぜる前の2段
 * (**∪ すべての付与** / **∩ 符号を持つ付与**)を返す、非公開の1本である。**
 * **{@link JUDGE_HOME} も {@link JUDGE_RESOLVER} も、今日この1本を通る。**
 */
const JUDGE_STAGES = "recordAccessStages(";
/**
 * **引き継ぎ(`inherit_from`)を辿ってから各段で {@link JUDGE_HOME} を呼ぶ側**
 * (`V7-M4-T02` / `Z-G14`)。**配管が今日呼んでいるのはこちらである。**
 */
const JUDGE_RESOLVER = "resolveRecordAccess(";
/**
 * **面(役割に束ねた権限)と点(行ごとの付与)を `OR` で重ねる側**(`V8-M19` / `J-G18` /
 * `D-V8-23` / 裁定 `R-15-2`)。**配管が今日呼んでいるのはこちらであり、この関数の中で
 * {@link JUDGE_RESOLVER} が呼ばれ、その各段で {@link JUDGE_HOME} が呼ばれる。**
 * **判定の家は今日も1本である。**
 */
const JUDGE_COMBINER = "resolveCombinedRecordAccess(";

// **【`V8-M21`】判定の綴りの4つの `const` は、`ROUTES` の手前へそのまま移した**
// (**1文字も書き換えていない。移した理由はあちらの doc に書いた**)。

function judgedIn(body: string): boolean {
  return body.includes(JUDGE_PIPE) || body.includes(JUDGE_HOME);
}

// ---------------------------------------------------------------------------
// (B) 8経路の状態 —— **配線済み6本 / 未配線2本**
// ---------------------------------------------------------------------------

describe("V7-M3-T02 (B): 8経路すべてが判定を受けているかを1本ずつ数える", () => {
  // **【`V7-M3-T03` が足した。期待値を更新したのではなく、1本足した】**
  //
  // **`V7-M3-T03` は `DELETE` ハンドラに `judgeGrantWrite(`(付与表への書込の判定)を
  // 1件足した。** **これは (B-2) が数えている綴り(`recordAccessJudge(` /
  // `judgeRecordAccess(`)ではないので (B-2) は今日も緑である** —— **緑のままであることが
  // 「`DELETE` に何も掛かっていない」を意味しないので、下の1本で実物を名指しする。**
  //
  // **`DELETE` に掛かっているものと、掛かっていないもの**:
  //  - **掛かっている**: **その行が「誰かの付与」なら、付与が指す行への権限で絞る**
  //    (`V7-M3-T03` / `Z-G5`)。
  //  - **掛かっていない**: **行ごとのアクセス権の `delete`**(`V7-M3-T06` / `Z-G34`)——
  //    **`delete` を持たない権限名の actor は、今日も保護対象の行を消せる。**
  // **【`V7-M3-T06` による更新。旧文を1バイトも消していない】**
  //
  // **旧の名前**: `test("(B-2b) DELETE には付与表の書込判定だけが掛かっている(行の `delete`
  // 判定はまだ無い)", …)`。**旧の期待値**: `{ grantWrite: true, rowAccess: false }`。
  //
  // **`V7-M3-T06` が行ごとのアクセス権の `delete` を配線したので、2つとも掛かっている。**
  // **関門の順序は `v7-m0.md` §5-4 の (vi)** —— **(1) 所有者スコープ 404 →(2) 付与の可視性
  // 404 →(3) 付与の「消す」403 →(4) 削除保護 409。** **付与表への書込判定(`Z-G5`)は
  // その4段の後ろに在る**(順序の裁定は `DELETE` の4段についてであり、`Z-G5` の位置は
  // `V7-M3-T03` が置いた場所から1バイトも動かしていない)。
  test("(B-2b) DELETE には付与表の書込判定と行の `delete` 判定の両方が掛かっている", async () => {
    const source = await Bun.file(APP_PATH).text();
    const registrations = registrationsOf(source);
    const body = bodyOf(
      source,
      registrations,
      "DELETE /api/apps/:app_id/tables/:table_id/records/:record_id",
    );
    expect({
      grantWrite: body.includes("judgeGrantWrite") || body.includes("grantWriteVerdict("),
      rowAccess: judgedIn(body),
    }).toEqual({ grantWrite: true, rowAccess: true });
  });

  /*
   * **【`V8-M21` が足した。期待値を更新したのではなく、1本足した】**
   *
   * **`app.ts` の外の3経路が名指ししている述語(`inboundAccessDenied` /
   * `judgeAutomationWrite` / `judgeOutputTableReplace`)が、本当に判定の家へ届いていること
   * を固定する** —— **でないと「その綴りの関数を置いただけで中身が空」でも (B-1) が緑になる。**
   *
   * **届く先は `src/server/owner-scope.ts` の**既存の**述語である**
   * (`creatorGrantPlan` / `resolveRecordAccess`)。**新しい判定の家を1本も作っていない。**
   */
  test("(B-4) app.ts の外の判定は、owner-scope.ts の既存の述語に届いている", async () => {
    const bodyOfFunction = async (file: string, from: string): Promise<string> => {
      const text = await Bun.file(file).text();
      const at = text.indexOf(from);
      expect(at, `${from} が ${file} に無い`).toBeGreaterThan(0);
      const end = text.indexOf("\n}\n", at);
      return text.slice(at, end < 0 ? text.length : end);
    };
    const inbound = await bodyOfFunction(
      join(PRODUCT_ROOT, "src", "server", "inbound-route.ts"),
      "function inboundAccessDenied(",
    );
    const automation = await bodyOfFunction(
      join(PRODUCT_ROOT, "src", "kernel", "workflow-runner.ts"),
      "function judgeAutomationWrite(",
    );
    const replace = await bodyOfFunction(
      join(PRODUCT_ROOT, "src", "kernel", "workflow-runner.ts"),
      "function judgeOutputTableReplace(",
    );
    // **【`V8-M21` の後半による更新。旧文を1バイトも消していない】**
    // **旧の観測点(逐語)**: `automationResolver: automation.includes(JUDGE_RESOLVER),`
    // (= `resolveRecordAccess(` を直接呼んでいること)。**旧の期待値**: `automationResolver: true`。
    //
    // **後半が面(役割に束ねた権限)を掛けたので、カーネルが呼ぶのは
    // `resolveCombinedRecordAccess`(面と点を `OR` で重ねる側)になった** ——
    // **その中で `resolveRecordAccess` が呼ばれ、各段で判定の家が呼ばれる。**
    // **判定の家は今日も1本である。**
    //
    // **【緩めていない。要求を2本増やした】** —— **(1) 合成の1本を呼んでいること、
    // (2) 面の判定(`judgeRoleAccess`)と、面と点を重ねる述語(`combineRoleAndCreatorGrant`)を
    // 受信口とカーネルの両方が呼んでいること。**
    // **旧の要求(判定の家を写していない = `judgeRecordAccess` を直接呼ばない)は今日も在る。**
    expect({
      inboundCreator: inbound.includes("creatorGrantPlan("),
      inboundRole: inbound.includes("judgeRoleAccess("),
      inboundCombiner: inbound.includes("combineRoleAndCreatorGrant("),
      automationCreator: automation.includes("creatorGrantPlan("),
      automationRole: automation.includes("judgeRoleAccess("),
      automationCombiner: automation.includes("combineRoleAndCreatorGrant("),
      automationResolver: automation.includes(JUDGE_COMBINER),
      replaceReusesAutomation: replace.includes("judgeAutomationWrite("),
      // **判定の家をカーネル側に写していない** —— **`judgeRecordAccess` を直接呼ばない**
      // (下の (C-4) が綴りの不在を全ファイルで固定しているのと同じ向きの要求)。
      automationHome: automation.includes(JUDGE_HOME),
    }).toEqual({
      inboundCreator: true,
      inboundRole: true,
      inboundCombiner: true,
      automationCreator: true,
      automationRole: true,
      automationCombiner: true,
      automationResolver: true,
      replaceReusesAutomation: true,
      automationHome: false,
    });
  });

  /*
   * **【`V8-M21` が足した】** **素通りが「1本の述語」で決まっていることの固定。**
   *
   * **時刻起動を素通しにしているのは `accessJudgmentApplies` の1行だけである**
   * (`D-V8-33` / 台帳 `J-G22b` = 保留 / `docs/plan/undecided.md` の `U-3`)。
   * **経路ごとに別々の `if` を書くと、片方だけ直されて食い違う。**
   *
   * **【この検査が言わないこと】** **「時刻起動が安全である」とは1文字も言っていない** ——
   * **素通りしていることを固定しているだけである。**
   *
   * **【2026-09-07 の訂正(`V17-M3-T11`。独立点検の指摘7)。上の文も下の doc も
   * 1バイトも消していない】**
   *
   * **下の逐語「判定を掛けるかどうかを決める分岐は、この述語の呼び出しだけである。」は、
   * 今日は偽である。** **2本目の分岐が `src/kernel/ai-dispatcher.ts:381` に在る** ——
   * **`writeBackJudgmentApplies` が、その述語の答えに `workflow !== undefined &&` を
   * 1つ足した形で、AI の書き戻しに判定を掛けるかを決めている**(`V17-M3-T03b` / `ADR-0415`)。
   * **「ワークフロー定義を引けなかったジョブは通す」という素通しの条件が1つ増えており、
   * それは `workflow-runner.ts` の側には1文字も無い。**
   *
   * **下の式は `workflow-runner.ts` **1本だけ**を読むので、この2本目の分岐が足されても
   * 緑のままである** —— **検査が赤くならずに doc だけが嘘になった型である**
   * (既知の躓き `checks-go-false-after-writing` / `verbatim-residue-fools-source-scanning-tests`)。
   *
   * **【この訂正が言わないこと】** **「2本目の分岐が間違いである」とは書いていない** ——
   * **時刻起動を素通しにする答えそのものは1つの述語が決めており、`ai-dispatcher.ts` の側は
   * その答えを別プロセスから引き直すための手当てである**(`ADR-0415` §限界)。
   * **偽になったのは「分岐が1箇所しかない」という主張の側だけである。**
   */
  test("(B-5) 時刻起動の素通しは1本の述語で決まっている(条件式が散らばっていない)", async () => {
    const text = await Bun.file(join(PRODUCT_ROOT, "src", "kernel", "workflow-runner.ts")).text();
    const at = text.indexOf("function accessJudgmentApplies(");
    expect(at).toBeGreaterThan(0);
    const body = text.slice(at, text.indexOf("\n}\n", at));
    expect(body.includes('workflow.trigger.type !== "schedule"')).toBe(true);
    // **判定を掛けるかどうかを決める分岐は、この述語の呼び出しだけである。**
    const calls = text.split("accessJudgmentApplies(").length - 1;
    // **1件が定義、4件が呼び出し**(`create_record` / `update_record` / 島 / 出力先の全置換)。
    expect(calls).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// (C) **判定の戻り値を捨てる呼び出しが1つも無い**(完了条件 iii / `v7-m0.md` §5-4 の (v))
// ---------------------------------------------------------------------------

/** 呼び出しの開き括弧の位置から、対応する閉じ括弧の直後の位置を返す。 */
function afterCall(source: string, openParen: number): number {
  let depth = 0;
  for (let at = openParen; at < source.length; at += 1) {
    const char = source[at];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
  }
  throw new Error("括弧が閉じていない");
}

/** 戻り値の使われ方。**`discarded` が1件でもあれば完了条件 (iii) が破れている。** */
type Usage = { readonly call: string; readonly consumed: boolean };

function judgeUsages(source: string): Usage[] {
  const usages: Usage[] = [];
  // **`judge(` と `judgeRecordAccess(` の呼び出しを全件拾う**(`recordAccessJudge(` は
  // 大文字の `J` なのでこの正規表現に当たらない —— あちらは (B-3) が数えている)。
  const pattern = /\bjudge(?:RecordAccess)?\(/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const start = match.index;
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const prefix = source.slice(lineStart, start);
    // **定義は呼び出しではない。**
    if (/\bfunction\s+$/.test(prefix) || /\*\s*$/.test(prefix)) {
      match = pattern.exec(source);
      continue;
    }
    const end = afterCall(source, source.indexOf("(", start));
    const tail = source.slice(end, end + 12);
    const assigned = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(prefix);
    // **戻り値をそのまま呼び出し元へ返す形は「捨てている」ではない**
    // (`recordAccessJudge` の `return (row) => judgeRecordAccess(…)` がこれである)。
    // **【`V7-M4-T04`(`Z-G17`)による更新。旧の綴りを1バイトも消していない】**
    //
    // **旧の3本の正規表現**:
    //   `/^\s*\.(read|write|delete)\b/` /
    //   `` `\\b${name}\\.(read|write|delete)\\b` `` /
    //   `` `\\.${property}\\.(read|write|delete)\\b` ``
    //
    // **配管 `recordAccessJudge` が返す関数の戻り値が `RecordAccessVerdict` から
    //   `RecordAccessResolution`(判別可能なユニオン)に変わったので、動詞は
    //   `…​.verdict.read` の1段深いところに在る。** **`verdict.` の1段を**任意**として
    //   足しただけであり、「動詞を見ていること」を要求する強さは1ミリも緩めていない**
    //   —— **`.verdict` を書いただけで動詞を見ていない形は、今日も `consumed` にならない。**
    // **打ち切り(`limit_exceeded`)を丸めていないことは、この検査ではなく
    //   `src/server/access-control-limit-honesty.test.ts` の (E) が別に測る。**
    const verb = "(?:verdict\\.)?(read|write|delete)";
    let consumed =
      /^\s*\.(?:verdict\.)?(read|write|delete)\b/.test(tail) || /(?:\breturn|=>)\s*$/.test(prefix);
    if (!consumed && assigned !== null) {
      const name = assigned[1] as string;
      const window = source.slice(end, end + 900);
      consumed = new RegExp(`\\b${name}\\.${verb}\\b`).test(window);
    }
    // **オブジェクトの項目に載せて返す形**(単件 `GET` の `access: judge(…)`)も、
    // **その項目名で `read` / `write` / `delete` を見ていれば捨てていない。**
    if (!consumed) {
      const property = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(prefix);
      if (property !== null) {
        const window = source.slice(end, end + 3000);
        consumed = new RegExp(`\\.${property[1] as string}\\.${verb}\\b`).test(window);
      }
    }
    usages.push({ call: source.slice(lineStart, end).trim().slice(0, 60), consumed });
    match = pattern.exec(source);
  }
  return usages;
}

describe("V7-M3-T02 (C): 判定の戻り値を捨てる呼び出しが1つも無い", () => {
  test("(C-1) app.ts の judge(...) / judgeRecordAccess(...) は、すべて read/write/delete を見ている", async () => {
    const source = await Bun.file(APP_PATH).text();
    const usages = judgeUsages(source);
    expect(usages.length).toBeGreaterThan(0);
    expect(usages.filter((usage) => !usage.consumed)).toEqual([]);
  });

  /*
   * **【`V7-M4-T02`(`Z-G14`)による更新。旧文を1バイトも消していない】**
   *
   * **旧の名前**: `test("(C-2) 配管 recordAccessJudge は judgeRecordAccess を1度だけ呼び、
   * その戻り値を返す", …)`。
   * **旧の中身**:
   *   `expect(body.split(JUDGE_HOME).length - 1).toBe(1);`
   *   `expect(body.includes(\`return (row) => ${"$"}{JUDGE_HOME}\`)).toBe(true);`
   *
   * **今日、配管が呼ぶのは `resolveRecordAccess`(引き継ぎを辿る側)である。**
   * **`judgeRecordAccess` は各段で `resolveRecordAccess` の中から呼ばれる** ——
   * **判定の家は今日も1本である。**
   *
   * **【緩めていない。むしろ1本増やした】** —— **旧は「配管が判定を1度だけ呼ぶ」だけを
   * 見ていた。** **今日はそれに加えて、`owner-scope.ts` の `resolveRecordAccess` の中で
   * `judgeRecordAccess` が実際に呼ばれていることを固定する** —— **でないと
   * 「配管が判定を1度も呼ばなくなった」形でも緑になってしまう。**
   */
  /*
   * **【`V8-M19`(`J-G18` / `D-V8-23`)による更新。旧文を1バイトも消していない】**
   *
   * **旧の名前**: `test("(C-2) 配管 recordAccessJudge は resolveRecordAccess を1度だけ呼び、
   * その判定を返す", …)`。
   * **旧の中身(逐語)**:
   *   `expect(body.split(JUDGE_RESOLVER).length - 1).toBe(1);`
   *   `expect(/return \(row\) =>\s*resolveRecordAccess\(/.test(body)).toBe(true);`
   *   `expect(body.includes("=> RecordAccessResolution) | undefined")).toBe(true);`
   *
   * **今日、配管が呼ぶのは `resolveCombinedRecordAccess`(面と点を `OR` で重ねる側)である。**
   * **`resolveRecordAccess` はその中から呼ばれ、各段で `judgeRecordAccess` が呼ばれる** ——
   * **判定の家は今日も1本である。**
   *
   * **【緩めていない。要求を1本増やした】** —— **旧は「配管が引き継ぎの解決を1度だけ呼ぶ」
   * ことだけを見ていた。** **今日はそれに加えて、`owner-scope.ts` の
   * `resolveCombinedRecordAccess` の中で `resolveRecordAccess` が実際に呼ばれていることを
   * 固定する** —— **でないと「配管が点の判定を1度も呼ばなくなった」形でも緑になってしまう。**
   */
  test("(C-2) 配管 recordAccessJudge は resolveCombinedRecordAccess を1度だけ呼び、その判定を返す", async () => {
    const source = await Bun.file(APP_PATH).text();
    const at = source.indexOf(`function ${JUDGE_PIPE}`);
    expect(at).toBeGreaterThan(0);
    const body = source.slice(at, source.indexOf("\n}\n", at));
    expect(body.split(JUDGE_COMBINER).length - 1).toBe(1);
    // **配管そのものは判定式を1つも持たない** —— **`judgeRecordAccess` を直接呼ばない。**
    expect(body.split(JUDGE_HOME).length - 1).toBe(0);
    // **戻り値を捨てていない**(`(row) => resolveCombinedRecordAccess(…)` の形)。
    expect(/return \(row\) =>\s*resolveCombinedRecordAccess\(/.test(body)).toBe(true);
    // **【`V7-M4-T04`(`Z-G17`)による更新。旧文を1バイトも消していない】**
    //
    // **旧**: `expect(body.includes(").verdict;")).toBe(true);`
    //
    // **配管は今日、`.verdict` を取り出さずに `RecordAccessResolution` をそのまま返す** ——
    // **取り出してしまうと、上限に当たったこと(`limit_exceeded`)が呼び出し側に届かず、
    //   「見えない」に丸めるしか無くなるからである**(完了条件 (iii))。
    // **【緩めていない。要求を2本に増やした】** —— **(1) `.verdict` を配管の中で
    //   取り出していないこと、(2) 戻り値の型が `RecordAccessResolution` であること。**
    expect(body.includes(").verdict;")).toBe(false);
    // **【`V8-M19` による更新。旧の綴りを上のコメントに逐語で残した】**
    // **戻り値の型は `CombinedRecordAccessResolution`(`RecordAccessResolution` と同じ形に、
    // 「止めた層」の1本を足したもの)である** —— **`limit_exceeded` の枝は今日も在る。**
    expect(body.includes("=> CombinedRecordAccessResolution) | undefined")).toBe(true);

    // **判定の家は1本のままである** —— **`resolveRecordAccess` の中で `judgeRecordAccess`
    // が呼ばれている**(**app.ts から消えた1件の行き先**)。
    const ownerScope = await Bun.file(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts")).text();
    const resolverAt = ownerScope.indexOf(`export function ${JUDGE_RESOLVER}`);
    expect(resolverAt).toBeGreaterThan(0);
    const resolverBody = ownerScope.slice(resolverAt, ownerScope.indexOf("\n}\n", resolverAt));
    // **【`V17-M10B-T06`(`ADR-0430` (δ))による更新。旧の assert を1バイトも消していない】**
    // **旧(逐語)**: `expect(resolverBody.split(JUDGE_HOME).length - 1).toBe(1);`
    // **旧は「`resolveRecordAccess` の中で `judgeRecordAccess(` が1度だけ呼ばれている」を
    // 撃っていた。** **今日そこで呼ばれるのは `recordAccessStages(` である** ——
    // **上限を段どうしでまたいで重ねるため、混ぜる前の2段のまま受け取る必要が出た。**
    // **判定の家は今日も1本であり、`judgeRecordAccess` 自身が同じ1本を通る**
    // (下の assert)。
    // **【差で失われた入力の例(1つ)】** —— **`resolveRecordAccess` が
    // `recordAccessStages(` を1度だけ呼びながら、その答えを捨てて別の綴りの第2の判定
    // (たとえば `looseRecordAccess(`)の答えを返す実装。** **旧の assert は
    // `judgeRecordAccess(` が0件になるので落としたが、今日の assert は通してしまう。**
    // **【禁止】これを「不要になった」と書かない。**
    expect(resolverBody.split(JUDGE_STAGES).length - 1).toBe(1);
    const judgeHomeAt = ownerScope.indexOf(`export function ${JUDGE_HOME}params: {`);
    expect(judgeHomeAt).toBeGreaterThan(0);
    const judgeHomeBody = ownerScope.slice(judgeHomeAt, ownerScope.indexOf("\n}\n", judgeHomeAt));
    expect(judgeHomeBody.split(JUDGE_STAGES).length - 1).toBe(1);
    // **【`V8-M19`】合成の側が、点の解決を実際に1度だけ呼んでいる。**
    const combinerAt = ownerScope.indexOf(`export function ${JUDGE_COMBINER}`);
    expect(combinerAt).toBeGreaterThan(0);
    const combinerBody = ownerScope.slice(combinerAt, ownerScope.indexOf("\n}\n", combinerAt));
    expect(combinerBody.split(JUDGE_RESOLVER).length - 1).toBe(1);
  });

  test("(C-3) 判定式は app.ts に無い —— access_control の綴りが1件も無い(`ADR-0294` 限定12)", async () => {
    const source = await Bun.file(APP_PATH).text();
    expect(source.includes("access_control")).toBe(false);
  });

  /*
   * **【`V8-M21` による追記。検査の中身は1バイトも変えていない】**
   *
   * **この検査が固定しているのは「`judgeRecordAccess` という綴りが MCP / カーネル /
   * 受信口に無いこと」だけである。** **`V8-M21` の配線後は、受信口とカーネルが
   * `resolveRecordAccess` / `creatorGrantPlan`(どちらも `owner-scope.ts` の既存の述語)を
   * 呼ぶようになった** —— **判定の家は今日も1本のままで、この検査は緑である。**
   *
   * **【禁止】したがって、この検査の緑を「受信口とカーネルには判定が1バイトも掛かって
   * いない」と読み替えてはならない。** **掛かっている**(上の (B-1) の 9〜12 行目)。
   */
  test("(C-4) 判定の家は1本 —— MCP / 受信口 / カーネルから1度も呼ばれない(`ADR-0294` 限定7)", async () => {
    const roots = [
      join(PRODUCT_ROOT, "src", "mcp"),
      join(PRODUCT_ROOT, "src", "kernel"),
      join(PRODUCT_ROOT, "src", "server", "inbound-route.ts"),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      if (await Bun.file(root).exists()) {
        if ((await Bun.file(root).text()).includes("judgeRecordAccess")) {
          hits.push(root);
        }
        continue;
      }
      for (const entry of await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root }))) {
        const path = join(root, entry);
        if ((await Bun.file(path).text()).includes("judgeRecordAccess")) {
          hits.push(path);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】予約規約フィールドは 5本 → 4本。**
  // **`st_admin_readable` を廃止し、面の規則(役割 × 対象(表)× 読取)へ置き直した。**
  // **旧: `expect(declared.length).toBe(5);`(`ADMIN_READABLE_FIELD` を含んでいた)。**
  // **旧のテスト名: 「(C-5) 予約規約フィールドは5本のまま(`ADR-0294` 限定17)」。**
  // **`ADR-0294` 限定17(v7 は1本も足さない)は今日も破っていない** —— **減らしたのは `V8-M20`。**
  test("(C-5) 予約規約フィールドは4本(`ADR-0294` 限定17 は v7 の話。減らしたのは `V8-M20`)", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts")).text();
    const declared = source.match(/^export const [A-Z_]+_FIELD = /gm) ?? [];
    expect(declared.length).toBe(4);
  });

  // =====================================================================================
  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  //
  // **旧のテスト名**: `(C-6) nonAdminTableAccess は3値のまま(\`ADR-0295\` 限定3)`
  // **旧の期待値(逐語)**:
  //   expect(
  //     source.includes('export type NonAdminTableAccess = "scoped" | "public" | "denied";'),
  //   ).toBe(true);
  //
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。** **型ごと撤去した。**
  // **`ADR-0295` 限定3(「4値目を足さない」)は今日も破られていない** ——
  // **足すどころか、値域そのものが無くなった。**
  //
  // **【この反転を書かないと、検査が「緑のまま嘘」になる。実測して確かめた】** ——
  // **撤去の記録として `owner-scope.ts` のコメントに旧の宣言が逐語で残っているので、
  // `includes` は今日も真を返す。** **コメント行を除いて見なければ測れない。**
  // =====================================================================================
  /*
   * **【`V17-M6-T04` / 台帳 `AC-G24` が足した1本。既存の検査を1つも書き換えていない】**
   *
   * **門外の限定4 の逐語**: 「**判定式を1本も増やさない**(`judgeRecordAccess` の呼び出しを
   * 増やすだけ)」。 **その【実装時に置く】固定がこの項である。**
   *
   * **【何を測っているか。緩めずに書く】** —— **付与の出どころを組む述語の本文が、
   * (1) `judgeRecordAccess` を呼んでいること、(2) 宣言の `permissions` を1度も読まないこと、
   * (3) 権限名の突き合わせ(`resolveGrantedPermissionNames`)を自分で呼ばないことの3つである。**
   * **(2)(3) のどちらかを書いた瞬間、それは「動詞を自分で決める2本目の判定式」になる。**
   *
   * **【この検査が測っていないもの。誇張しない】** —— **本文に条件分岐(`if`)が在ることは
   * 止めていない**(相手の解決・上限の受け渡し・空の付与行の読み飛ばしに要る)。
   * **止めているのは「動詞を自分で決める式」だけである。**
   */
  test("(C-7) 付与の出どころを組む述語は judgeRecordAccess を呼ぶだけで、動詞を自分で決めない", async () => {
    const ownerScope = await Bun.file(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts")).text();
    const at = ownerScope.indexOf("export function resolveRecordAccessSources(");
    expect(at).toBeGreaterThan(0);
    const body = ownerScope.slice(at, ownerScope.indexOf("\n}\n", at));
    expect(body.includes("judgeRecordAccess(")).toBe(true);
    // **宣言の権限表を1度も読まない**(動詞は判定の戻り値からしか取らない)。
    expect(body.includes(".permissions")).toBe(false);
    // **権限名の突き合わせを自分で呼ばない**(判定の中でだけ走る)。
    expect(body.includes("resolveGrantedPermissionNames(")).toBe(false);
  });

  test("(C-6) nonAdminTableAccess は実装から消えた(`ADR-0295` 限定3 の4値目は今日も無い)", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts")).text();
    expect(
      source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .some((line) => line.includes("NonAdminTableAccess")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (D)(E)(F) HTTP —— **実サーバ・実 SQLite で測る**
// ---------------------------------------------------------------------------

const APP_ID = "grant-shelf";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "付与の棚",
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "state", name: "状態", type: "text" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            // **【`V18-M5-T02b` / `PM-G2` / `ADR-0442`】題材に1行足した(主張は1バイトも
            // 書き換えていない)。** **根の表に「行を作れる立場」を一行も書かないときの
            // 既定が「誰も作れない」へ反転したので**(`ADR-0432` §Decision)、
            // **`books` への `POST` を撃つ7本が、測りたい答え(400 / 201)の手前で
            // 403 になっていた。**
            // **`customer` も挙げている** —— **(G-1) / (G-2) がその立場で撃つからである。**
            // **`customer` の宣言は下の {@link manifestWithRoles} が足す**(既定3役割には
            // 入っていないので、足さないと適用時検査 `referential-integrity.ts` の
            // 項目11 が差分ごと拒否する)。
            creatable_by_roles: ["editor", "customer"],
            grant: {
              table: "book_grant",
              target: "book",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "book_member", account: "account", group: "team" },
            groups: { table: "book_team" },
          },
        },
        {
          // **宣言を書いたが `enabled: false`**(= 宣言していない表と同じ扱い)。
          id: "drafts",
          name: "下書き",
          fields: [{ id: "title", name: "タイトル", type: "text" }],
          access_control: {
            enabled: false,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "draft_grant",
              target: "draft",
              member: "member",
              permission: "permission",
            },
            members: { table: "book_member", account: "account" },
          },
        },
        {
          id: "draft_grant",
          name: "下書きの付与",
          fields: [
            { id: "draft", name: "下書き", type: "reference", reference_table: "drafts" },
            { id: "member", name: "相手", type: "reference", reference_table: "book_member" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
        {
          // **宣言していない表**(オプトインの対照)。
          id: "notes",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          id: "book_team",
          name: "グループ",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "book_member",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "グループ", type: "reference", reference_table: "book_team" },
          ],
        },
        {
          id: "book_grant",
          name: "本の付与",
          fields: [
            { id: "book", name: "本", type: "reference", reference_table: "books" },
            { id: "member", name: "相手", type: "reference", reference_table: "book_member" },
            { id: "team", name: "グループ", type: "reference", reference_table: "book_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
        {
          id: "wf_runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      ],
      views: [
        {
          id: "book-list",
          type: "list_view",
          table: "books",
          columns: ["title", "state"],
          actions: [{ run: "stamp", name: "印をつける" }],
        },
      ],
      workflows: [
        {
          id: "stamp",
          name: "印をつける",
          trigger: { type: "manual", table: "books" },
          actions: [
            {
              action: "update_record",
              table: "books",
              target: "$record._id",
              values: { state: "済" },
            },
          ],
          history_table: "wf_runs",
        },
      ],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の規則を足した題材**(適用に渡すのはこちら)。
 *
 * **`V8-M26` が面の既定を「閉じる」側へ倒した** —— **規則を1本も名指ししていない
 * `table` / `view` / `action` は拒否される**(ユーザ決定 `D-V8-45` / `D-V8-65`)。
 * **実アプリでは差分の畳み込み(`src/kernel/apply-diff.ts`)が既定3役割へ規則を自動で
 * 足すが、本検査は `applyManifest` を直接呼ぶのでその経路を1度も通らない。**
 * **そのぶんだけを `withDefaultRoleRules` で埋める**(判定の実装は1バイトも触っていない)。
 *
 * **`books` は `skipTables` で外す** —— **`access_control` を宣言した表であり、面の規則を
 * 1本でも足すと面と点が `OR` で重なって全員が通り、この検査の主題(**行ごとの付与だけで
 * 可否が決まること**)が丸ごと測れなくなる。**
 *
 * **`drafts` は外さない** —— **宣言は書いてあるが `enabled: false` であり、点は管轄外で
 * ある(= 宣言していない表と同じ扱い)。** **(D-5) はそこへの `POST` が今日どおり
 * 201 であることを測っている。**
 */
function manifestWithRoles(): Manifest {
  const applied = withDefaultRoleRules(manifest(), { skipTables: ["books"] }) as unknown as {
    app: { roles: { id: string; name: string }[] };
  };
  // **【`V18-M5-T02b` / `PM-G2` / `ADR-0442`】役割 `customer` の宣言を1行足した。**
  // **(G-1) / (G-2) はこの立場で `books` へ `POST` するので、9キー目
  // (`creatable_by_roles`)に挙げる必要があり、挙げる先は実在する役割でなければ
  // ならない(適用時検査 `referential-integrity.ts` の項目11)。**
  // **規則(`rules`)は1本も書かない** —— **面を1ミリも開けないためである
  // (上の `skipTables` と同じ理由)。**
  if (!applied.app.roles.some((role) => role.id === "customer")) {
    applied.app.roles.push({ id: "customer", name: "利用者" });
  }
  return applied as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/** メンバー表に行がある人 / 行が無い人。**どちらも `editor`**(差はメンバー行と付与だけ)。 */
let member: ReturnType<typeof seedSession>;
let stranger: ReturnType<typeof seedSession>;
let memberRowId = "";
/** 既存の行(`member` に `writer` の付与がある行 / 付与が1件も無い行)。 */
let granted = "";
let ungranted = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookie: string): Promise<Response> {
  return await app.request(path, { headers: { cookie } });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acp-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "付与の棚", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  member = seedSession(dataRoot, APP_ID, { role: "editor", username: "member" });
  stranger = seedSession(dataRoot, APP_ID, { role: "editor", username: "stranger" });

  const loaded = manifest();
  withDb((db) => {
    const created = createRecord(db, loaded, "book_member", { account: member.userId });
    expect(created.ok).toBe(true);
    memberRowId = (created as { value: { _id: string } }).value._id;
    const book = (title: string): string => {
      const row = createRecord(db, loaded, "books", { title });
      expect(row.ok).toBe(true);
      return (row as { value: { _id: string } }).value._id;
    };
    granted = book("付与のある本");
    ungranted = book("付与の無い本");
    const grant = createRecord(db, loaded, "book_grant", {
      book: granted,
      member: memberRowId,
      permission: "writer",
    });
    expect(grant.ok).toBe(true);
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V7-M3-T02 (D): POST —— 作成者への自動付与と、メンバー表に行が無い人の拒否", () => {
  test("(D-1) メンバー表に行が無い人の POST は 400 で、文言に内部記号が1文字も無い", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/books/records`, stranger.cookie, {
      title: "作れないはずの本",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: { message: string; hint?: string }[] };
    // **【`V8-M41` / 台帳 `F-G12`。2026-08-13。期待値を入れ替えた。旧の1行を逐語で残す】**
    //
    // **旧: `expect(body.errors[0]?.message).toBe(`**
    // **  `"あなたはこのアプリのメンバー表に登録されていないため、この表に行を作れません。",`**
    // **`);`**
    //
    // **`v8-m35.md` §5-1 の `F-G12` の限定(「**断りの文面と手引きだけ**」)により、
    // 文面が「次に何をすればよいか」を持つ形に差し替わった。** **応答コード(400)も、
    // 内部記号を1文字も出さない作法も、1バイトも動いていない**(下の輪がそれを測る)。
    expect(body.errors[0]?.message).toBe(
      "この表に行を作れるのは、このアプリの利用者の表に登録されている人だけです。あなたはまだ登録されていません。",
    );
    const text = JSON.stringify(body);
    for (const symbol in { access_control: 1, "Z-G": 1, judgeRecordAccess: 1, book_member: 1 }) {
      expect({ symbol, leaked: text.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });

  test("(D-2) 拒否されたとき、行は1件も増えていない", async () => {
    const before = withDb(
      (db) => (db.query("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n,
    );
    await post(`/api/apps/${APP_ID}/tables/books/records`, stranger.cookie, { title: "増えない" });
    const after = withDb(
      (db) => (db.query("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n,
    );
    expect({ before, after }).toEqual({ before: 2, after: 2 });
  });

  test("(D-3) メンバー表に行がある人の POST は 201 で、付与表に作成者への付与が1件入る", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/books/records`, member.cookie, {
      title: "作れる本",
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { record: { _id: string } };
    const grants = withDb(
      (db) =>
        db
          .query("SELECT member, permission FROM book_grant WHERE book = ?")
          .all(created.record._id) as { member: string; permission: string }[],
    );
    expect(grants).toEqual([{ member: memberRowId, permission: "keeper" }]);
  });

  test("(D-4) 作った本人は、作った行を一覧 GET / 単件 GET / PATCH できる(creator_permission が効く)", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/books/records`, member.cookie, {
      title: "自分の本",
    });
    const created = (await response.json()) as { record: { _id: string } };
    const list = await get(`/api/apps/${APP_ID}/tables/books/records`, member.cookie);
    const listBody = (await list.json()) as { records: { _id: string }[] };
    expect(listBody.records.some((row) => row._id === created.record._id)).toBe(true);

    const single = await get(
      `/api/apps/${APP_ID}/tables/books/records/${created.record._id}`,
      member.cookie,
    );
    expect(single.status).toBe(200);
    const version = single.headers.get("etag") as string;
    const patched = await app.request(
      `/api/apps/${APP_ID}/tables/books/records/${created.record._id}`,
      {
        method: "PATCH",
        headers: {
          cookie: member.cookie,
          origin: TEST_ORIGIN,
          "content-type": "application/json",
          "if-match": version,
        },
        body: JSON.stringify({ title: "書き換えた" }),
      },
    );
    expect(patched.status).toBe(200);
  });

  test("(D-5) 宣言していない表 / enabled: false の表の POST は今日と1バイトも変わらない", async () => {
    const note = await post(`/api/apps/${APP_ID}/tables/notes/records`, stranger.cookie, {
      body: "誰でも作れる",
    });
    expect(note.status).toBe(201);
    const draft = await post(`/api/apps/${APP_ID}/tables/drafts/records`, stranger.cookie, {
      title: "enabled: false",
    });
    expect(draft.status).toBe(201);
    // **付与表には1行も入っていない**(自動付与は宣言した表だけの話である)。
    const grants = withDb(
      (db) => (db.query("SELECT COUNT(*) AS n FROM book_grant").get() as { n: number }).n,
    );
    expect(grants).toBe(1);
  });
});

describe("V7-M3-T02 (E): バッチ —— 付与の無い行を混ぜた書込は拒否され、付与のある行だけなら通る", () => {
  async function version(recordId: string): Promise<string> {
    return withDb(
      (db) =>
        (
          db.query("SELECT _updated_at FROM books WHERE _id = ?").get(recordId) as {
            _updated_at: string;
          }
        )._updated_at,
    );
  }

  test("(E-1) 付与のある行だけの update op は通る(拒否側だけを測らない)", async () => {
    const response = await post(`/api/apps/${APP_ID}/batch`, member.cookie, {
      ops: [
        {
          op: "update",
          table: "books",
          target: granted,
          values: { state: "通る" },
          if_match: await version(granted),
        },
      ],
    });
    expect(response.status).toBe(200);
    const state = withDb(
      (db) =>
        (db.query("SELECT state FROM books WHERE _id = ?").get(granted) as { state: string }).state,
    );
    expect(state).toBe("通る");
  });

  test("(E-2) 付与の無い行を混ぜると 404 になり、1行も書かれない(部分適用ゼロ)", async () => {
    const response = await post(`/api/apps/${APP_ID}/batch`, member.cookie, {
      ops: [
        {
          op: "update",
          table: "books",
          target: granted,
          values: { state: "混ぜた" },
          if_match: await version(granted),
        },
        {
          op: "update",
          table: "books",
          target: ungranted,
          values: { state: "混ぜた" },
          if_match: await version(ungranted),
        },
      ],
    });
    expect(response.status).toBe(404);
    const states = withDb(
      (db) =>
        db.query("SELECT _id, state FROM books ORDER BY _id").all() as {
          _id: string;
          state: string | null;
        }[],
    );
    expect(states.every((row) => row.state === null)).toBe(true);
  });

  test("(E-3) 見えるが書けない行(read だけ)の update op は 403", async () => {
    withDb((db) => {
      const grant = createRecord(db, manifest(), "book_grant", {
        book: ungranted,
        member: memberRowId,
        permission: "reader",
      });
      expect(grant.ok).toBe(true);
    });
    const response = await post(`/api/apps/${APP_ID}/batch`, member.cookie, {
      ops: [
        {
          op: "update",
          table: "books",
          target: ungranted,
          values: { state: "書けない" },
          if_match: await version(ungranted),
        },
      ],
    });
    expect(response.status).toBe(403);
  });

  test("(E-4) バッチの create op も、メンバー表に行が無い人は 400 で止まる", async () => {
    const response = await post(`/api/apps/${APP_ID}/batch`, stranger.cookie, {
      ops: [{ op: "create", table: "books", values: { title: "バッチで作る" } }],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: { message: string }[] };
    // **【`V8-M41` / 台帳 `F-G12`。2026-08-13。期待値を入れ替えた。旧の1行を逐語で残す】**
    //
    // **旧: `expect(body.errors[0]?.message).toBe(`**
    // **  `"あなたはこのアプリのメンバー表に登録されていないため、この表に行を作れません。",`**
    // **`);`**
    //
    // **まとめ書込は HTTP の単件と**同じ1本の関数**を通るので、片方だけを直すことはできない**
    // (`src/server/app.ts` の `notAMemberError`)。 **両方が同時に変わった。**
    expect(body.errors[0]?.message).toBe(
      "この表に行を作れるのは、このアプリの利用者の表に登録されている人だけです。あなたはまだ登録されていません。",
    );
  });

  test("(E-5) バッチの create op が通ったら、作成者への付与も1件入る", async () => {
    const response = await post(`/api/apps/${APP_ID}/batch`, member.cookie, {
      ops: [{ op: "create", table: "books", values: { title: "バッチで作れる" } }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[] };
    const grants = withDb(
      (db) =>
        db
          .query("SELECT permission FROM book_grant WHERE book = ?")
          .all(body.records[0]?._id ?? "") as { permission: string }[],
    );
    expect(grants).toEqual([{ permission: "keeper" }]);
  });

  test("(E-6) 宣言していない表へのバッチは今日と1バイトも変わらない", async () => {
    const response = await post(`/api/apps/${APP_ID}/batch`, stranger.cookie, {
      ops: [{ op: "create", table: "notes", values: { body: "素通り" } }],
    });
    expect(response.status).toBe(200);
  });
});

describe("V7-M3-T02 (F): 画面の操作起点 —— 付与の無い行では起こせない", () => {
  test("(F-1) 付与の無い行に対する操作は 404(存在を伏せる)", async () => {
    const response = await post(
      `/api/apps/${APP_ID}/views/book-list/actions/run?workflow=stamp&record=${ungranted}`,
      member.cookie,
      {},
    );
    expect(response.status).toBe(404);
  });

  test("(F-2) 付与のある行では通る(拒否側だけを測らない)", async () => {
    const response = await post(
      `/api/apps/${APP_ID}/views/book-list/actions/run?workflow=stamp&record=${granted}`,
      member.cookie,
      {},
    );
    expect(response.status).toBe(200);
  });

  test("(F-3) 読めるが書けない人(read だけ)の操作は 403", async () => {
    withDb((db) => {
      const grant = createRecord(db, manifest(), "book_grant", {
        book: ungranted,
        member: memberRowId,
        permission: "reader",
      });
      expect(grant.ok).toBe(true);
    });
    const response = await post(
      `/api/apps/${APP_ID}/views/book-list/actions/run?workflow=stamp&record=${ungranted}`,
      member.cookie,
      {},
    );
    expect(response.status).toBe(403);
  });
});

describe("V7-M3-T02 (G): V7-M2-T03 が開いた側を塞いだことの実測", () => {
  test("(G-1) 宣言された利用者の種類の POST は、メンバー表に行が無ければ 400 で止まる", async () => {
    // **`V7-M2-T03` で `nonAdminTableAccess` が `\"scoped\"` を返すようになった結果、
    //   中継層の 403 が消えて `201` になっていた。** **本タスクの `POST` 配線が引き取る。**
    const patient = seedSession(dataRoot, APP_ID, { role: "customer", username: "patient" });
    const response = await post(`/api/apps/${APP_ID}/tables/books/records`, patient.cookie, {
      title: "種類の人が作る",
    });
    expect(response.status).toBe(400);
  });

  test("(G-2) メンバー表に行を入れれば、同じ人が 201 で作れて付与も入る", async () => {
    const patient = seedSession(dataRoot, APP_ID, { role: "customer", username: "patient2" });
    const row = withDb((db) => {
      const created = createRecord(db, manifest(), "book_member", { account: patient.userId });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    });
    const response = await post(`/api/apps/${APP_ID}/tables/books/records`, patient.cookie, {
      title: "種類の人が作れる",
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { record: { _id: string } };
    const grants = withDb(
      (db) =>
        db
          .query("SELECT member, permission FROM book_grant WHERE book = ?")
          .all(created.record._id) as { member: string; permission: string }[],
    );
    expect(grants).toEqual([{ member: row, permission: "keeper" }]);
  });
});
