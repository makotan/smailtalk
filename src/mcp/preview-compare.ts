/**
 * **見比べの束に案を入れる**(`V20-M14-T01A`。計画 `docs/plan/v20/16-v20-m14-plan.md` §9-1・§10-2 /
 * `ADR-0478` §Decision 1-1〜1-3 / `D-V20-47`・`D-V20-52`)。
 *
 * `dry_run_diff` に `preview` と `compare: { name, tradeoff, group? }` を付けて呼ばれたとき、`read.ts` が
 * 次の順で呼ぶ(**順序は計画 §10-2 が正**):
 *
 * 1. **形**({@link validateCompareShape})。 誤りは**引数の誤り**(`ADR-0003` §3 の形)。
 * 2. 差分の検証(今日どおり。`read.ts`。**拒否なら下見も束も作らない**)。
 * 3. **データが失われる op の断り**と**束の照合**({@link admitCompare})。 外れたら**下見を作らず**
 *    `preview_refused` で断る(差分の検証結果は今日どおり返る)。
 * 4. 下見を作る(`createPreview`。今日の口のまま)→ 注意を計算(`read.ts`)。
 * 5. **案の票と束**({@link attachCandidate}): `candidate.json` → 束へ追記(新しい束なら作る)→
 *    **数え直して3を超えていれば自分の案を消して断る**。 **途中の失敗は自分の下見を消して断る。**
 *
 * **【`V20-M15-T01B` / `ADR-0479` §Decision 4-1・4-2・4-4】** `compare` の4本目の鍵 `off_pattern`(省略可能な真偽)の
 * 形({@link validateCompareShape})と、型の無いアプリでの `off_pattern: true` の断り({@link offPatternError}。
 * **判定は本物のアプリの今の型**で、型の数は `read.ts` が数えて渡す)。 **`remember_design` の `design_memory.choice` を
 * 1本でも含む案**は {@link admitCompare} が `preview_refused` で断る(`patterns` だけの案は束に入る。`D-V20-64`)。
 * 案の票に `off_pattern` を書く({@link attachCandidate})。
 *
 * **カーネルの値を1つも import しない**(`scripts/kernel-import-snapshot.txt` を動かさない)。
 */

import type { ValidationError } from "../kernel/errors.ts";
import {
  appendCandidateToGroup,
  COMPARE_MAX_CANDIDATES,
  createGroup,
  discardPreview,
  findGroup,
  findPreview,
  isGroupEntry,
  newPreviewId,
  type PreviewClock,
  type PreviewMeta,
  type PreviewMode,
  parsePreviewAppId,
  previewAppId,
  readCandidate,
  removeCandidateFromGroup,
  removePreview,
  withGroupLock,
  writeCandidate,
} from "../server/preview-store.ts";

/** 案の名前の字数の上限(コードポイント)。 */
export const COMPARE_NAME_MAX = 40;

/** トレードオフの1行の字数の上限(コードポイント)。 */
export const COMPARE_TRADEOFF_MAX = 80;

/**
 * **データが失われる op**(`D-V20-52`)。 1つでも含む差分は見比べの案にしない。 **この4つは
 * `DESTRUCTIVE_CHANGE_FLOW`(MCP の指示文)が破壊的と名指しする4つと同じである。**
 */
export const COMPARE_DESTRUCTIVE_OPS: readonly string[] = [
  "remove_field",
  "remove_table",
  "change_table",
  "change_field",
];

/** データが失われる op を含む差分を断るときの文言(`D-V20-52` の逐語で始める)。 */
export const COMPARE_DESTRUCTIVE_REASON =
  "データが失われる変更は見比べに出せません" +
  "(remove_field / remove_table / change_table / change_field を1つでも含む差分は束に入れません)。" +
  "そういう変更は見比べに出さず、dry_run_diff で影響を確かめてユーザの同意を得てから apply_diff で適用してください。";

/**
 * **選んだ記録(`remember_design` の `design_memory.choice`)を含む案を断るときの文言**(`V20-M15-T01B`。
 * 計画 §10-2 の逐語 / `ADR-0479` §Decision 4-2 / `D-V20-64` の残すもの2)。 選んだ記録は画面が適用のときに自動で
 * 足すので、案の中に書くと二重になる。
 */
export const COMPARE_CHOICE_REASON =
  "選んだ記録(remember_design の design_memory.choice)は見比べの案に書けません。" +
  "選んだ記録は、見比べの画面で案を選んで適用したときに自動で残ります。" +
  "型を変えたいときは design_memory.patterns だけを書いてください。";

