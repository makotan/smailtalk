/**
 * **マイページの「自分の記録」の読取 `?my_page=1` の受け口**(`V22-M3-T04`。`ADR-0488` §Decision 1 の 5 /
 * `ADR-0490` §Decision 1 の行2 / `ADR-0492`。ユーザ決定 `D-V22-19` / `D-V22-23` / `D-V22-24`)。
 *
 * **口は足さない**(`ADR-0488` 限定7)。 既存の一覧の口 `GET /api/apps/:id/tables/:t/records` が、
 * このファイルの2本を呼ぶだけである:
 *
 *  - {@link myPageListRead} —— 要求に `my_page` が在るかを見て、断る理由(401 / 400)か、絞りに使う
 *    「持ち主の列」と自分の ID を返す。 **`my_page` が無ければ `off` を返し、一覧の口は着手前と同じ答えを返す。**
 *  - {@link keepMyPageRows} —— 行を「持ち主の列のどれか1つが自分の ID と等しい」ものだけに絞る(`D-V22-23`)。
 *    持ち主が空の行は残さない。
 *
 * **このファイルは読める範囲を1ミリも広げない。** 一覧の口は今日の母集団の判定(`judgeRecordPopulation`)と
 * 画面名を名乗らない読取の壁を今日どおり通した**後**の行に {@link keepMyPageRows} を掛ける(AND)。
 * 運営者の役割にも同じ絞りが掛かる(`ADR-0488` 線6)。
 *
 * **持ち主が分かる表の判定は書かない** —— `src/shared/my-page.ts` の `myPageTables` 1本に任せる(`ADR-0488` 限定11)。
 * **表の規則は読まない** —— 持ち主の列がその役割から隠れているかは `owner-scope.ts` の `judgeRoleAccess` 1本に
 * 聞く(`ADR-0305` 限定2 の第1列。規則を読むのはあちら)。
 *
 * **【`V22-M3-T08a` の追記(独立点検の指摘 中-1・中-2 / `ADR-0493`)】** 丸ごと隠れているかの判定は
 * `src/shared/my-page.ts` の `myPageOwnerHidden` 1本に移した(画面も同じ1本を呼ぶ)。 行ごとに伏せられる列は
 * {@link keepMyPageRows} が行ごとに見る(伏せられた行は自分の行に数えない)。
 */

import type { Manifest, ValidationError } from "../kernel/index.ts";
import { myPageOwnerHidden, myPageTables } from "../shared/my-page.ts";
import { type ActorRoles, judgeRoleAccess } from "./owner-scope.ts";

/** 読取の引数の名前。 値は `1` だけを受ける。 */
export const MY_PAGE_QUERY_KEY = "my_page";

/** {@link myPageListRead} の答え。 */
export type MyPageListRead =
  /** `my_page` が無い。 一覧の口は着手前と同じ。 */
  | { kind: "off" }
  /** 未ログイン(401)。 */
  | { kind: "unauthenticated" }
  /** 断る(400)。 */
  | { kind: "rejected"; errors: ValidationError[] }
  /**
   * 絞る。 `ownerFields` のどれか1つが `actorId` と等しい行だけを残す。
   *
   * **【`V22-M3-T08a` 中-1 / `ADR-0493`】`rowJudged` の列は、行ごとに伏せられうる持ち主の列である**(その役割に
   * 読めるのが条件つきの項目の許可だけの列)。 その列は、その行で読めるとき(射影の後に値が残るとき)だけ比べる。
   * **旧(逐語)**: `| { kind: "on"; ownerFields: readonly string[]; actorId: string };`
   */
  | {
      kind: "on";
      ownerFields: readonly string[];
      actorId: string;
      rowJudged: readonly string[];
      manifest: Manifest;
      tableId: string;
      roles: ActorRoles;
    };

const HINT_WHERE =
  "my_page=1 は、マイページを置いたアプリ(set_workspace の my_page)で、自分の記録に載る表にだけ使えます。";

/**
 * **`?my_page=1` の要求を読む**(断る理由を先に全部見る。 絞るのは一覧の口の側)。
 *
 * 断る順: 値が `1` でない(400)→ 未ログイン(401)→ `?view=` と同時(400)→ マイページが無いアプリ・
 * 自分の記録に載らない表(400)→ 持ち主の列がその役割から隠れている(400。 隠れた列の名前は出さない)。
 */
