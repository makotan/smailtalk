import { describe, expect, test } from "bun:test";
import { startupNoticeLines } from "./startup-notice.ts";

/** 既定の期待 origin(`src/auth/config.ts` の `DEFAULTS.expectedOrigin` を分解した形)。 */
const DEFAULT_ORIGINS = ["http://localhost:3000", "http://localhost:5173"];

describe("startupNoticeLines", () => {
  test("既定(3000 で待ち受け・既定の期待 origin)では、開くアドレスの案内だけが出る", () => {
    const notice = startupNoticeLines({ port: 3000, expectedOrigins: DEFAULT_ORIGINS });

    // **`127.0.0.1` ではなく `localhost` を出す。**起動ログの URL をそのまま開くと
    // 画面は出るのに保存だけが 403 になる、というのがこの案内を足した理由である。
    expect(notice.info).toContain("http://localhost:3000");
    expect(notice.info).toContain("127.0.0.1");
    // 既定は合っているので警告は出ない(出したら狼少年になる)。
    expect(notice.warning).toBeUndefined();
  });

  test("ST_AUTH_EXPECTED_ORIGIN を別の値にすると、保存が 403 になることを警告する", () => {
    const notice = startupNoticeLines({
      port: 3000,
      expectedOrigins: ["https://example.com"],
    });

    expect(notice.warning).toBeDefined();
    const warning = notice.warning ?? "";
    // 既存の警告に倣った接頭辞(`index.ts:108` などが先例)。
    expect(warning.startsWith("[smailtalk server] ")).toBe(true);
    // 何が許可されているか。
    expect(warning).toContain("https://example.com");
    // その画面からの保存がどうなるか。
    expect(warning).toContain("403");
    // どう直すか。
    expect(warning).toContain("ST_AUTH_EXPECTED_ORIGIN");
    expect(warning).toContain("http://localhost:3000");
  });

  test("ポートを変えると、案内も警告も待ち受けた番号で出る(番号を焼き込まない)", () => {
    const notice = startupNoticeLines({ port: 4321, expectedOrigins: DEFAULT_ORIGINS });

    expect(notice.info).toContain("http://localhost:4321");
    expect(notice.info).not.toContain("http://localhost:3000");
    expect(notice.warning ?? "").toContain("http://localhost:4321");
  });

  test("ポートを変えても、期待 origin をそれに合わせてあれば警告は出ない", () => {
    const notice = startupNoticeLines({
      port: 4321,
      expectedOrigins: ["http://localhost:4321"],
    });

    expect(notice.warning).toBeUndefined();
  });

  test("期待 origin が1本も無ければ警告する(空の並びで黙らない)", () => {
    const notice = startupNoticeLines({ port: 3000, expectedOrigins: [] });

    expect(notice.warning).toBeDefined();
  });

  // --- 他の台を壊さないための制約(**この2つは実測で固定する**)-------------------
  //
  // (1) `src/server/index.test.ts:354,369,402,432` が「起動しなかったこと」を
  //     `expect(started.stdout).not.toContain("smailtalk server:")` で見ている。
  // (2) 別の単位の駆動(`http-driver-kernel.ts:130`)が待ち受けた番号を
  //     `/smailtalk server: http:\/\/([^:\s]+):(\d+)/` で読んでいる
  //     (**その単位の名前は写さない。**`tools/standalone-scope.test.ts` が
  //     公開単位の中にその綴りが1件も無いことを見張っている)。
  //
  // **足した行がどちらかに当たると、緑のまま別の台が壊れる。**

  /** `http-driver-kernel.ts` が待ち受け番号を読む式(**逐語で写した**)。 */
  const LISTEN_PATTERN = /smailtalk server: http:\/\/([^:\s]+):(\d+)/;

  test("足す行は `smailtalk server:` を1文字も含まず、待ち受け番号の式にも当たらない", () => {
    const samples = [
      startupNoticeLines({ port: 3000, expectedOrigins: DEFAULT_ORIGINS }),
      startupNoticeLines({ port: 4321, expectedOrigins: ["https://example.com"] }),
      startupNoticeLines({ port: 8080, expectedOrigins: [] }),
    ];

    for (const notice of samples) {
      for (const line of [notice.info, notice.warning ?? ""]) {
        expect(line).not.toContain("smailtalk server:");
        expect(LISTEN_PATTERN.test(line)).toBe(false);
      }
    }
  });
});