/**
 * **型の無いアプリで `off_pattern: true` を断るときの文言**(`V20-M15-T01B`。計画 §9-3-5 の逐語 / §10-1 の U3 /
 * `ADR-0479` §Decision 4-1)。 型が無いのに「このアプリの型と違う」の印が出るのを止める。
 */
export const COMPARE_NO_PATTERN_MESSAGE =
  "このアプリには型(design_memory.patterns)がありません。off_pattern を外してください。";

/** 4案目を断るときの文言の頭(`D-V20-47`)。 */
export const COMPARE_FULL_REASON_HEAD = "見比べは3案までです";

const NEWLINE = /[\r\n\u2028\u2029]/;
const GROUP_PATTERN = /^pv-[0-9a-f]{32}$/;

/** `compare` の引数(zod は浅くしてあり、形はここで確かめる)。 */
export type CompareArg = {
  name?: string | undefined;
  tradeoff?: string | undefined;
  group?: string | undefined;
  /**
   * **【`V20-M15-T01B`】4本目の鍵。** zod は型を見ない(見ると `ADR-0003` §3 の形ではなく英語の検証エラーが
   * 先に返る)ので `unknown` で受け、真偽以外は {@link validateCompareShape} が `/compare/off_pattern` で返す。
   */
  off_pattern?: unknown;
};

function codePoints(value: string): number {
  return [...value].length;
}

function textError(
  path: string,
  label: string,
  value: string | undefined,
  max: number,
): ValidationError | null {
  if (value === undefined) {
    return {
      path,
      message: `必須プロパティ "${path.split("/").pop() as string}" がありません。`,
      hint: `${label}を1〜${String(max)}字(改行なし)で書いてください。`,
    };
  }
  const length = codePoints(value);
  if (length < 1 || length > max) {
    return {
      path,
      message: `${label}は1〜${String(max)}字です(今は${String(length)}字)。`,
      hint: `${label}を1〜${String(max)}字(改行なし)で書いてください。字数は1文字ずつ数えます。`,
    };
  }
  if (NEWLINE.test(value)) {
    return {
      path,
      message: `${label}に改行は書けません。`,
      hint: `${label}は1行で書いてください。`,
    };
  }
  return null;
}

/**
 * **形の検査**(計画 §9-1 / `ADR-0478` §Decision 1-1)。 `preview` 無しの `compare` と、名前・トレードオフ・
 * 束の綴りの誤りを**引数の誤り**として返す(空なら通る)。
 */
export function validateCompareShape(
  compare: CompareArg,
  preview: PreviewMode | undefined,
): ValidationError[] {
  if (preview === undefined) {
    return [
      {
        path: "/compare",
        message: "compare は preview と一緒にしか指定できません。",
        hint:
          "見比べの案は下見そのものなので、preview に real か sample を付けて呼んでください" +
          "(下見が要らないなら compare を外してください)。",
      },
    ];
  }
  const errors: ValidationError[] = [];
  const name = textError("/compare/name", "案の名前(name)", compare.name, COMPARE_NAME_MAX);
  if (name !== null) errors.push(name);
  const tradeoff = textError(
    "/compare/tradeoff",
    "トレードオフ(tradeoff)",
    compare.tradeoff,
    COMPARE_TRADEOFF_MAX,
  );
  if (tradeoff !== null) errors.push(tradeoff);
  if (compare.group !== undefined && !GROUP_PATTERN.test(compare.group)) {
    errors.push({
      path: "/compare/group",
      message: "group の綴りが違います(pv- に続く16進32桁です)。",
      hint: "1案目の応答の compare.group をそのまま渡してください。最初の案では group を省きます。",
    });
  }
  // **【`V20-M15-T01B`】`off_pattern` は省略可能な真偽**(`ADR-0479` §Decision 4-1)。
  if (compare.off_pattern !== undefined && typeof compare.off_pattern !== "boolean") {
    errors.push({
      path: "/compare/off_pattern",
      message: "off_pattern は true か false です。",
      hint:
        "このアプリの型(get_manifest の app.design_memory.patterns)から外れる案にだけ true を付けてください" +
        "(外れない案では省きます)。",
    });
  }
  return errors;
}

/**
 * **型の無いアプリの `off_pattern: true` を断る**(`V20-M15-T01B`。計画 §10-1 の U3 / `ADR-0479` §Decision 4-1)。
 * `currentPatternCount` は**本物のアプリの今の定義**の `app.design_memory.patterns` の件数(案が型を足す場合でも
 * 今の型で判定する)。 断らないなら `null`。
 */