export function myPageListRead(params: {
  manifest: Manifest;
  tableId: string;
  searchParams: URLSearchParams;
  actorId: string | null;
  roles: ActorRoles;
}): MyPageListRead {
  const { manifest, tableId, searchParams } = params;
  if (!searchParams.has(MY_PAGE_QUERY_KEY)) {
    return { kind: "off" };
  }
  const values = searchParams.getAll(MY_PAGE_QUERY_KEY);
  if (values.length !== 1 || values[0] !== "1") {
    return rejected(
      `/${MY_PAGE_QUERY_KEY}`,
      `${MY_PAGE_QUERY_KEY} に書けるのは 1 だけです(1回だけ書いてください)。`,
      "自分の記録だけを読むときは my_page=1、今日どおり読むときは my_page を書かないでください。",
    );
  }
  if (params.actorId === null || params.actorId === "") {
    return { kind: "unauthenticated" };
  }
  if (searchParams.has("view")) {
    return rejected(
      "/view",
      "my_page=1 と view= は同時に指定できません。",
      "マイページの自分の記録を読むときは view= を外してください。画面の一覧を読むときは my_page=1 を外してください。",
    );
  }
  const declared = manifest.app.workspace?.my_page;
  if (declared === undefined || declared === null) {
    return rejected(`/${MY_PAGE_QUERY_KEY}`, "このアプリにはマイページがありません。", HINT_WHERE);
  }
  const entry = myPageTables(manifest).find((one) => one.table === tableId);
  if (entry === undefined) {
    return rejected(
      `/${MY_PAGE_QUERY_KEY}`,
      `表 "${tableId}" はマイページの自分の記録に載っていません。`,
      HINT_WHERE,
    );
  }
  // **【`V22-M3-T08a` 中-2】判定は `src/shared/my-page.ts` の `myPageOwnerHidden` 1本(画面も同じ1本を呼ぶ)。**
  // **旧(逐語)**: `const hidden = entry.ownerFields.some(` / `(field) =>` / `!judgeRoleAccess({` / `manifest,` /
  // `roles: params.roles,` / `target: { target: "field", table: tableId, field },` / `verb: "read",` / `}).allowed,` / `);`
  const hidden = myPageOwnerHidden(manifest, params.roles, entry);
  if (hidden) {
    return rejected(
      `/${MY_PAGE_QUERY_KEY}`,
      `表 "${tableId}" の持ち主の列は、あなたの役割には見せていない列なので、マイページで絞れません。`,
      "この表はマイページの自分の記録には出ません。",
    );
  }
  // **【`V22-M3-T08a` 中-1】行を渡さない判定が「条件つきの許可が関わった」と答えた持ち主の列だけを、行ごとに見る。**
  // 条件つきの許可が関わらない列は、どの行でも行を渡さない判定と同じ答え(読める)なので、行ごとに判定しない。
  // **旧(逐語)**: `return { kind: "on", ownerFields: entry.ownerFields, actorId: params.actorId };`
  const rowJudged = entry.ownerFields.filter(
    (field) =>
      judgeRoleAccess({
        manifest,
        roles: params.roles,
        target: { target: "field", table: tableId, field },
        verb: "read",
      }).conditional,
  );
  return {
    kind: "on",
    ownerFields: entry.ownerFields,
    actorId: params.actorId,
    rowJudged,
    manifest,
    tableId,
    roles: params.roles,
  };
}

/**
 * **持ち主の列のどれか1つが自分の ID と等しい行だけを残す**(並びは変えない。 持ち主が空の行は残さない)。
 *
 * **【`V22-M3-T08a` 中-1 / `ADR-0493`。方式(b)】その役割・その行で持ち主の列が読める(射影の後に値が残る)
 * 場合だけ比べる。** 行ごとに伏せられる列(条件つきの項目の許可)は、応答の射影(`projectForRoleFields`)と
 * 同じ述語(`judgeRoleAccess` に行と自分を渡した `allowed`)で見る。 **伏せられた行は、値が自分でも自分の行に
 * 数えない**(数えると「伏せた列の値が自分である」ことが、行が載ることで漏れる)。
 * **旧(逐語)**: `return rows.filter((row) =>` / `read.ownerFields.some((field) => {` / `const value = row[field];` /
 * `return typeof value === "string" && value !== "" && value === read.actorId;` / `}),` / `);`
 */
export function keepMyPageRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  read: Extract<MyPageListRead, { kind: "on" }>,
): T[] {
  return rows.filter((row) =>
    read.ownerFields.some((field) => {
      const value = row[field];
      if (!(typeof value === "string" && value !== "" && value === read.actorId)) {
        return false;
      }
      if (!read.rowJudged.includes(field)) {
        return true;
      }
      return judgeRoleAccess({
        manifest: read.manifest,
        roles: read.roles,
        target: { target: "field", table: read.tableId, field },
        verb: "read",
        row,
        subject: read.actorId,
      }).allowed;
    }),
  );
}

function rejected(path: string, message: string, hint: string): MyPageListRead {
  return { kind: "rejected", errors: [{ path, message, hint }] };
}
