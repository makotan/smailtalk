/**
 * **登録をきっかけに動く処理(ワークフロー)とコードの島に、アクセス権の判定を配線した
 * ことの検査**(`V8-M21`。台帳 `J-G22a` / `J-G23` の限定採用 / ユーザ決定 `D-V8-18` /
 * メインの裁定 `R-8`)。
 *
 * ## 台帳の限定の逐語(**これが仕様である**)
 *
 * - **`J-G22a`**: 「`src/kernel/workflow-runner.ts` の書込アクション直前1箇所。判定の家は
 *   同上(`:59` で既に import 済み)。**主体は今日の1本の規則(この人として動くの宣言が
 *   あればそれ、無ければきっかけを作った人)をそのまま使う**」
 * - **`J-G23`**: 「`src/kernel/workflow-runner.ts:1614` と同じ1箇所(**島の外側**)。判定の家は
 *   同上。**島の中には判定を1バイトも出さない**。**時刻起動から起きた島は素通りのまま残る**」
 *
 * ## **素通りする経路は2本である**(**【禁止】「全部の入口に効く」と書かない**)
 *
 * - **AI(MCP)**(`D-V8-20`)—— **本ファイルは1件も測っていない。**
 * - **決まった時刻に動く処理**(`D-V8-33` / `J-G22b` = 保留 / `docs/plan/undecided.md` の `U-3`)
 *   —— **下の (S) が「素通りすること」を実測で固定する。** **塞いでいないことの記録である。**
 *
 * ## **【`V17-M2-T03a` による追記(2026-09-07)。上の節を1バイトも消していない】**
 *
 * **下に (AC-G7a) 群を足した**(`ADR-0411` / ユーザ決定 `D-V16-4` の逐語
 * 「**全部の入口に立てる**」)。 **測るのは「引き継ぎ元(`inherit_from`)を宣言した表に
 * 行を**作る**とき、元になる行に書ける人だけが作れる」ことであり、
 * 自動処理の `create_record` / 島の `write_ops` の `create` op / `output_table` の
 * 全置換の3つに掛かる。**
 *
 * **【この追記が変えないこと。丸めない】**
 *  - **上の「素通りする経路は2本である」のうち、**決まった時刻に動く処理**は今日も素通りで
 *    ある**(`(AC-G7a-13)` が親の関門についても素通りを実測で固定する)。
 *  - **更新には1バイトも掛かっていない**(`ADR-0411` 限定4)—— **島の `update` op は
 *    親を別の親へ書き換えられる**(`(AC-G7a-12)`)。 **島の `write_back` は今日も
 *    `judgeAutomationWrite` を1度も通らない。**
 *  - **`delete` op にも掛かっていない**(`(AC-G7a-11)`)。
 *
 * ## **先に認めること(隠さない。裁定 `R-8` / `04` §7-5 (F) の逐語)**
 *
 * **「判定を掛けると、今日動いているアプリの島が落ちる」。** **落ちるのは
 * 行ごとのアクセス権を宣言した表へ書く自動処理・島だけである** —— **宣言していない表への
 * 書込は1ミリも変わらない**(下の (P) が固定する)。
 *
 * ## **この検査が測っていないもの(誇張しない)**
 *
 * - **【`V8-M21` の後半で偽になった。旧文を1バイトも消していない】** 旧の逐語:
 *   > **面(役割に束ねた権限。`app.roles[].rules`)をこの3経路に1バイトも掛けていない** ——
 *   > **カーネルは実効ロール集合を解決する手段を持たない**(`_auth_users` を読む口が
 *   > `src/auth/store.ts` にしかなく、判定の家 `src/server/owner-scope.ts` は
 *   > `web/test/shell-navigation-boundary.test.ts` が1バイト単位で凍結している)。
 *   > **したがって `V8-M20` の記録 §9 の 9「面は受信口・ワークフロー・コードの島・`DELETE` を
 *   > 1つも止めない」は、面については今日も真である。** **止まるようになったのは点(行ごとの
 *   > 付与)の側だけである。**
 *
 *   **後半が `effectiveRolesOnDb`(`src/auth/store.ts` の既存の同居関数)を足し、
 *   面と点を `OR` で重ねる既存1本(`combineRoleAndCreatorGrant` /
 *   `resolveCombinedRecordAccess`)ごと掛けた。** **下の (F) 群がそれを測る。**
 *   **`DELETE` の経路には今日も1バイトも掛かっていない**(本ファイルの担当は3経路である)。
 * - **削除の自動処理は語彙に無い**(`action` の enum は5値で `delete_record` を持たない)。
 *   **実際に削除が起きるのは `run_function` の `output_table` 全置換の前段だけであり、
 *   そこは下の (O) が扱う。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  listRecords,
  type Manifest,
} from "../kernel/index.ts";
import { ensureIslandRuntimeReady } from "../kernel/island-runner.ts";
import { runScheduledWorkflow } from "../kernel/workflow-runner.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "auto-guard";

/**
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】面の規則を足さない表の一覧。**
 *
 * **既定が「閉じる」側へ倒れたので、規則を1本も名指ししていない表は面が拒否する。**
 * **ここに挙げた表は「面を閉じたまま」測る側である** —— **足すと本ファイルの主題
 * (点 = 行ごとの付与 / 面だけの表 / 読取1本だけの表)が丸ごと測れなくなる。**
 *
 * **面が閉じても点の測定は生きている** —— **`CLOSED_ROLE_ACCESS` は `governed: true` で
 * 返るので、`combineRoleAndGrantAccess` は「両方が管轄内 = `OR`」の枝に入り、
 * 点が通せば今日どおり通る**(`(ii-b)` / `(ii-f)` / `(O-b)` が実測している)。
 *
 * **`open_notes` はここに入れない** —— **`(P)` の主題は「点(`access_control`)は
 * オプトインである」ことであり、面まで閉じるとその測定が面の 403 に隠れる。**
 */
const FACE_CLOSED_TABLES = [
  // 点(行ごとの付与)を宣言した表 —— (ii) / (iii) / (O) の主題。
  "notes",
  "sums",
  // 面だけを宣言した表 —— (F-1) / (F-2) / (F-3) の主題(規則は題材が自分で書いている)。
  "role_notes",
  // 面と点の両方を宣言した表 —— (F-4) の主題。
  "both_notes",
  // 読取だけを1本書いた表 —— (F-7) の主題。
  "readonly_notes",
  // **【`V17-M2-T03a`(`AC-G7a` / `ADR-0411`)】親の関門の題材 —— (AC-G7a) 群の主題。**
  // **面から名指しすると面と点が `OR` で重なり、親の関門ごと無効になる。**
  "parents",
  "kids",
  "okids",
  // **【`V17-M3-T01a`】個人所有の表 —— (AC-G12) 群の主題。**
  // **既定の規則(条件なしの `write`)を足すと、面と点が `OR` で重なって
  // 書き手が自分で書いた条件が丸ごと無効になる**(記憶 `face-or-point-no-read-face`)。
  "own_notes",
  "stock_notes",
  // **【`V17-M3-T04a`】ボタン起動の `act_as` の参照先 —— (AC-G14) 群の主題。**
  // **条件なしの規則を1本でも足すと、`judgeRoleAccess` が「管轄内かつ許可」を返し、
  // 単件 `GET` が個人所有の壁を**越えて** 200 になる**(`roleReadCrossesOwnerScope`)。
  // **その状態では「押した人から単件 `GET` が 404 になる行」を1件も作れない。**
  // **代わりに、差分適用が自動で補う条件つきの規則を `roles` の側で1本だけ宣言する。**
  "am_agents",
  // **【`V17-M3-T02a`】書き戻し先のきっかけの表 —— (AC-G13) 群の主題。**
  // **読取だけを個人所有に絞り、書込は開けてある表である**(規則は `roles` に2本書いた)。
  // **この形でなければ「読めない相手が書き戻せる」を1件も再現できない** ——
  // 読取まで開けると単件 `GET` が 200 になり、絞ると面が書込ごと先に止める。
  "wb_src",
] as const;

