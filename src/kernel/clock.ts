/**
 * 時刻源(V1-M2-T08 単位1。ADR-0013 §6d が「形は T08 が決める」と委任した対象)。
 *
 * ## なぜ要るのか
 *
 * `schedule` トリガー(毎日 hour:minute に1回発火)は、**時刻を注入して進めることでしか
 * 検証できない**(計画 `docs/plan/v1/02-workflow.md:165`)。実時間を待つテストは書かない。
 * そのために「今が何時か」を1箇所に集め、そこだけ差し替え可能にする。
 *
 * ## この口はテスト専用の分岐ではない
 *
 * **本番の既定は `systemClock`(実時刻)であり、注入していない経路に分岐は1つも無い。**
 * `Clock` は引数として渡すか、`workflow-runner.ts` の set/reset 対で差し替える
 * (T02 の `setWorkflowHistoryFailureHandler` と同じ作法)。**挙動を変える口ではなく、
 * 観測/注入のための口である。**
 *
 * ## タイムゾーン(V1-M2-T08 判断1)
 *
 * **`schedule` の「毎日 hour:minute」は、どこかの TZ の壁時計を指していないと意味が決まらない。**
 * さらに ADR-0013 §6c が発火済み判定を「履歴を『**今日**発火したか』で読む」と定めたので、
 * **「今日」の境界もその TZ で決まる。**
 *
 * TZ は環境変数 `ST_TIMEZONE`、既定は `Asia/Tokyo`。**マニフェストにもスキーマにも足さない**
 * —— 足すと `manifest.schema.json` にキーが増えて Δ3(門A)が発火する。
 * `ST_DATA_ROOT` / `PORT`(`src/server/index.ts:16-17`)の前例に揃えた。
 *
 * **不正な TZ 値は握りつぶさない。**黙って `Asia/Tokyo` に落とすと**発火時刻が静かにずれる**
 * ので、憲法6 に正面から反する。ただし**このモジュールは `process.exit` を呼ばない** ——
 * 起動時に落とすかどうかはサーバ側の判断であり、ここは**検証して失敗を返すだけ**である。
 */

/**
 * 時刻源。**メソッドは1つだけである。**
 *
 * TZ の解釈を含めないのは、`Date` が「絶対的な瞬間」であって壁時計ではないからである。
 * 壁時計への変換は `zonedNow` が担う —— **差し替える面を最小に保つと、注入した時刻源が
 * 本番と違う挙動をする余地が無くなる。**
 */
export type Clock = {
  /** 現在の瞬間。**呼ぶたびに新しい `Date` を返すこと**(1つを使い回すと時刻が固まる)。 */
  now(): Date;
};

/**
 * 本番の既定の時刻源。実時刻を返す。
 *
 * **注入していない経路はすべてこれを通る**(T08 完了条件2)。
 */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** `ST_TIMEZONE` が未設定のときのタイムゾーン(判断1)。 */
export const DEFAULT_TIME_ZONE = "Asia/Tokyo";

/** タイムゾーン解決の結果。**失敗を投げずに返す**(呼んだ側が落とし方を決める)。 */
export type TimeZoneResolution = { ok: true; timeZone: string } | { ok: false; message: string };

/**
 * `ST_TIMEZONE` の値を解決する。
 *
 * - 未設定・空白のみ → 既定の `Asia/Tokyo`
 * - 妥当な IANA 名 → `Intl` の正規形(綴りの揺れを吸収する。"asia/tokyo" → "Asia/Tokyo")
 * - 固定オフセット → **受理する**(ECMA-402 が時間帯識別子として認めている。"+0900" → "+09:00")
 * - それ以外 → **失敗を返す。既定にフォールバックしない**
 *
 * **`Intl` が受理する範囲をそのまま採り、こちらで追加の禁止規則を作らない。**
 * 独自規則を足すと「`Intl` が通すのに GP が弾く」ものが増え、覚える規則が1つ増える。
 *
 * **`process.exit` を呼ばない。**起動時に落とす判断はサーバ側(単位2)の仕事である。
 *
 * 妥当性の判定は `Intl.DateTimeFormat` に委ねている —— **実測**(bun 1.3.14): 不正な
 * タイムゾーン名では `RangeError` が投げられ、受理された名前は `resolvedOptions().timeZone`
 * で正規形が読める。**IANA のリストをこのリポジトリに抱え込まない**(抱え込むと、
 * 実行環境の tzdata が更新されたときに静かに食い違う)。
 */
export function resolveTimeZone(raw: string | undefined): TimeZoneResolution {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return { ok: true, timeZone: DEFAULT_TIME_ZONE };
  }

  try {
    // 受理されれば正規形を採る。**入力の綴りをそのまま持ち回さない** ——
    // 以後の比較やログが綴りでぶれるのを、入口の1箇所で止める。
    return {
      ok: true,
      timeZone: new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone,
    };
  } catch {
    return {
      ok: false,
      message:
        `タイムゾーン "${trimmed}" は認識できません。` +
        `環境変数 ST_TIMEZONE には IANA タイムゾーン名(例: ${DEFAULT_TIME_ZONE} / UTC / America/New_York)` +
        `または固定オフセット(例: +09:00)を指定してください。` +
        `未設定なら既定の ${DEFAULT_TIME_ZONE} になります。`,
    };
  }
}

/** ある瞬間を、あるタイムゾーンの壁時計で読んだもの。 */
export type ZonedNow = {
  /** その TZ における「今日」。`YYYY-MM-DD` の10文字。 */
  date: string;
  /** その TZ における時(0-23)。 */
  hour: number;
  /** その TZ における分(0-59)。 */
  minute: number;
};

/**
 * 時刻源の現在時刻を、指定タイムゾーンの壁時計として読む。
 *
 * `schedule` の判定に必要なものはこれで尽きている —— **`hour`/`minute` が「発火時刻に
 * 到達したか」を、`date` が ADR-0013 §6c の「今日すでに発火したか」を決める。**
 *
 * `timeZone` は `resolveTimeZone` を通した値であること。**不正な名前を渡すと
 * `RangeError` が投げられる**(握りつぶさない。ここに来る時点で設定は検証済みのはずで、
 * 検証されていないなら、それはプログラムの誤りである)。
 */
export function zonedNow(clock: Clock, timeZone: string): ZonedNow {
  // **`hourCycle: "h23"` を明示する。**`hour12: false` だけだと処理系によっては
  // 0 時が "24" になり、「毎日 0:00 に発火」がまるごと落ちる。
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(clock.now());

  const find = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      // 到達しない想定。**黙って 0 を返さない** —— 日付が静かにずれるより落ちる方がよい。
      throw new Error(`タイムゾーン "${timeZone}" の時刻から ${type} を読み取れませんでした`);
    }
    return part.value;
  };

  return {
    date: `${find("year")}-${find("month")}-${find("day")}`,
    hour: Number(find("hour")),
    minute: Number(find("minute")),
  };
}
