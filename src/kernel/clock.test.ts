import { describe, expect, test } from "bun:test";
import { type Clock, DEFAULT_TIME_ZONE, resolveTimeZone, systemClock, zonedNow } from "./clock.ts";

/**
 * 時刻源(V1-M2-T08 単位1)の検査。
 *
 * **ここで検証しているのは T08 完了条件の (1)(2) と、`schedule` の発火判定が
 * 必要とする「その TZ での日付境界」である**(ADR-0013 §6c が発火済み判定を
 * 「履歴を『今日発火したか』で読む」と定めたため、日付は必ず TZ 付きで出す)。
 *
 * **実時間を待つテストを1つも書かない**(計画 §2-8 の検証方法)。時刻は
 * すべて `Clock` の差し替えで与える。
 */

/** テスト用の固定時刻源。**本番には置かない**(置くとテスト専用コードが本番に残る)。 */
function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

describe("Clock(完了条件1: 注入可能で、テストから時刻を進められる)", () => {
  test("固定時刻を与えると、その時刻がそのまま読める", () => {
    const clock = clockAt("2026-07-20T15:30:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-07-20T15:30:00.000Z");
  });

  test("時刻を進められる(同じ時刻源が2回目に別の時刻を返せる)", () => {
    let current = new Date("2026-07-20T00:00:00.000Z");
    const clock: Clock = { now: () => current };

    const before = zonedNow(clock, "Asia/Tokyo");
    current = new Date(current.getTime() + 6 * 60 * 60 * 1000);
    const after = zonedNow(clock, "Asia/Tokyo");

    expect(before.hour).toBe(9);
    expect(after.hour).toBe(15);
    // **日付は変わらない。**進めたのは同じ日の中である。
    expect(before.date).toBe(after.date);
  });
});