const PERMISSIONS = [
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

/** きっかけの表(すべて個人所有 = `st_owner` を持つ)。 */
function triggerTable(id: string, extra: Record<string, unknown>[] = []) {
  return {
    id,
    name: id,
    fields: [
      { id: "title", name: "件名", type: "text" },
      { id: "st_owner", name: "所有者", type: "text" },
      ...extra,
    ],
  };
}

const NOTE_REF = { id: "note", name: "メモ", type: "reference", reference_table: "notes" };
const AGENT_REF = { id: "agent", name: "代理", type: "reference", reference_table: "agents" };
/** **【`V17-M2-T03a`】親を指すきっかけの項目**(`AC-G7a` の題材)。 */
const PARENT_REF = {
  id: "parent",
  name: "元になる行",
  type: "reference",
  reference_table: "parents",
};
/** **【`V17-M2-T03a`】島に「どの行を更新/削除するか」を渡すためのきっかけの項目。** */
const TARGET_REF = { id: "target", name: "対象", type: "text" };
/** **【`V17-M3-T01a`】個人所有の表の行を指すきっかけの項目**(`AC-G12` の題材)。 */
const OWN_NOTE_REF = {
  id: "note",
  name: "個人所有のメモ",
  type: "reference",
  reference_table: "own_notes",
};
/** **【`V17-M3-T01a`】陰性対照の表の行を指すきっかけの項目。** */
const STOCK_NOTE_REF = {
  id: "snote",
  name: "出荷時のメモ",
  type: "reference",
  reference_table: "stock_notes",
};

/** **【`V17-M2-T03a`】島の `update` op は版一致(`if_match`)が必須なので、版も渡す。** */
const VERSION_REF = { id: "version", name: "版", type: "text" };

/** **【`V17-M3-T02a`】書き戻し(`write_back`)が書き換える本文の項目**(`AC-G13` の題材)。 */
const WB_BODY = { id: "body", name: "本文", type: "text" };
/** **【`V17-M3-T02a`】書き戻しが持ち主を**誰に**付け替えようとするかを島へ渡す項目。** */
const WB_GIVE = { id: "give_to", name: "譲る相手", type: "text" };
/**
 * **【`V17-M3-T04a`】ボタン起動の `act_as` が指す参照の項目**(`AC-G14` の題材)。
 *
 * **項目の id を `agent` と分けている** —— **`resolveWorkflowActor` は
 * `manifest.app.tables` 全体から「その id の項目を持つ**最初の表**」を探すので、
 * id を共有すると、どの表の参照先を辿ったのかが題材から読めなくなる。**
 */
const AM_AGENT_REF = {
  id: "aagent",
  name: "代理(出荷時の宣言のまま)",
  type: "reference",
  reference_table: "am_agents",
};

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "自動処理の門",
      tables: [
        // --- 書込先(行ごとのアクセス権を宣言した表)-------------------------------
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "note_grant",
              target: "note",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "note_grant",
          name: "メモの付与",
          fields: [
            { id: "note", name: "行", type: "reference", reference_table: "notes" },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        {
          id: "note_member",
          name: "参加者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        // --- 宣言していない書込先(オプトインの対照)-------------------------------
        {
          id: "open_notes",
          name: "素のメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        // --- **面だけ**を宣言した書込先(`V8-M21` の後半。行ごとの付与は1つも無い)------
        // **`app.roles` に「役割 `editor` × 表 `role_notes` × 書込」を書く**(下の `roles`)。
        // **点(行ごとのアクセス権)は宣言していない** —— **面だけで止まる/通ることを測る。**
        {
          id: "role_notes",
          name: "役割で守るメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        // --- **読取だけ**を宣言した書込先(`V8-M21` の後半。**代償を測るための台**)-------
        // **`app.roles` に「役割 `owner` × 表 `readonly_notes` × **読取**」を1本書くだけの表。**
        // **書込の規則は誰にも1本も書いていない。**
        {
          id: "readonly_notes",
          name: "読むとだけ書いたメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        // --- **面と点の両方**を宣言した書込先(`OR` を測る)---------------------------
        {
          id: "both_notes",
          name: "両方で守るメモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "both_grant",
              target: "note",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "both_grant",
          name: "両方で守るメモの付与",
          fields: [
            { id: "note", name: "行", type: "reference", reference_table: "both_notes" },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        // --- `output_table` 全置換の出力先(宣言した表)-----------------------------
        {
          id: "sums",
          name: "集計",
          fields: [{ id: "value", name: "値", type: "number" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "sum_grant",
              target: "sum",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "sum_grant",
          name: "集計の付与",
          fields: [
            { id: "sum", name: "行", type: "reference", reference_table: "sums" },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        // --- **【`V17-M2-T03a`】親の関門の題材**(`AC-G7a` / `ADR-0411`)------------------
        // **`parents` は親。`kids` は「親の行に書ける人だけが作れる」と宣言した子。**
        // **`okids` は同じ宣言を持つ島の出力先(`output_table` の全置換の相手)。**
        {
          id: "parents",
          name: "元になる行",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "kid_grant",
              target: "parent",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "kids",
          name: "元になる行を持つメモ",
          fields: [{ id: "body", name: "本文", type: "text" }, { ...PARENT_REF }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "kid_grant",
              target: "kid",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
        {
          id: "okids",
          name: "元になる行を持つ集計",
          fields: [{ id: "value", name: "値", type: "number" }, { ...PARENT_REF }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "kid_grant",
              target: "okid",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
        {
          id: "kid_grant",
          name: "元になる行の付与",
          fields: [
            { id: "parent", name: "元になる行", type: "reference", reference_table: "parents" },
            { id: "kid", name: "メモ", type: "reference", reference_table: "kids" },
            { id: "okid", name: "集計", type: "reference", reference_table: "okids" },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["keeper"] },
          ],
        },
        // --- 代理(`act_as` の1ホップ先)-------------------------------------------
        {
          id: "agents",
          name: "代理",
          fields: [
            { id: "label", name: "名前", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        // --- きっかけの表 -----------------------------------------------------------
        triggerTable("orders"),
        triggerTable("actas_orders", [AGENT_REF]),
        triggerTable("open_orders"),
        triggerTable("edits", [NOTE_REF]),
        triggerTable("actas_edits", [NOTE_REF, AGENT_REF]),
        triggerTable("isl"),
        triggerTable("actas_isl", [AGENT_REF]),
        triggerTable("sum_src"),
        triggerTable("sched_src"),
        // --- 面の検査で使うきっかけの表(`V8-M21` の後半)-----------------------------
        triggerTable("role_src"),
        triggerTable("role_isl"),
        triggerTable("both_src"),
        triggerTable("ro_src"),
        triggerTable("ro_isl"),
        // --- **【`V17-M2-T03a`】親の関門のきっかけの表**(`AC-G7a`)-----------------------
        triggerTable("kid_src", [PARENT_REF]),
        triggerTable("kid_isl", [PARENT_REF]),
        triggerTable("kid_del_isl", [TARGET_REF]),
        triggerTable("kid_upd_isl", [TARGET_REF, PARENT_REF, VERSION_REF]),
        triggerTable("okid_src", [PARENT_REF]),
        triggerTable("kid_sched_src", [PARENT_REF]),
        // --- **【`V17-M3-T01a`】個人所有(`st_owner`)の表**(`AC-G12` の題材)--------------
        // **`own_notes` は、アプリの書き手が**自分で**条件つきの `write` を書いた表である**
        // (下の `roles` の `owner`)。 **条件は `st_owner` と1バイトも関係しない。**
        // **`stock_notes` は、差分適用が自動で補う条件(持ち主 or 空)をそのまま持つ表である**
        // (陰性対照。**着手前も着手後も止まる側**)。
        {
          id: "own_notes",
          name: "個人所有のメモ",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "stock_notes",
          name: "個人所有のメモ(出荷時の宣言のまま)",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        triggerTable("own_src", [OWN_NOTE_REF, STOCK_NOTE_REF]),
        // --- **【`V17-M3-T02a`】書き戻し(`write_back`)の題材**(`AC-G13`)---------------
        // **書き戻し先は「きっかけの表そのもの」である**(`writeBackToTriggerRecord`)——
        // **したがって3表とも個人所有(`st_owner`)を持つきっかけの表であり、
        // 面(役割の規則)は既定の条件なしの規則が入る側に置く** ——
        // **止めるのが面ではなく個人所有の判定であることを、題材の側で切り分けるためである。**
        triggerTable("wb_src", [WB_BODY, AGENT_REF]),
        triggerTable("wb_own", [WB_BODY]),
        triggerTable("wb_give", [WB_GIVE]),
        // --- **【`V17-M3-T04a`】ボタン起動の `act_as` の題材**(`AC-G14`)-----------------
        // **`am_agents` は「差分適用が自動で補う条件」だけを面に持つ表である**
        // (`apply-diff.ts` が `st_owner` を持つ表の規則へ必ず入れる `when` そのもの)。
        // **その形のときだけ、単件 `GET` が他人の行に 404 を返す。**
        {
          id: "am_agents",
          name: "代理(出荷時の宣言のまま)",
          fields: [
            { id: "label", name: "名前", type: "text" },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        triggerTable("am_src", [AM_AGENT_REF]),
        // **【`V17-M3-T04a`】4つ目の形 —— 参照先が「条件なしの読取の規則」を持つ表**
        // (`agents`。既定の規則がそのまま入っている)。 **この形では、面が個人所有の壁を
        // **越えて** 単件 `GET` が 200 になる。** **判定もそれに合わせて通す側でなければ、
        // 単件 `GET` の答えと食い違う。**
        triggerTable("am_open", [AGENT_REF]),
        {
          id: "wf_log",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "起点", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "詳細", type: "long_text" },
          ],
        },
      ],
      views: [
        { id: "note-list", type: "list_view", table: "notes", columns: ["body"] },
        // **【`V17-M3-T01a`】ボタン起動(`manual`)の入口**(`AC-G12` の題材)。
        {
          id: "own-list",
          type: "list_view",
          table: "own_src",
          columns: ["title"],
          actions: [
            { run: "own_takeover", name: "他人の行を書き換える" },
            { run: "stock_takeover", name: "出荷時の宣言のまま書き換える" },
          ],
        },
        // **【`V17-M3-T04a`】`act_as` を宣言したボタン起動の入口**(`AC-G14` の題材)。
        {
          id: "am-list",
          type: "list_view",
          table: "am_src",
          columns: ["title"],
          actions: [{ run: "am_takeover", name: "代理として2件作る" }],
        },
        {
          id: "am-open-list",
          type: "list_view",
          table: "am_open",
          columns: ["title"],
          actions: [{ run: "am_open_takeover", name: "条件なしの読取を持つ代理で作る" }],
        },
      ],
      // --- **面(役割に束ねた権限)の宣言**(`V8-M21` の後半)--------------------------
      // **既定3ロール(`owner` / `editor` / `viewer`)は消せない。**
      // **規則を書いたのは `editor` だけである** —— **規則が対象を名指しした時点で
      // その対象は allow-list になるので、`owner` はこの2表に書けなくなる。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          // **【`V8-M21` の後半】読取だけを書いた規則1本**(下の (F-7) の台)。
          rules: [
            { target: "table", table: "readonly_notes", can: ["read"] },
            // **【`V17-M3-T01a`】アプリの書き手が**自分で**書いた条件つきの `write`**
            // (`AC-G12` の題材)。 **`st_owner` と1バイトも関係しない条件である** ——
            // **差分適用が補う条件(持ち主 or 空)に**書き換えられない**形。**
            {
              target: "table",
              table: "own_notes",
              can: ["write"],
              when: { field: "title", equals: "のっとり対象" },
            },
            // **【`V17-M3-T01a`】陰性対照 —— 差分適用が自動で補う条件そのもの。**
            {
              target: "table",
              table: "stock_notes",
              can: ["read", "write", "delete"],
              when: {
                or: [
                  { field: "st_owner", equals_current_user: true },
                  { field: "st_owner", is_empty: true },
                ],
              },
            },
            // **【`V17-M3-T02a`】書き戻し先のきっかけの表 —— 動詞ごとに別の規則を書く。**
            // **書込は条件なしで開ける** —— **面と点の判定(`judgeAutomationWrite`)を
            // 通す側である。** **止めるのは個人所有の判定だけだと切り分けるためである。**
            { target: "table", table: "wb_src", can: ["write"] },
            // **読取と削除だけを個人所有に絞る** —— **これで他人の行への単件 `GET` が
            // 404 になる**(面が個人所有の壁を越えない)。
            {
              target: "table",
              table: "wb_src",
              can: ["read", "delete"],
              when: {
                or: [
                  { field: "st_owner", equals_current_user: true },
                  { field: "st_owner", is_empty: true },
                ],
              },
            },
            // **【`V17-M3-T04a`】`act_as` の参照先 —— 差分適用が補う条件そのもの。**
            // **この形のときだけ、他人の行への単件 `GET` が 404 になる**
            // (条件なしの規則を1本足すと、面が個人所有の壁を越えて 200 になる)。
            {
              target: "table",
              table: "am_agents",
              can: ["read", "write", "delete"],
              when: {
                or: [
                  { field: "st_owner", equals_current_user: true },
                  { field: "st_owner", is_empty: true },
                ],
              },
            },
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [
            { target: "table", table: "role_notes", can: ["write"] },
            { target: "table", table: "both_notes", can: ["write"] },
          ],
        },
        { id: "viewer", name: "閲覧者" },
      ],
      functions: [
        {
          id: "island_write",
          name: "島が書く",
          code: 'export default function () { return [{ op: "create", table: "notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "island_open_write",
          name: "島が宣言していない表へ書く",
          code: 'export default function () { return [{ op: "create", table: "open_notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "island_role_write",
          name: "島が面だけの表へ書く",
          code: 'export default function () { return [{ op: "create", table: "role_notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "island_readonly_write",
          name: "島が読取だけ宣言した表へ書く",
          code: 'export default function () { return [{ op: "create", table: "readonly_notes", values: { body: "島から" } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "sum_rows",
          name: "集計を作る",
          code: "export default function () { return [{ value: 42 }]; }",
          input: { source: "record" },
          output: { fields: [{ id: "value", type: "number" }] },
        },
        // --- **【`V17-M2-T03a`】親の関門の題材**(`AC-G7a`)------------------------------
        {
          id: "island_kid_write",
          name: "島が元になる行を持つ表へ作る",
          code: 'export default function (record) { return [{ op: "create", table: "kids", values: { body: "島から", parent: record.parent } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          // **陰性対照。** **`delete` op も `judgeAutomationWrite` の**作成の枝**へ落ちる**
          // (`workflow-runner.ts` は `op.op !== "update"` なら対象行を渡さない)——
          // **関門が「作る」以外で1度も発火しないことを、**実行で**撃つための島である。**
          id: "island_kid_delete",
          name: "島が元になる行を持つ表から消す",
          code: 'export default function (record) { return [{ op: "delete", table: "kids", target: record.target }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          // **陰性対照。** **`update` op は関門の射程外である**(`ADR-0411` 限定4)——
          // **親を**別の親へ書き換える** op でも、今日は1度も問われない。**
          id: "island_kid_update",
          name: "島が元になる行を持つ表を書き換える",
          code: 'export default function (record) { return [{ op: "update", table: "kids", target: record.target, if_match: record.version, values: { parent: record.parent } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          // --- **【`V17-M3-T02a`】書き戻しの島**(`AC-G13`)------------------------------
          id: "wb_body",
          name: "島がトリガー元の本文を書き戻す",
          code: 'export default function () { return [{ body: "島が書き戻した" }]; }',
          input: { source: "record" },
          output: { fields: [{ id: "body", type: "text" }] },
        },
        {
          // **持ち主の列は `table.fields` に在る普通の項目なので、書き戻し先の
          // 実在チェック(`writeBackToTriggerRecord` の 3.)を素通りする。**
          id: "wb_owner",
          name: "島がトリガー元の持ち主を書き戻す",
          code: "export default function (record) { return [{ st_owner: record.give_to }]; }",
          input: { source: "record" },
          output: { fields: [{ id: "st_owner", type: "text" }] },
        },
        {
          id: "okid_rows",
          name: "元になる行を持つ集計を作る",
          code: "export default function (record) { return [{ value: 42, parent: record.parent }]; }",
          input: { source: "record" },
          output: {
            fields: [
              { id: "value", type: "number" },
              { id: "parent", type: "reference" },
            ],
          },
        },
      ],
      workflows: [
        {
          id: "wf_create",
          name: "登録で作る",
          trigger: { type: "on_create", table: "orders" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { body: "$record.title" } }],
        },
        {
          id: "wf_create_actas",
          name: "登録で作る(代理)",
          trigger: { type: "on_create", table: "actas_orders" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { body: "$record.title" } }],
        },
        {
          id: "wf_create_open",
          name: "宣言していない表へ作る",
          trigger: { type: "on_create", table: "open_orders" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "open_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_update",
          name: "更新で書き換える",
          trigger: { type: "on_update", table: "edits" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "notes",
              target: "$record.note",
              values: { body: "自動処理が書き換えた" },
            },
          ],
        },
        {
          id: "wf_update_actas",
          name: "更新で書き換える(代理)",
          trigger: { type: "on_update", table: "actas_edits" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "notes",
              target: "$record.note",
              values: { body: "代理が書き換えた" },
            },
          ],
        },
        {
          id: "wf_island",
          name: "島が書く",
          trigger: { type: "on_create", table: "isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_write", write_ops: true }],
        },
        {
          id: "wf_island_actas",
          name: "島が書く(代理)",
          trigger: { type: "on_create", table: "actas_isl" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_write", write_ops: true }],
        },
        {
          id: "wf_output",
          name: "集計を作り直す",
          trigger: { type: "on_create", table: "sum_src" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "sum_rows", output_table: "sums" }],
        },
        // --- 面の検査で使うワークフロー(`V8-M21` の後半)-----------------------------
        {
          id: "wf_role_create",
          name: "面だけの表へ作る",
          trigger: { type: "on_create", table: "role_src" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "role_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_role_island",
          name: "島が面だけの表へ書く",
          trigger: { type: "on_create", table: "role_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_role_write", write_ops: true }],
        },
        {
          id: "wf_both_create",
          name: "面と点の両方を宣言した表へ作る",
          trigger: { type: "on_create", table: "both_src" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "both_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_ro_create",
          name: "読取だけ宣言した表へ作る",
          trigger: { type: "on_create", table: "ro_src" },
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "readonly_notes", values: { body: "$record.title" } },
          ],
        },
        {
          id: "wf_ro_island",
          name: "島が読取だけ宣言した表へ書く",
          trigger: { type: "on_create", table: "ro_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_readonly_write", write_ops: true }],
        },
        // --- **【`V17-M2-T03a`】親の関門のワークフロー**(`AC-G7a`)-----------------------
        {
          id: "wf_kid_create",
          name: "元になる行を持つ表へ作る",
          trigger: { type: "on_create", table: "kid_src" },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "kids",
              values: { body: "$record.title", parent: "$record.parent" },
            },
          ],
        },
        {
          id: "wf_kid_island",
          name: "島が元になる行を持つ表へ作る",
          trigger: { type: "on_create", table: "kid_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_kid_write", write_ops: true }],
        },
        {
          id: "wf_kid_delete_island",
          name: "島が元になる行を持つ表から消す",
          trigger: { type: "on_create", table: "kid_del_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_kid_delete", write_ops: true }],
        },
        {
          id: "wf_kid_update_island",
          name: "島が元になる行を持つ表を書き換える",
          trigger: { type: "on_create", table: "kid_upd_isl" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "island_kid_update", write_ops: true }],
        },
        {
          id: "wf_okid_output",
          name: "元になる行を持つ集計を作り直す",
          trigger: { type: "on_create", table: "okid_src" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "okid_rows", output_table: "okids" }],
        },
        {
          id: "wf_kid_sched",
          name: "時刻で元になる行を持つ表へ作る",
          trigger: { type: "schedule", at: { hour: 4, minute: 0 }, table: "kid_sched_src" },
          history_table: "wf_log",
          actions: [
            {
              action: "create_record",
              table: "kids",
              values: { body: "時刻起動から", parent: "$record.parent" },
            },
          ],
        },
        // --- **【`V17-M3-T01a`】ボタン起動が他人の行を書き換える題材**(`AC-G12`)------------
        {
          id: "own_takeover",
          name: "他人の行を書き換える",
          trigger: { type: "manual", table: "own_src" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "own_notes",
              target: "$record.note",
              values: { title: "のっとり後" },
            },
          ],
        },
        {
          id: "stock_takeover",
          name: "出荷時の宣言のまま書き換える",
          trigger: { type: "manual", table: "own_src" },
          history_table: "wf_log",
          actions: [
            {
              action: "update_record",
              table: "stock_notes",
              target: "$record.snote",
              values: { title: "のっとり後" },
            },
          ],
        },
        // --- **【`V17-M3-T02a`】書き戻し(`write_back`)の題材**(`AC-G13`)---------------
        {
          // **書き手を「行の持ち主ではない別人」にするために `act_as` を宣言する。**
          // **`on_update` を使うのは、ボタン起動の入口が「押した人に見えない行は 404」を
          // 既に返すため**(`app.ts` の操作起点の関門)——**押した人 = 行の持ち主に固定される。**
          id: "wb_actas",
          name: "書き戻し(代理)",
          trigger: { type: "on_update", table: "wb_src" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "wb_body", write_back: "$record" }],
        },
        {
          id: "wb_self",
          name: "書き戻し(自分の行)",
          trigger: { type: "on_update", table: "wb_own" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "wb_body", write_back: "$record" }],
        },
        {
          id: "wb_giveaway",
          name: "書き戻しで持ち主を付け替える",
          trigger: { type: "on_update", table: "wb_give" },
          history_table: "wf_log",
          actions: [{ action: "run_function", function: "wb_owner", write_back: "$record" }],
        },
        // --- **【`V17-M3-T04a`】ボタン起動の `act_as`**(`AC-G14`)-----------------------
        {
          // **アクションを2本持つ** —— **「1本目が書いてから2本目で落ちた」形を排除して
          // 「1行も書かずに失敗する」を測るためである**(`runActions` は前が失敗しても
          // 後続を実行し、各 `runAction` はその場で書く)。
          id: "am_takeover",
          name: "代理として2件作る",
          trigger: { type: "manual", table: "am_src" },
          act_as: "$record.aagent",
          history_table: "wf_log",
          actions: [
            { action: "create_record", table: "notes", values: { body: "1本目" } },
            { action: "create_record", table: "notes", values: { body: "2本目" } },
          ],
        },
        {
          // **参照先が「条件なしの読取の規則」を持つ表**(`agents`)を指す形。
          id: "am_open_takeover",
          name: "条件なしの読取を持つ代理として作る",
          trigger: { type: "manual", table: "am_open" },
          act_as: "$record.agent",
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { body: "1本目" } }],
        },
        {
          id: "wf_sched",
          name: "時刻で作る",
          trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "sched_src" },
          history_table: "wf_log",
          actions: [{ action: "create_record", table: "notes", values: { body: "時刻起動から" } }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/** メンバー表に行を持たない相手。 */
let stranger: ReturnType<typeof seedSession>;
/** メンバー表に行を持つ相手。 */
let member: ReturnType<typeof seedSession>;
/** `member` のメンバー行 `_id`(付与の相手として使う)。 */
let memberRowId: string;
/**
 * **面(役割の規則)の側だけで通る相手**(`V8-M21` の後半)。
 * **役割は `editor`。メンバー表に行を1つも持たない** —— **点の側は何も持たない。**
 */
let editorOnly: ReturnType<typeof seedSession>;

beforeEach(async () => {
  await ensureIslandRuntimeReady();
  dataRoot = await mkdtemp(join(tmpdir(), "gp-auto-guard-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "自動処理の門", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **【`V8-M26`】きっかけの表・付与表・メンバー表・履歴表にだけ既定の規則を足す。**
  // **測る対象の表(`FACE_CLOSED_TABLES`)には1本も足さない。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(), { skipTables: FACE_CLOSED_TABLES }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
  stranger = seedSession(dataRoot, APP_ID, { role: "owner", username: "stranger" });
  member = seedSession(dataRoot, APP_ID, { role: "owner", username: "member" });
  memberRowId = String(kernelCreate("note_member", { account: member.userId })._id);
  editorOnly = seedSession(dataRoot, APP_ID, { role: "editor", username: "editor-only" });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** カーネルを直接呼んで1行作る(判定の外側で台を組むため)。 */
function kernelCreate(tableId: string, values: Record<string, unknown>): Record<string, unknown> {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const created = createRecord(db, manifest(), tableId, values);
    expect(created.ok, `${tableId} の作成に失敗した`).toBe(true);
    return created.ok ? (created.value as unknown as Record<string, unknown>) : {};
  } finally {
    db.close();
  }
}

function rows(tableId: string): Record<string, unknown>[] {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    const result = listRecords(db, manifest(), tableId, {});
    return result.ok ? (result.value as unknown as Record<string, unknown>[]) : [];
  } finally {
    db.close();
  }
}

/** 実行履歴の `status:error` を1本の文字列に畳む(どこで止まったかを文面で測る)。 */
function historyDetail(): string {
  return rows("wf_log")
    .map((row) => `${String(row.status)}:${String(row.error)}`)
    .join(" | ");
}

function post(
  session: ReturnType<typeof seedSession>,
  tableId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: TEST_ORIGIN,
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function patch(
  session: ReturnType<typeof seedSession>,
  tableId: string,
  recordId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const current = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`, {
      headers: { cookie: session.cookie },
    }),
  );
  const etag = current.headers.get("etag") ?? "";
  return await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: TEST_ORIGIN,
        "if-match": etag,
      },
      body: JSON.stringify(body),
    }),
  );
}

// =====================================================================================
// (ii) 登録をきっかけに動く処理 —— `create_record` / `update_record`
// =====================================================================================

test("(ii-a) 権限が無い相手の登録で動いた create_record は落ち、1行も書かれない", async () => {
  const res = await post(stranger, "orders", { title: "外の人" });
  // **発火元の書込ごと成立しない**(`ADR-0066`)—— きっかけの行も残らない。
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
  expect(rows("orders")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
});

test("(ii-b) 権限が在る相手の登録なら、同じ create_record が通る", async () => {
  const res = await post(member, "orders", { title: "中の人" });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["中の人"]);
});

test("(ii-c) act_as を宣言すると、判定の相手は代理先の持ち主になる(権限が在れば通る)", async () => {
  const agent = kernelCreate("agents", { label: "代理", st_owner: member.userId });
  // **押したのは権限の無い相手である。** それでも代理先が権限を持つので通る。
  const res = await post(stranger, "actas_orders", { title: "代理で", agent: String(agent._id) });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["代理で"]);
});

test("(ii-d) act_as の代理先に権限が無ければ落ちる(宣言しても素通りしない)", async () => {
  const agent = kernelCreate("agents", { label: "外の代理", st_owner: stranger.userId });
  const res = await post(member, "actas_orders", { title: "代理で", agent: String(agent._id) });
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
});

/*
 * **【`V17-M3-T11`(2026-09-07)。独立点検の指摘3 を打ち直して足した】**
 *
 * **`AC-G27a` の流入口は 7つではなく 8つだった** —— **判定の断り文に載る**書き手の ID** が、
 * そのまま履歴の `error` 列に入る。** **`act_as` を宣言した発火では、この ID は
 * 「参照先の行の `st_owner`」であり、履歴の読み手が1バイトも読めない行の値である**
 * (`b1` の再現が名指しした3値のうちの1つ)。
 *
 * **落としたのは履歴へ書くときだけである** —— **要求した本人への HTTP 400 の本文には
 * 今日どおり載る。** **下の2本の `expect` が、その非対称を両側から撃つ。**
 */
test("(AC-G27a-8) act_as で解けた書き手の ID は、履歴の error 列に載らない(応答には載る)", async () => {
  const agent = kernelCreate("agents", { label: "外の代理", st_owner: stranger.userId });
  const res = await post(member, "actas_orders", { title: "代理で", agent: String(agent._id) });
  expect(res.status).toBe(400);
  const body = await res.text();
  // **(1) 要求した本人への応答は1バイトも変えていない** —— ID がそのまま載る。
  expect(body).toContain(stranger.userId);
  expect(body).toContain("この自動処理の書き手");
  // **(2) 履歴には載らない。** **断り文そのものは今日どおり読める**(誰が止めたかは残る)。
  const history = historyDetail();
  expect(history).toContain("アクセス権");
  expect(history).toContain("この自動処理の書き手(履歴には残していません)");
  expect(history).not.toContain(stranger.userId);
  // **(3) 陰性対照 —— 押した本人(`member`)の ID も履歴に入っていない。**
  expect(history).not.toContain(member.userId);
});

test("(ii-e) update_record は、その行を書ける相手でなければ落ちる", async () => {
  const note = kernelCreate("notes", { body: "元の本文" });
  const edit = await post(stranger, "edits", { title: "編集", note: String(note._id) });
  expect(edit.status).toBe(201);
  const editId = String(((await edit.json()) as { record: { _id: string } }).record._id);
  const res = await patch(stranger, "edits", editId, { title: "編集2" });
  expect(res.status).toBe(400);
  expect(rows("notes").map((row) => row.body)).toEqual(["元の本文"]);
  expect(historyDetail()).toContain("アクセス権");
});

test("(ii-f) update_record は、その行への付与を持つ相手なら通る", async () => {
  const note = kernelCreate("notes", { body: "元の本文" });
  kernelCreate("note_grant", {
    note: String(note._id),
    member: memberRowId,
    permission: "keeper",
  });
  const edit = await post(member, "edits", { title: "編集", note: String(note._id) });
  const editId = String(((await edit.json()) as { record: { _id: string } }).record._id);
  const res = await patch(member, "edits", editId, { title: "編集2" });
  expect(res.status).toBe(200);
  expect(rows("notes").map((row) => row.body)).toEqual(["自動処理が書き換えた"]);
});

test("(ii-g) update_record の act_as —— 代理先が付与を持てば通る", async () => {
  const note = kernelCreate("notes", { body: "元の本文" });
  kernelCreate("note_grant", {
    note: String(note._id),
    member: memberRowId,
    permission: "keeper",
  });
  const agent = kernelCreate("agents", { label: "代理", st_owner: member.userId });
  const edit = await post(stranger, "actas_edits", {
    title: "編集",
    note: String(note._id),
    agent: String(agent._id),
  });
  const editId = String(((await edit.json()) as { record: { _id: string } }).record._id);
  const res = await patch(stranger, "actas_edits", editId, { title: "編集2" });
  expect(res.status).toBe(200);
  expect(rows("notes").map((row) => row.body)).toEqual(["代理が書き換えた"]);
});

// =====================================================================================
// (iii) コードの島(`write_ops`)—— **判定は島の外側**
// =====================================================================================

test("(iii-a) 権限が無い相手の発火で動いた島の書込は落ち、1行も書かれない", async () => {
  const res = await post(stranger, "isl", { title: "島" });
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
});

test("(iii-b) 権限が在る相手の発火なら、同じ島の書込が通る", async () => {
  const res = await post(member, "isl", { title: "島" });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["島から"]);
});

test("(iii-c) 島でも act_as が効く —— 代理先が権限を持てば通る", async () => {
  const agent = kernelCreate("agents", { label: "代理", st_owner: member.userId });
  const res = await post(stranger, "actas_isl", { title: "島", agent: String(agent._id) });
  expect(res.status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["島から"]);
});

test("(iii-d) 島の act_as の代理先に権限が無ければ落ちる", async () => {
  const agent = kernelCreate("agents", { label: "外の代理", st_owner: stranger.userId });
  const res = await post(member, "actas_isl", { title: "島", agent: String(agent._id) });
  expect(res.status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
});

test("(iii-e) 島の中に判定を1バイトも出していない(判定の綴りが関数の宣言に無い)", () => {
  // **【`V17-M3-T02a`】1本だけ走査から外す。理由を書く。**
  //
  // **`wb_owner` は「トリガー元の行の**持ち主の列**を書き戻そうとする島」そのものであり、
  // その綴りを持つことが題材の中身である**(`AC-G13` の起票の逐語が名指しした2つのうちの
  // 片方 = `st_owner` の付け替えを、実行で撃つために要る)。
  // **判定を島の中へ写したのではない** —— **島は値を返すだけで、可否を1つも決めていない。**
  // **外したのはこの1本だけであることを、件数で固定する。**
  const all = manifest().app.functions ?? [];
  const scanned = all.filter((fn) => fn.id !== "wb_owner");
  expect(scanned).toHaveLength(all.length - 1);
  const declared = scanned.map((fn) => fn.code).join("\n");
  for (const spelling of [
    "resolveRecordAccess",
    "creatorGrantPlan",
    "access_control",
    "st_owner",
  ]) {
    expect(declared.includes(spelling), spelling).toBe(false);
  }
});

// =====================================================================================
// (F) **面(役割に束ねた権限)が3経路に効く**(`V8-M21` の後半。台帳 `J-G21` / `J-G22a` /
//     `J-G23` の「判定の家は `src/server/owner-scope.ts` の既存1本」/ ユーザ決定 `D-V8-23`)
//
// **`V8-M21` の前半は点(行ごとの付与)だけを掛けていた。** **後半が面を足し、
// 面と点の合成(`OR`)ごと掛けた。**
//
// **【何を測るか】**
//  - **(F-1) / (F-2)**: **点を1つも宣言していない表**(`role_notes`)で、**面だけが止める /
//    通す**ことを、自動処理とコードの島の2経路で測る。**受信口は
//    `src/server/inbound-access-control.test.ts` の (F-3) が測る**(3経路目)。
//  - **(F-4)**: **面と点の両方を宣言した表**(`both_notes`)で、**どちらか一方が通せば
//    通る**(`OR`)ことを測る。
//
// **【禁止】「`OR` なので安全側に倒れる」と書かない** —— **`OR` は書ける側に倒れる。**
// =====================================================================================

test("(F-1) 面だけを宣言した表 —— 規則に載っていない役割の登録で動いた create_record は落ちる", async () => {
  // **`stranger` の役割は `owner`。`role_notes` に `owner` の規則は1本も無い。**
  // **点(行ごとの付与)はこの表に1つも宣言されていない** —— **止めているのは面だけである。**
  const res = await post(stranger, "role_src", { title: "外の役割" });
  expect(res.status).toBe(400);
  expect(rows("role_notes")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
  // **止めた層が面であることを、文面で名指ししている。**
  expect(historyDetail()).toContain("role");
});

test("(F-2) 面だけを宣言した表 —— 規則に載っている役割の登録なら、同じ create_record が通る", async () => {
  // **`editorOnly` はメンバー表に行を1つも持たない** —— **点は何も渡していない。**
  // **通しているのは面だけである。**
  const res = await post(editorOnly, "role_src", { title: "中の役割" });
  expect(res.status).toBe(201);
  expect(rows("role_notes").map((row) => row.body)).toEqual(["中の役割"]);
});

test("(F-3) 面はコードの島の書込にも効く(規則に載っていない役割は落ち、載っていれば通る)", async () => {
  expect((await post(stranger, "role_isl", { title: "島" })).status).toBe(400);
  expect(rows("role_notes")).toHaveLength(0);
  expect((await post(editorOnly, "role_isl", { title: "島" })).status).toBe(201);
  expect(rows("role_notes").map((row) => row.body)).toEqual(["島から"]);
});

test("(F-4) 面と点は OR で重なる —— どちらか一方が通せば自動処理は書ける", async () => {
  // **(i) 面だけが通す**: `editorOnly` は規則に載っているが、メンバー表に行が無い。
  expect((await post(editorOnly, "both_src", { title: "面で" })).status).toBe(201);
  // **(ii) 点だけが通す**: `member` はメンバー表に行を持つが、役割 `owner` の規則は無い。
  expect((await post(member, "both_src", { title: "点で" })).status).toBe(201);
  expect(rows("both_notes").map((row) => row.body)).toEqual(["面で", "点で"]);
  // **(iii) どちらも通さない**: `stranger` は役割の規則にも載らず、メンバー表にも行が無い。
  expect((await post(stranger, "both_src", { title: "どちらも" })).status).toBe(400);
  expect(rows("both_notes")).toHaveLength(2);
  // **止めた層を2つとも名指ししている。**
  expect(historyDetail()).toContain("role");
  expect(historyDetail()).toContain("grant");
});

test("(F-7)【正直に書く】「読める」と1行書いただけで、その表への自動書込・島の書込が全員分止まる", async () => {
  // **【この検査は代償の記録である。緑であることを「安全になった」と読まないこと。】**
  //
  // **`readonly_notes` に書いてある規則は「役割 `owner` × 表 `readonly_notes` × **読取**」の
  // 1本だけである。** **書込の規則は誰にも1本も書いていない。**
  // **それでも、面の管轄は**対象(表)**の単位で決まり、動詞を跨ぐ**(裁定 `R-4` / 台帳 `J-G19`)
  // —— **対象が名指しされた時点で、その表は書込についても allow-list になる。**
  //
  // **メインの判断(2026-08-10)**: **この形を維持する。**
  // **(対象, 動詞)を単位にすると、読取だけ宣言した表への書込が誰にでも開いたままになり、
  // それは黙った穴になる。** **このリポジトリは「黙って全員を弾く」も「黙って全員に開く」も
  // 避け、**うるさく落ちる**側を採る**(`ADR-0036` 限定3 / `J-G16`)。
  //
  // **【実際に壊れた例。手順ごと残す】** **参照EC(`scripts/ref-ec/`)がこれで壊れた** ——
  // **`order` に「運営は読める」を含む規則が在るため、決済の受信で注文を `paid` にする
  // 自動処理(`wf-payment-received`)が 400 で落ちた**(書き手が「誰でもない」に解決される。
  // きっかけの `payment_events` は `st_owner` を持たない)。
  // **直し方は語彙の中に在った** —— **そのワークフローに `act_as: "$record.order"` を1行足す**
  // (= 注文の持ち主として動く)。**購入者の規則が通す。**
  //
  // **【この直し方が使えない場合。丸めない】** **`act_as` が解決した `st_owner` が
  // `_auth_users` に**実在するアカウント**でないと、実効ロール集合が引けず「誰でもない」に
  // 倒れる** —— **カーネル / MCP / 移行スクリプトが作った行を持ち主にしている場合は、
  // `act_as` を書いても通らない**(実測: `scripts/ref-ec/manifest.test.ts` の (i-5) は、
  // 台にセッションを1つ置くまで直らなかった)。

  // **(1) 読める側の役割(`owner`)でも書けない。**
  expect((await post(member, "ro_src", { title: "読める人" })).status).toBe(400);
  expect(rows("readonly_notes")).toHaveLength(0);
  expect(historyDetail()).toContain("role");

  // **(2) 規則に1度も名指しされていない役割(`editor`)でも書けない。**
  expect((await post(editorOnly, "ro_src", { title: "他の役割" })).status).toBe(400);
  expect(rows("readonly_notes")).toHaveLength(0);

  // **(3) 島の書込も同じく止まる**(経路が違っても答えは同じ)。
  expect((await post(member, "ro_isl", { title: "島" })).status).toBe(400);
  expect(rows("readonly_notes")).toHaveLength(0);

  // **(4) 受信口も同じ形で止まる** —— **実測は
  //   `src/server/inbound-access-control.test.ts` の (F-5) が持つ**(あちらの表も
  //   規則1本だけで、受信の主体は役割を1つも持たないので面の側からは通らない)。
});

// =====================================================================================
// (P) オプトイン —— 宣言していない表への自動書込は今日どおり
// =====================================================================================

test("(P) アクセス権を宣言していない表へは、権限の無い相手の自動処理も今日どおり書ける", async () => {
  expect((await post(stranger, "open_orders", { title: "素の表へ" })).status).toBe(201);
  expect(rows("open_notes").map((row) => row.body)).toEqual(["素の表へ"]);
});

// =====================================================================================
// (O) `output_table` 全置換の前段(`clearOutputTable`)—— **明示的に決めた扱い**
// =====================================================================================

test("(O-a) 出力先が宣言した表のとき、消す権限が無ければ1行も消さずに落ちる", async () => {
  const kept = kernelCreate("sums", { value: 1 });
  const res = await post(stranger, "sum_src", { title: "集計" });
  expect(res.status).toBe(400);
  // **部分的に消えていない**(全置換の途中で止まらない)。
  expect(rows("sums").map((row) => row._id)).toEqual([kept._id]);
  expect(historyDetail()).toContain("アクセス権");
});

test("(O-b) 出力先の既存行を消せる相手なら、全置換は今日どおり通る", async () => {
  const kept = kernelCreate("sums", { value: 1 });
  kernelCreate("sum_grant", {
    sum: String(kept._id),
    member: memberRowId,
    permission: "keeper",
  });
  const res = await post(member, "sum_src", { title: "集計" });
  expect(res.status).toBe(201);
  const after = rows("sums");
  expect(after.map((row) => row.value)).toEqual([42]);
  expect(after[0]?._id).not.toBe(kept._id);
});

test("(O-c) 出力先が空なら、消す権限を1つも要求しない(再計算は止まらない)", async () => {
  expect(rows("sums")).toHaveLength(0);
  const res = await post(stranger, "sum_src", { title: "集計" });
  // **消す行が1件も無いので、消す権限は問わない。** **書く権限は問う** ——
  // `stranger` はメンバー表に行を持たないので、出力の書込で落ちる。
  expect(res.status).toBe(400);
  expect(historyDetail()).toContain("アクセス権");
});

// =====================================================================================
// (AC-G7a) **親の行に書ける人だけが作れる、を自動処理と島にも掛けた**
// (`V17-M2-T03a` / `T03b` / `T03c`。`ADR-0411` §Decision の 2 / ユーザ決定 `D-V16-4`
//  の逐語「**全部の入口に立てる**」)
//
// ## **着手前(`T03a`)の実測 —— 下の3本は赤だった**
//
// **`member`(参加者の表に居るが、親の行には1件の付与も持たない)の発火で、
// `inherit_from` を宣言した表へ行が **201** で作られていた。** **同じ人・同じ表・同じ親への
// HTTP の単件 `POST` は 403 である**(`src/server/create-parent-write.test.ts` の `(a-3)`)。
//
// ## **【関門は「作る」でしか発火しない。源の走査では測れないので実行で撃つ】**
//
// **`workflow-runner.ts` は `op.op !== "update"` のとき対象行を渡さないので、
// **`delete` op も作成の枝へ落ちる**。** **したがって「`row === undefined` なら関門を呼ぶ」と
// 書くと、削除にも掛かってしまう** —— **下の `(AC-G7a-11)` / `(AC-G7a-12)` が、
// 削除と更新で関門が1度も発火しないことを**実行で**固定する**(`ADR-0411` 限定4)。
//
// ## **この節が塞いでいないもの(誇張しない)**
//
//  - **`update` op で親を**別の親へ書き換える**ことは今日も通る**(`(AC-G7a-12)`)。
//  - **島の `write_back` は今日も `judgeAutomationWrite` を1度も通らない**
//    (更新であり、作成の関門の射程外である)。
//  - **時刻起動は1バイトも掛かっていない**(`(AC-G7a-13)`。`ADR-0411` 限定1)。
// =====================================================================================

test("(AC-G7a-0)【`T00` のベースライン】`inherit_from` を宣言していない表への自動書込は1ミリも変わらない", async () => {
  // **`notes` は点を宣言しているが `inherit_from` は1本も持たない。**
  // **`ADR-0411` 限定7 の相手になる着手前の応答は、この2つである。**
  expect((await post(member, "orders", { title: "中の人" })).status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["中の人"]);

  // **宣言そのものを持たない表も今日どおりである。**
  expect((await post(stranger, "open_orders", { title: "素の表へ" })).status).toBe(201);
  expect(rows("open_notes").map((row) => row.body)).toEqual(["素の表へ"]);
});

// **【`V17-M2-T08a`。`ADR-0411` 限定7 の【実装時に置く】検査の穴埋め】**
//
// **限定7 の逐語**: **「**4本の入口それぞれ**について、`inherit_from` を宣言していない表への
// 作成が実装前後で同じ応答になることを実サーバの検査で撃つ」。**
//
// **上の `(AC-G7a-0)` が撃っているのは自動処理の `create_record` の1本だけである** ——
// **同じ `workflow-runner.ts` に載っている残り2本(**島の `write_ops` の create op** と
// **`output_table` の全置換**)は撃たれていなかった。** **本検査がそれを埋める。**
//
// **【期待値の出所】** —— **どれも `V17-M2` より前から在る検査と同じ値である** ——
// `(iii-a)` / `(iii-b)`(島 → `notes`)と `(O-b)` / `(O-c)`(全置換 → `sums`)。
// **`notes` も `sums` も点(行ごとの付与)を宣言しているが、`inherit_from` は1本も持たない。**
test("(AC-G7a-0b)【`T00` のベースライン】`inherit_from` の無い表への島の書込と全置換も1ミリも変わらない", async () => {
  // --- (1) 島の `write_ops` の create op(`(iii-a)` / `(iii-b)` と同じ答え)-------------
  // **権限が無い相手は今日どおり落ちる**(理由は「アクセス権」であって「元になる行」ではない)。
  expect((await post(stranger, "isl", { title: "島" })).status).toBe(400);
  expect(rows("notes")).toHaveLength(0);
  expect(historyDetail()).toContain("アクセス権");
  expect(historyDetail()).not.toContain("元になる行");
  // **権限が在る相手は今日どおり通る。**
  expect((await post(member, "isl", { title: "島" })).status).toBe(201);
  expect(rows("notes").map((row) => row.body)).toEqual(["島から"]);

  // --- (2) `output_table` の全置換(`(O-c)` / `(O-b)` と同じ答え)-----------------------
  expect((await post(stranger, "sum_src", { title: "集計" })).status).toBe(400);
  expect(rows("sums")).toHaveLength(0);
  expect(historyDetail()).not.toContain("元になる行");
  expect((await post(member, "sum_src", { title: "集計" })).status).toBe(201);
  expect(rows("sums").map((row) => row.value)).toEqual([42]);
});

test("(AC-G7a-10) 親の行に書けない人の発火で動いた create_record は落ち、1行も書かれない", async () => {
  const parent = kernelCreate("parents", { title: "外の親" });
  const res = await post(member, "kid_src", { title: "親を指す", parent: String(parent._id) });
  // **発火元の書込ごと成立しない**(`ADR-0066`)。
  expect(res.status).toBe(400);
  expect(rows("kids")).toHaveLength(0);
  expect(historyDetail()).toContain("元になる行");
});

test("(AC-G7a-10b) 親の行に書ける人なら、同じ create_record は今日どおり通る", async () => {
  const parent = kernelCreate("parents", { title: "中の親" });
  kernelCreate("kid_grant", {
    parent: String(parent._id),
    member: memberRowId,
    permission: "keeper",
  });
  const res = await post(member, "kid_src", { title: "親を指す", parent: String(parent._id) });
  expect(res.status).toBe(201);
  expect(rows("kids").map((row) => row.body)).toEqual(["親を指す"]);
});

test("(AC-G7a-10c) 島の write_ops の create op も、親の行に書けなければ落ちる", async () => {
  const parent = kernelCreate("parents", { title: "外の親" });
  const res = await post(member, "kid_isl", { title: "島", parent: String(parent._id) });
  expect(res.status).toBe(400);
  expect(rows("kids")).toHaveLength(0);
  expect(historyDetail()).toContain("元になる行");
});

test("(AC-G7a-10d) 島の write_ops の create op は、親に書けるなら今日どおり通る", async () => {
  const parent = kernelCreate("parents", { title: "中の親" });
  kernelCreate("kid_grant", {
    parent: String(parent._id),
    member: memberRowId,
    permission: "keeper",
  });
  const res = await post(member, "kid_isl", { title: "島", parent: String(parent._id) });
  expect(res.status).toBe(201);
  expect(rows("kids").map((row) => row.body)).toEqual(["島から"]);
});

test("(AC-G7a-10e) output_table の全置換も、親の行に書けなければ1行も作らない", async () => {
  const parent = kernelCreate("parents", { title: "外の親" });
  const res = await post(member, "okid_src", { title: "集計", parent: String(parent._id) });
  expect(res.status).toBe(400);
  expect(rows("okids")).toHaveLength(0);
  expect(historyDetail()).toContain("元になる行");
});

test("(AC-G7a-10f) output_table の全置換は、親に書けるなら今日どおり通る", async () => {
  const parent = kernelCreate("parents", { title: "中の親" });
  kernelCreate("kid_grant", {
    parent: String(parent._id),
    member: memberRowId,
    permission: "keeper",
  });
  const res = await post(member, "okid_src", { title: "集計", parent: String(parent._id) });
  expect(res.status).toBe(201);
  expect(rows("okids").map((row) => row.value)).toEqual([42]);
});

test("(AC-G7a-11)【限定4 の実行での固定】島の delete op には関門が1度も発火しない", async () => {
  // **削除も「作成の枝」へ落ちる**(`workflow-runner.ts` は `op.op !== "update"` のとき
  // 対象行を渡さない)—— **源を走査するだけでは作成と区別できない。**
  //
  // **`delete` はバッチの語彙に無いので、この発火は今日も落ちる**(`batch.ts` の
  // `allowed_values` は `["create", "update"]` の2値である)。 **測っているのは
  // 「落ちること」ではなく、**どの理由で落ちるか**である** —— **関門が発火していれば、
  // 理由が「元になる行」に変わる。**
  const parent = kernelCreate("parents", { title: "外の親" });
  const kid = kernelCreate("kids", { body: "消される", parent: String(parent._id) });
  // **`member` は親の行に1件の付与も持たない**(= 作成なら止まる相手である)。
  const res = await post(member, "kid_del_isl", { title: "消す", target: String(kid._id) });
  expect(res.status).toBe(400);
  // **理由は今日と1バイトも変わらない** —— **関門は1度も発火していない。**
  //
  // 【`V17-M3-T07b` / `AC-G27a` で期待値を1つ差し替えた。**旧の1行を逐語で残す**】
  //
  //     expect(historyDetail()).toContain('バッチの操作 "delete" は語彙にありません');
  //
  // **履歴の `error` に「項目の値」を1バイトも載せなくなった** —— **`"delete"` は
  //   島が返した op の値なので落ちる。** **残るのは、落ちた場所(`/ops/0/op`)と、
  //   そこに書ける操作の一覧(`allowed_values` = `create` / `update`)である。**
  // **「関門が1度も発火していない」は今日も読める** —— **断りが権限の文面
  //   (「アクセス権」「元になる行」)ではなく、**語彙**の失敗だからである。**
  expect(historyDetail()).toContain("/ops/0/op(許可される値: create / update)");
  expect(historyDetail()).not.toContain("アクセス権");
  expect(historyDetail()).not.toContain("元になる行");
  // **1行も消えていない。**
  expect(rows("kids")).toHaveLength(1);
});

test("(AC-G7a-12)【塞いでいない。限定4 のとおり】島の update op は親を別の親へ書き換えられる", async () => {
  const from = kernelCreate("parents", { title: "移す前の親" });
  const to = kernelCreate("parents", { title: "移した先の親" });
  const kid = kernelCreate("kids", { body: "移される", parent: String(from._id) });
  // **その行そのものへの付与だけを渡す** —— **どちらの親にも1件の付与を持たない。**
  // **それでも親を付け替えられる** —— **`ADR-0411` 限定4 は「掛けるのは作るだけ」と
  // 定めており、更新は射程外だからである。** **`AC-G8`(古い親にも問う)は HTTP の
  // 更新2経路にしか効かない** —— **`ADR-0411` が引き直したのは作成の側だけである。**
  kernelCreate("kid_grant", {
    kid: String(kid._id),
    member: memberRowId,
    permission: "keeper",
  });
  const res = await post(member, "kid_upd_isl", {
    title: "移す",
    target: String(kid._id),
    parent: String(to._id),
    version: String(kid._updated_at),
  });
  expect(res.status).toBe(201);
  expect(rows("kids").map((row) => row.parent)).toEqual([String(to._id)]);
  expect(historyDetail()).not.toContain("元になる行");
});

test("(AC-G7a-13)【正直に書く】時刻起動は親の関門も1バイトも受けない", () => {
  const parent = kernelCreate("parents", { title: "外の親" });
  const src = kernelCreate("kid_sched_src", {
    title: "夜間",
    parent: String(parent._id),
    st_owner: stranger.userId,
  });
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const m = manifest();
    const workflow = (m.app.workflows ?? []).find((candidate) => candidate.id === "wf_kid_sched");
    expect(workflow).toBeDefined();
    runScheduledWorkflow(db, m, workflow as never, { records: [src as never] });
  } finally {
    db.close();
  }
  // **1行書けている。** **これは塞いでいないことの記録である**(`ADR-0411` 限定1 /
  // 越えてはならない線1。`AC-G11` の判定値は保留である)。
  expect(rows("kids").map((row) => row.body)).toEqual(["時刻起動から"]);
});

// =====================================================================================
// (S) 【正直に書く】決まった時刻に動く処理は今日も素通りする
// =====================================================================================

test("【正直に書く】(S) 時刻起動は判定を1バイトも受けず、権限の無い相手の行としてでも書ける", () => {
  // **同じ相手・同じ書込先である** —— (ii-a) では落ちたものが、ここでは通る。
  const src = kernelCreate("sched_src", { title: "夜間", st_owner: stranger.userId });
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const m = manifest();
    const workflow = (m.app.workflows ?? []).find((candidate) => candidate.id === "wf_sched");
    expect(workflow).toBeDefined();
    runScheduledWorkflow(db, m, workflow as never, {
      records: [src as never],
    });
  } finally {
    db.close();
  }
  // **1行書けている。** **これは塞いでいないことの記録である**
  // (`D-V8-33` / `J-G22b` = 保留 / `docs/plan/undecided.md` の `U-3`)。
  expect(rows("notes").map((row) => row.body)).toEqual(["時刻起動から"]);
});

test("【正直に書く】(S-2) 行選択の無い時刻起動も素通りする(主体が空でも止めない)", () => {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    const m = manifest();
    const workflow = (m.app.workflows ?? []).find((candidate) => candidate.id === "wf_sched");
    runScheduledWorkflow(db, m, workflow as never, undefined);
  } finally {
    db.close();
  }
  expect(rows("notes")).toHaveLength(1);
});

// =====================================================================================
// **【`V17-M3-T01a`】(AC-G12) ボタン起動の `update_record` と、個人所有(`st_owner`)**
//
// **主題**: **画面からは「その行は存在しません」と断られる相手が、ボタン1つで同じ行を
// 書き換えられる。** **`judgeAutomationWrite` は面と点しか問わず、`st_owner` を1つも見ない。**
//
// **題材は本物の SQLite と本物の HTTP(`app.request`)で組む** —— 判定の関数を直接呼ばない。
// **赤にするのは (AC-G12-1) だけである。** **(AC-G12-2) と (AC-G12-3) は陰性対照であり、
// 着手前も着手後も緑のままでなければならない。**
// =====================================================================================

/** ボタン起動(`manual`)を画面の入口から撃つ。 */
function runManual(
  session: ReturnType<typeof seedSession>,
  workflowId: string,
  recordId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(
        `http://localhost/api/apps/${APP_ID}/views/own-list/actions/run?workflow=${workflowId}&record=${recordId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: session.cookie,
            origin: TEST_ORIGIN,
          },
          body: "{}",
        },
      ),
    ),
  );
}

/** 帳簿から直に読んだ版(`_updated_at`)を `If-Match` に載せて `PATCH` する。 */
function patchWithLedgerVersion(
  session: ReturnType<typeof seedSession>,
  tableId: string,
  recordId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const row = rows(tableId).find((candidate) => String(candidate._id) === recordId);
  return Promise.resolve(
    app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: session.cookie,
          origin: TEST_ORIGIN,
          "if-match": String(row?._updated_at ?? ""),
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

test("(AC-G12-1) 画面から 404 の他人の行は、ボタン起動の update_record も書き換えられない", async () => {
  // 持ち主は `member`。押すのは `stranger`(別人)。
  const note = kernelCreate("own_notes", { title: "のっとり対象", st_owner: member.userId });
  const noteId = String(note._id);
  const src = kernelCreate("own_src", {
    title: "きっかけ",
    st_owner: stranger.userId,
    note: noteId,
  });

  // (a) 画面からは、その行は**存在しない**。
  const read = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/own_notes/records/${noteId}`, {
      headers: { cookie: stranger.cookie },
    }),
  );
  expect(read.status).toBe(404);
  const written = await patchWithLedgerVersion(stranger, "own_notes", noteId, {
    title: "画面から書き換えた",
  });
  expect(written.status).toBe(404);

  // (b) 同じ相手が同じ行をボタン1つで書き換えられてはならない —— **`AC-G12` が塞ぐ穴。**
  //     **【着手前は赤である】** 今日は `failures: []` で返り、行が書き換わる。
  const fired = await runManual(stranger, "own_takeover", String(src._id));
  expect(fired.status).toBe(200);
  const body = (await fired.json()) as { failures: string[] };
  expect(body.failures).toHaveLength(1);

  // (c) **存在を伏せる** —— 「他人のものだから」とは書かない(単件 `GET` の 404 と同じ向き)。
  expect(body.failures[0]).toContain("見つかりません");
  expect(body.failures[0]).not.toContain("所有者");

  // (d) 帳簿の行は1バイトも変わっていない。
  const after = rows("own_notes").find((row) => String(row._id) === noteId);
  expect(after?.title).toBe("のっとり対象");
  expect(after?.st_owner).toBe(member.userId);
});

test("(AC-G12-2)【陰性対照】出荷時の宣言のままなら、ボタン起動は今日すでに止まる", async () => {
  const note = kernelCreate("stock_notes", { title: "のっとり対象", st_owner: member.userId });
  const noteId = String(note._id);
  const src = kernelCreate("own_src", {
    title: "きっかけ",
    st_owner: stranger.userId,
    snote: noteId,
  });

  const fired = await runManual(stranger, "stock_takeover", String(src._id));
  expect(fired.status).toBe(200);
  const body = (await fired.json()) as { failures: string[] };
  expect(body.failures).toHaveLength(1);
  // **止めているのは差分適用が補う条件(持ち主 or 空)である** —— **個人スコープの判定ではない。**
  expect(historyDetail()).toContain("アクセス権");
  expect(rows("stock_notes").find((row) => String(row._id) === noteId)?.title).toBe("のっとり対象");
});

test("(AC-G12-3)【陰性対照】自分の行に対するボタン起動の update_record は今日どおり通る", async () => {
  const note = kernelCreate("own_notes", { title: "のっとり対象", st_owner: stranger.userId });
  const noteId = String(note._id);
  const src = kernelCreate("own_src", {
    title: "きっかけ",
    st_owner: stranger.userId,
    note: noteId,
  });

  const fired = await runManual(stranger, "own_takeover", String(src._id));
  expect(fired.status).toBe(200);
  expect((await fired.json()) as { failures?: unknown[] }).toMatchObject({ failures: [] });
  const after = rows("own_notes").find((row) => String(row._id) === noteId);
  expect(after?.title).toBe("のっとり後");
  expect(after?.st_owner).toBe(stranger.userId);
});

// =====================================================================================
// **【`V17-M3-T02a`】(AC-G13) 島の書き戻し(`write_back`)と、面・点・個人所有の判定**
//
// **主題**: **`writeBackToTriggerRecord` は今日、判定の綴りを1つも持たない** ——
// **`accessJudgmentApplies` の判定に到達する前に分岐しており、面も点も個人所有も
// 1度も問われないまま、トリガー元の行の**本文**と**持ち主**を書き換える。**
//
// **題材は本物の SQLite と本物の HTTP(`app.request`)で組む** —— 判定の関数を直接呼ばない。
// **起票の逐語が名指しした2つ(`st_owner` と本文)を、**別々の検査**で撃つ。**
// =====================================================================================

test("(AC-G13-1) 他人の行を1件も読めない相手の書き戻しは、その行の本文を書き換えられない", async () => {
  // 書き手は `act_as` が指す代理先の持ち主 = `stranger`。行の持ち主は `member`。
  const agent = kernelCreate("agents", { label: "外の代理", st_owner: stranger.userId });
  const created = await post(member, "wb_src", {
    title: "書き戻し対象",
    body: "元の本文",
    agent: String(agent._id),
  });
  expect(created.status).toBe(201);
  const srcId = String(((await created.json()) as { record: { _id: string } }).record._id);

  // (a) **書き手からは、その行は存在しない。**(読取だけが個人所有に絞られている)
  const read = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/wb_src/records/${srcId}`, {
      headers: { cookie: stranger.cookie },
    }),
  );
  expect(read.status).toBe(404);

  // (b) **その書き手の発火で走る書き戻しも、同じ行を書き換えられない。**
  //     **発火元の書込ごと成立しない**(`ADR-0066`)—— 利用者が書いた本文も巻き戻る。
  const res = await patch(member, "wb_src", srcId, { body: "利用者が書いた" });
  expect(res.status).toBe(400);
  const after = rows("wb_src").find((row) => String(row._id) === srcId);
  expect(after?.body).toBe("元の本文");
  expect(after?.st_owner).toBe(member.userId);

  // (c) **存在を伏せる** —— 「他人のものだから」とは書かない(単件 `GET` の 404 と同じ向き)。
  expect(historyDetail()).toContain("見つかりません");
});

test("(AC-G13-2) 書き戻しは、行の持ち主を他人へ付け替えられない", async () => {
  const created = await post(member, "wb_give", {
    title: "譲渡対象",
    give_to: stranger.userId,
  });
  expect(created.status).toBe(201);
  const giveId = String(((await created.json()) as { record: { _id: string } }).record._id);

  // (a) **HTTP で同じ値を書くと 403 になる**(起票の逐語)。
  const byHand = await patch(member, "wb_give", giveId, { st_owner: stranger.userId });
  expect(byHand.status).toBe(403);
  expect(rows("wb_give").find((row) => String(row._id) === giveId)?.st_owner).toBe(member.userId);

  // (b) **同じ値は、書き戻し経由でも書けない。**
  const res = await patch(member, "wb_give", giveId, { title: "更新した" });
  expect(res.status).toBe(400);
  expect(rows("wb_give").find((row) => String(row._id) === giveId)?.st_owner).toBe(member.userId);
  expect(historyDetail()).toContain("所有者");
});

test("(AC-G13-3)【陰性対照】自分の行への書き戻しは今日どおり通る", async () => {
  const created = await post(member, "wb_own", { title: "自分の行", body: "元の本文" });
  expect(created.status).toBe(201);
  const ownId = String(((await created.json()) as { record: { _id: string } }).record._id);

  const res = await patch(member, "wb_own", ownId, { title: "更新した" });
  expect(res.status, historyDetail()).toBe(200);
  const after = rows("wb_own").find((row) => String(row._id) === ownId);
  expect(after?.body).toBe("島が書き戻した");
  expect(after?.st_owner).toBe(member.userId);
});

// =====================================================================================
// **【`V17-M3-T04a`】(AC-G14) ボタン起動の `act_as` と、押した人から見た行の見え方**
//
// **主題**: **押した人から単件 `GET` が 404 になる行を `act_as` の参照先に指すと、
// その行の持ち主として自動処理が走る** —— **押した人は「自分に見えない誰か」を
// 参照欄の値で選べる。**
//
// **`workflow.actions` を2本持たせている** —— **「1本目が書いてから2本目で落ちた」形を
// 排除して「1行も書かずに」を測るためである。**
// =====================================================================================

/** ボタン起動(`manual`)を、画面を名指しして撃つ。 */
function runManualOn(
  session: ReturnType<typeof seedSession>,
  viewId: string,
  workflowId: string,
  recordId: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(
        `http://localhost/api/apps/${APP_ID}/views/${viewId}/actions/run?workflow=${workflowId}&record=${recordId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: session.cookie,
            origin: TEST_ORIGIN,
          },
          body: "{}",
        },
      ),
    ),
  );
}

/**
 * 押した人から見た、代理先の1行の単件 `GET` の応答コード。
 *
 * 【`V17-M3-T07c` で書き方を1つ直した。**旧の形を逐語で残す**】
 *
 *     return app.request(new Request(…)).then((res) => res.status);
 *
 * **`app.request` の戻り値の型は `Promise<Response> | Response` である** ——
 * **`.then` はその和の片方にしか無いので `tsc` が拒否する**
 * (`error TS2339: Property 'then' does not exist on type 'Promise<Response> | Response'.`)。
 * **`await` なら両方を受けられる。**
 *
 * **【この赤は本葉が作ったものではない。実測で確かめた】** —— **`T04a`(commit `35231f6c`)が
 * 足した形であり、`T07a` に着手する前の土台(`2ea75f48`)で既に赤だった。**
 * **見つからなかったのは、`bun run typecheck` を**リポジトリのルートでだけ**打っていたからである**
 * —— **ルートの `tsc` は `apps/smailtalk` を見ていない。** **実CI は別ジョブで打つ。**
 */
async function getStatusOf(
  session: ReturnType<typeof seedSession>,
  tableId: string,
  recordId: string,
): Promise<number> {
  const res = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/tables/${tableId}/records/${recordId}`, {
      headers: { cookie: session.cookie },
    }),
  );
  return res.status;
}