export function offPatternError(
  offPattern: unknown,
  currentPatternCount: number,
): ValidationError | null {
  if (offPattern !== true || currentPatternCount > 0) {
    return null;
  }
  return {
    path: "/compare/off_pattern",
    message: COMPARE_NO_PATTERN_MESSAGE,
    hint:
      "型は apply_diff の remember_design(design_memory.patterns)で書けます。" +
      "型の無いアプリでは、どの案にも off_pattern を付けないでください。",
  };
}

/** 差分がデータの失われる op を1つでも含むか。 */
function hasDestructiveOp(diff: unknown): boolean {
  const operations = (diff as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations)) {
    return false;
  }
  return operations.some(
    (op) =>
      typeof op === "object" &&
      op !== null &&
      COMPARE_DESTRUCTIVE_OPS.includes(String((op as { op?: unknown }).op)),
  );
}

/**
 * **束の中の生きている案**(`V20-M14` 点検の処置 中1)。 束の `candidates` のうち、置き場に登録票(`meta.json`)と
 * 案の票(`candidate.json`)の両方が在り、期限内のものだけを、束の順のまま返す(前段の `/compare` が並べる案と
 * 同じ数え方)。 **3の枠はこれで数える** —— 同時の書き込みで束に残った実体の無い識別子で枠が塞がらない。
 * 束が無い・期限切れ・壊れていれば空。
 */
export function liveGroupCandidates(root: string, groupId: string, now?: PreviewClock): string[] {
  const group = findGroup(root, groupId, now);
  if (group === null) {
    return [];
  }
  return group.candidates.filter(
    (id) => readCandidate(root, id) !== null && findPreview(root, id, now) !== null,
  );
}

/**
 * 差分が `remember_design` の `design_memory.choice` を持つ操作を1つでも含むか(`V20-M15-T01B`)。
 * **`choice` のキーが在れば値を問わずに断る**(形の誤りは差分の検証が先に返す)。
 */
function hasChoiceOp(diff: unknown): boolean {
  const operations = (diff as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations)) {
    return false;
  }
  return operations.some((op) => {
    if (typeof op !== "object" || op === null) return false;
    const record = op as { op?: unknown; design_memory?: unknown };
    if (record.op !== "remember_design") return false;
    const memory = record.design_memory;
    return typeof memory === "object" && memory !== null && "choice" in memory;
  });
}

export type CompareAdmission = { ok: true } | { ok: false; reason: string };

/**
 * **データが失われる op の断りと束の照合**(計画 §10-2 の順)。 **下見を作る前に呼ぶ。** 束は
 * 在る・期限内・同じアプリ・同じ頼んだ人・同じ mode・3案未満。
 */
export function admitCompare(input: {
  previewRoot: string;
  appId: string;
  requesterUserId: string;
  mode: PreviewMode;
  diff: unknown;
  group: string | undefined;
  now?: PreviewClock;
}): CompareAdmission {
  if (hasDestructiveOp(input.diff)) {
    return { ok: false, reason: COMPARE_DESTRUCTIVE_REASON };
  }
  // **【`V20-M15-T01B`】選んだ記録を含む案は、データが失われる op と同じ位置で断る**(`ADR-0479` §Decision 4-2)。
  if (hasChoiceOp(input.diff)) {
    return { ok: false, reason: COMPARE_CHOICE_REASON };
  }
  if (input.group === undefined) {
    return { ok: true };
  }
  const label = input.group;
  const groupId = parsePreviewAppId(input.group) ?? "";
  const group = isGroupEntry(input.previewRoot, groupId)
    ? findGroup(input.previewRoot, groupId, input.now)
    : null;
  if (group === null) {
    return {
      ok: false,
      reason:
        `見比べの束 ${label} が見つからないか、期限(最初の案を作ってから1時間)を過ぎています。` +
        "group を省いて呼ぶと新しい束を作ります。",
    };
  }
  if (group.app_id !== input.appId) {
    return {
      ok: false,
      reason: `見比べの束 ${label} は別のアプリのものです。1つの束に入れられるのは同じアプリの案だけです。`,
    };
  }
  if (group.requester_user_id !== input.requesterUserId) {
    return {
      ok: false,
      reason: `見比べの束 ${label} は別の人が作ったものです。1つの束に入れられるのは同じ人が作った案だけです。`,
    };
  }
  if (group.mode !== input.mode) {
    return {
      ok: false,
      reason: `見比べの束 ${label} は mode が ${group.mode} の束です。1つの束に入れられるのは同じ mode の案だけです。`,
    };
  }
  // **【`V20-M14` 点検の処置 中1】枠は生きている案だけで数える**(実体の無い識別子で塞がらない)。
  if (liveGroupCandidates(input.previewRoot, groupId, input.now).length >= COMPARE_MAX_CANDIDATES) {
    return { ok: false, reason: fullReason(label) };
  }
  return { ok: true };
}