describe("systemClock(完了条件2: 本番の既定は実時刻)", () => {
  test("実時刻を返す(実時間を待たずに、実時刻との近さだけを見る)", () => {
    const before = Date.now();
    const observed = systemClock.now().getTime();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  test("呼ぶたびに新しい Date を返す(1つの Date を使い回して固まらない)", () => {
    const first = systemClock.now();
    const second = systemClock.now();
    expect(second).not.toBe(first);
  });
});

describe("resolveTimeZone(判断1: ST_TIMEZONE、既定 Asia/Tokyo)", () => {
  test("未設定なら既定の Asia/Tokyo になる", () => {
    expect(DEFAULT_TIME_ZONE).toBe("Asia/Tokyo");
    expect(resolveTimeZone(undefined)).toEqual({ ok: true, timeZone: "Asia/Tokyo" });
  });

  test("空文字・空白だけの指定も「未設定」として扱う", () => {
    expect(resolveTimeZone("")).toEqual({ ok: true, timeZone: "Asia/Tokyo" });
    expect(resolveTimeZone("   ")).toEqual({ ok: true, timeZone: "Asia/Tokyo" });
  });

  test("妥当な IANA 名はそのまま採る", () => {
    expect(resolveTimeZone("UTC")).toEqual({ ok: true, timeZone: "UTC" });
    expect(resolveTimeZone("America/New_York")).toEqual({
      ok: true,
      timeZone: "America/New_York",
    });
  });

  test("前後の空白は落とす", () => {
    expect(resolveTimeZone("  UTC  ")).toEqual({ ok: true, timeZone: "UTC" });
  });

  test("綴りの揺れは Intl の正規形に直して返す(以後の比較が綴りでぶれない)", () => {
    // **実測**: `Intl.DateTimeFormat` は "asia/tokyo" を受理し、
    // `resolvedOptions().timeZone` で "Asia/Tokyo" を返す。
    const result = resolveTimeZone("asia/tokyo");
    expect(result).toEqual({ ok: true, timeZone: "Asia/Tokyo" });
  });

  test("不正な TZ 名は握りつぶさず失敗を返す(既定に静かに落ちない)", () => {
    const result = resolveTimeZone("Asia/Tokio");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    // **何が悪くて、どこで直せばいいかが1往復で分かること。**
    expect(result.message).toContain("Asia/Tokio");
    expect(result.message).toContain("ST_TIMEZONE");
    expect(result.message).toContain(DEFAULT_TIME_ZONE);
  });

  test("不正な値でも既定にフォールバックしない(発火時刻が静かにずれるのを防ぐ)", () => {
    const result = resolveTimeZone("Not/AZone");
    expect(result).not.toEqual({ ok: true, timeZone: DEFAULT_TIME_ZONE });
    expect(result.ok).toBe(false);
  });

  test("オフセット表記(+09:00)も受け付ける —— Intl が受理する範囲をそのまま採る", () => {
    // **実測で判明**(この検査は最初「受け付けない」と書いて赤になった)。ECMA-402 は
    // 固定オフセットも時間帯識別子として認めており、`Intl` は受理して正規形に直す。
    // **こちらで追加の禁止規則を作らない** —— 固定オフセットは曖昧ではなく、
    // 「毎日 hour:minute」の意味も定まる(夏時間に追随しないだけである)。
    // **禁止すると「Intl が通すのに GP が弾く」という独自規則が1つ増える。**
    expect(resolveTimeZone("+09:00")).toEqual({ ok: true, timeZone: "+09:00" });
    expect(resolveTimeZone("+0900")).toEqual({ ok: true, timeZone: "+09:00" });
    // ただし形になっていないものは通らない。
    expect(resolveTimeZone("+9").ok).toBe(false);
  });

  test("この単位では process.exit を呼ばない(起動時に落とす判断はサーバ側の仕事)", () => {
    // 失敗は**返り値**で表現される。呼んだ側が生きていることがそのまま証拠になる。
    const result = resolveTimeZone("Nowhere/Nothing");
    expect(result.ok).toBe(false);
  });
});

describe("zonedNow(完了条件4: その TZ における今日の日付と現在の時分)", () => {
  test("同じ瞬間でも TZ ごとに日付と時分が変わる", () => {
    const clock = clockAt("2026-07-20T15:30:00.000Z");

    expect(zonedNow(clock, "UTC")).toEqual({ date: "2026-07-20", hour: 15, minute: 30 });
    // JST は +9。日付が翌日に繰り上がる。
    expect(zonedNow(clock, "Asia/Tokyo")).toEqual({ date: "2026-07-21", hour: 0, minute: 30 });
    expect(zonedNow(clock, "America/New_York")).toEqual({
      date: "2026-07-20",
      hour: 11,
      minute: 30,
    });
  });

  test("その TZ の 0 時ちょうどが hour: 0 になる(24 に化けない)", () => {
    // **`hour12: false` だけだと処理系によって 0 時が 24 になる。**
    // 「毎日 0:00 に発火」がまるごと落ちる壊れ方なので、明示的に固定する。
    const clock = clockAt("2026-07-19T15:00:00.000Z"); // = 2026-07-20T00:00 JST
    expect(zonedNow(clock, "Asia/Tokyo")).toEqual({ date: "2026-07-20", hour: 0, minute: 0 });
  });

  test("日付境界の直前と直後で「今日」が切り替わる", () => {
    const justBefore = clockAt("2026-07-19T14:59:00.000Z"); // 2026-07-19 23:59 JST
    const justAfter = clockAt("2026-07-19T15:00:00.000Z"); // 2026-07-20 00:00 JST

    expect(zonedNow(justBefore, "Asia/Tokyo").date).toBe("2026-07-19");
    expect(zonedNow(justAfter, "Asia/Tokyo").date).toBe("2026-07-20");
  });

  test("日付は必ず YYYY-MM-DD の10文字である(月日が1桁でも 0 詰めされる)", () => {
    const clock = clockAt("2026-01-04T00:00:00.000Z");
    const zoned = zonedNow(clock, "UTC");
    expect(zoned.date).toBe("2026-01-04");
    expect(zoned.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("夏時間のある TZ でも、その地域の壁時計を返す", () => {
    // ニューヨークは 7月が EDT(-4)、1月が EST(-5)。同じ UTC 16:00 が別の時刻になる。
    expect(zonedNow(clockAt("2026-07-20T16:00:00.000Z"), "America/New_York").hour).toBe(12);
    expect(zonedNow(clockAt("2026-01-20T16:00:00.000Z"), "America/New_York").hour).toBe(11);
  });

  test("hour / minute は文字列ではなく数値である(比較が綴りでぶれない)", () => {
    const zoned = zonedNow(clockAt("2026-07-20T00:05:00.000Z"), "UTC");
    expect(typeof zoned.hour).toBe("number");
    expect(typeof zoned.minute).toBe("number");
    expect(zoned.hour).toBe(0);
    expect(zoned.minute).toBe(5);
  });

  test("注入していない systemClock でも同じ形の結果を返す(本番経路が別物にならない)", () => {
    const zoned = zonedNow(systemClock, DEFAULT_TIME_ZONE);
    expect(zoned.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(zoned.hour).toBeGreaterThanOrEqual(0);
    expect(zoned.hour).toBeLessThanOrEqual(23);
    expect(zoned.minute).toBeGreaterThanOrEqual(0);
    expect(zoned.minute).toBeLessThanOrEqual(59);
  });
});