/** 押す人の `am_src` の行を1つ作り、その `_id` を返す。 */
async function seedManualSource(
  session: ReturnType<typeof seedSession>,
  agentId: string | undefined,
): Promise<string> {
  const values: Record<string, unknown> = { title: "きっかけ" };
  if (agentId !== undefined) {
    values.aagent = agentId;
  }
  const created = await post(session, "am_src", values);
  expect(created.status).toBe(201);
  return String(((await created.json()) as { record: { _id: string } }).record._id);
}

test("(AC-G14-1) 押した人から 404 の行を act_as に指した発火は、1行も書かずに失敗する", async () => {
  const agent = kernelCreate("am_agents", { label: "他人の代理", st_owner: member.userId });
  const agentId = String(agent._id);
  const srcId = await seedManualSource(stranger, agentId);

  // (a) 押した人からは、その代理の行は存在しない。
  expect(await getStatusOf(stranger, "am_agents", agentId)).toBe(404);

  // (b) **発火は失敗し、`workflow.actions` が指す表に1行も書かれない。**
  //     **アクションは2本ある** —— **1本目が書いてから2本目で落ちる形ではない。**
  const fired = await runManualOn(stranger, "am-list", "am_takeover", srcId);
  expect(fired.status).toBe(200);
  const body = (await fired.json()) as { failures: string[] };
  expect(body.failures).toHaveLength(1);
  expect(body.failures[0]).toContain("act_as");
  // **存在を伏せる** —— 単件 `GET` の 404 と同じ向き。
  expect(body.failures[0]).toContain("見つかりません");
  expect(rows("notes")).toHaveLength(0);
  // **履歴には失敗が1行残る**(黙って止めない。憲法6)。
  expect(historyDetail()).toContain("failure:");
});