function fullReason(label: string): string {
  return (
    `${COMPARE_FULL_REASON_HEAD}(束 ${label} には既に3案あります)。` +
    "別の案を見せたいときは、group を省いて新しい束を作ってください。"
  );
}

export type AttachResult =
  | { ok: true; groupId: string; count: number }
  | { ok: false; reason: string };

/**
 * **案の票を書き、束に並べる**(計画 §10-2 の順の後半)。 下見(`meta`)は作り終えている前提。
 * **断るとき・途中で失敗したときは、自分の下見を消してから理由を返す**(束を新しく作っていれば束も消す)。
 */
export function attachCandidate(input: {
  previewRoot: string;
  meta: PreviewMeta;
  name: string;
  tradeoff: string;
  diff: unknown;
  designNotices: unknown[];
  baseManifestSha: string | null;
  group: string | undefined;
  /** 【`V20-M15-T01B`】案が型から外れるという AI の申告(省略は `false`)。 */
  offPattern?: boolean;
  now?: PreviewClock;
}): AttachResult {
  const root = input.previewRoot;
  const previewId = input.meta.preview_id;
  const refuse = (reason: string): AttachResult => {
    discardPreview(root, previewId);
    return { ok: false, reason };
  };
  if (input.baseManifestSha === null) {
    return refuse("本物のアプリのマニフェストを読めなかったため、見比べの案にしませんでした。");
  }
  const isNew = input.group === undefined;
  const groupId = isNew ? newPreviewId() : (parsePreviewAppId(input.group as string) ?? "");
  const label = previewAppId(groupId);
  let createdGroup = false;
  try {
    writeCandidate(root, previewId, {
      name: input.name,
      tradeoff: input.tradeoff,
      diff: input.diff,
      design_notices: input.designNotices,
      base_manifest_sha: input.baseManifestSha,
      group: groupId,
      off_pattern: input.offPattern === true,
    });
    if (isNew) {
      createGroup(root, groupId, {
        app_id: input.meta.app_id,
        requester_user_id: input.meta.requester_user_id,
        mode: input.meta.mode,
        created_at: input.meta.created_at,
        expires_at: input.meta.expires_at,
        candidates: [previewId],
      });
      createdGroup = true;
    }
    // **【`V20-M14` 点検の処置 中1】束への追記と数え直しは束の錠の中で行う**(別のプロセスが同じ束へ
    // 同時に足しても `group.json` の読み書きが重ならない)。 新しい束はまだ誰も識別子を知らないが、同じ形で数える。
    const outcome = withGroupLock(root, groupId, (): "missing" | "lost" | "full" | number => {
      if (!isNew && appendCandidateToGroup(root, groupId, previewId, input.now) === null) {
        return "missing";
      }
      // **数え直す**(照合の後に別の案が入って3を超えうる)。 **何番目かは生きている案(登録票と案の票が
      // 在り期限内)の中で数える** —— 実体の無い識別子で枠が塞がらないように。
      const live = liveGroupCandidates(root, groupId, input.now);
      const index = live.indexOf(previewId);
      if (index < 0 || index >= COMPARE_MAX_CANDIDATES) {
        removeCandidateFromGroup(root, groupId, previewId);
        return index < 0 ? "lost" : "full";
      }
      return live.length;
    });
    if (outcome === "missing") {
      return refuse(
        `見比べの束 ${label} が見つからないか、期限(最初の案を作ってから1時間)を過ぎています。` +
          "group を省いて呼ぶと新しい束を作ります。",
      );
    }
    if (outcome === "lost" || outcome === "full") {
      if (createdGroup) {
        removePreview(root, groupId);
      }
      return refuse(
        outcome === "lost"
          ? "見比べの束に案を並べられませんでした。もう一度呼んでください。"
          : fullReason(label),
      );
    }
    return { ok: true, groupId, count: Math.min(outcome, COMPARE_MAX_CANDIDATES) };
  } catch (error) {
    if (createdGroup) {
      removePreview(root, groupId);
    } else {
      // **【`V20-M14` 点検の処置 中1】束に自分の識別子が載ったまま投げたときも、束から取り除く**
      // (下見を消すので、残すと実体の無い識別子になる)。 取り除く途中の失敗は握りつぶす(断りは下で返す)。
      try {
        withGroupLock(root, groupId, () => removeCandidateFromGroup(root, groupId, previewId));
      } catch {
        // 何もしない
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(`見比べの案を登録できなかったため、下見を消しました(${detail})。`);
  }
}