test("(AC-G14-2)【陰性対照】押した人に見える行を act_as に指した発火は今日どおり通る", async () => {
  const agent = kernelCreate("am_agents", { label: "自分の代理", st_owner: member.userId });
  const agentId = String(agent._id);
  const srcId = await seedManualSource(member, agentId);

  expect(await getStatusOf(member, "am_agents", agentId)).toBe(200);

  const fired = await runManualOn(member, "am-list", "am_takeover", srcId);
  expect(fired.status).toBe(200);
  const body = (await fired.json()) as { failures: string[] };
  expect(body.failures, historyDetail()).toHaveLength(0);
  expect(
    rows("notes")
      .map((row) => String(row.body))
      .sort(),
  ).toEqual(["1本目", "2本目"]);
});

test("(AC-G14-3) 単件 GET の答え(404 / 200)と、この段の判定の答え(断る / 断らない)が一致する", async () => {
  // **【計画 §3-4 の対応表の裏取り】** —— **3つの形をひとつずつ、同じ人・同じ行で突き合わせる。**
  const measure = async (
    label: string,
    seed: Record<string, unknown>,
  ): Promise<{ label: string; status: number; refused: boolean }> => {
    const agent = kernelCreate("am_agents", seed);
    const agentId = String(agent._id);
    const srcId = await seedManualSource(stranger, agentId);
    const status = await getStatusOf(stranger, "am_agents", agentId);
    const fired = await runManualOn(stranger, "am-list", "am_takeover", srcId);
    const body = (await fired.json()) as { failures?: string[] };
    const refused = (body.failures ?? []).some((text) => text.includes("act_as"));
    return { label, status, refused };
  };

  const other = await measure("他人が持つ行", { label: "他人", st_owner: member.userId });
  const mine = await measure("押した人が持つ行", { label: "自分", st_owner: stranger.userId });
  const shared = await measure("共有(持ち主が空)の行", { label: "共有" });

  // **4つ目の形** —— **参照先の表が「条件なしの読取の規則」を持つとき、面が個人所有の壁を
  // 越えて単件 `GET` が 200 になる**(`app.ts` の `roleReadCrossesOwnerScope`)。
  // **計画 §3-4 の対応表はこの越え方を1行も書いていない** —— **書いてある2本の述語
  // (面と点・個人所有)だけで問うと、ここで単件 `GET` と食い違う。**
  const crossing = await (async () => {
    const agent = kernelCreate("agents", { label: "他人の代理", st_owner: member.userId });
    const agentId = String(agent._id);
    const created = await post(stranger, "am_open", { title: "きっかけ", agent: agentId });
    expect(created.status).toBe(201);
    const srcId = String(((await created.json()) as { record: { _id: string } }).record._id);
    const status = await getStatusOf(stranger, "agents", agentId);
    const fired = await runManualOn(stranger, "am-open-list", "am_open_takeover", srcId);
    const body = (await fired.json()) as { failures?: string[] };
    return {
      label: "他人が持つ行(条件なしの読取の規則つき)",
      status,
      refused: (body.failures ?? []).some((text) => text.includes("act_as")),
    };
  })();

  // **404 なら断る / 200 なら断らない。** **食い違ったら計画の設計が崩れる。**
  expect([other, mine, shared, crossing]).toEqual([
    { label: "他人が持つ行", status: 404, refused: true },
    { label: "押した人が持つ行", status: 200, refused: false },
    { label: "共有(持ち主が空)の行", status: 200, refused: false },
    { label: "他人が持つ行(条件なしの読取の規則つき)", status: 200, refused: false },
  ]);
});
