/**
 * 下見の置き場(`V20-M13-T01`。計画 §9-2・§10-5・§10-10 の2 / `ADR-0476`)の検査。
 *
 * **固定するもの**: 置き場の根の既定と環境変数 / 識別子の綴り(128ビット・16進32桁・
 * アプリID の許される綴りに収まる)/ 登録・引き・消す・期限切れを全部消す / 期限 3600 秒の
 * 境界(時計を注入して前後を撃つ)/ 個数の上限 20(超えたら断り、古いものを消さない)/
 * 大きさの上限(本体の `app.sqlite` が 100MB を超えたら作らない)/ 置き場は `0700`。
 *
 * **置き場は必ずこの検査の一時ディレクトリの下に作り、自分で片付ける**(共通の約束)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isValidResourceId } from "../kernel/resource-id.ts";
import {
  appendCandidateToGroup,
  COMPARE_MAX_CANDIDATES,
  commitPreview,
  createGroup,
  defaultPreviewRoot,
  discardPreview,
  findGroup,
  findPreview,
  isGroupEntry,
  manifestSha256,
  newPreviewId,
  PREVIEW_CANDIDATE_FILE,
  PREVIEW_ENTRY_MARKER_FILE,
  PREVIEW_GROUP_FILE,
  PREVIEW_GROUP_LOCK_FILE,
  PREVIEW_MAX_APP_DB_BYTES,
  PREVIEW_MAX_ENTRIES,
  PREVIEW_META_FILE,
  PREVIEW_TTL_SECONDS,
  type PreviewCandidate,
  type PreviewMeta,
  parsePreviewAppId,
  previewAppId,
  purgeExpiredPreviews,
  purgePreviewIfStale,
  readCandidate,
  removeCandidateFromGroup,
  removePreview,
  reservePreview,
  resolvePreviewRoot,
  withGroupLock,
  writeCandidate,
} from "./preview-store.ts";

const APP_ID = "book-tracker";
const T0 = new Date("2026-09-26T00:00:00.000Z");

let work = "";
let dataRoot = "";
let root = "";

function at(offsetSec: number): () => Date {
  return () => new Date(T0.getTime() + offsetSec * 1000);
}

/** 本体のアプリの3点のうち、大きさの判定に使う `app.sqlite` だけを置く。 */
function seedAppDb(bytes = 4096): void {
  const dir = join(dataRoot, "apps", APP_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.sqlite"), "");
  truncateSync(join(dir, "app.sqlite"), bytes);
}

/** 予約 → 登録までを1回。返すのは識別子。 */
function register(clock: () => Date, mode: "real" | "sample" = "real"): string {
  const reserved = reservePreview({ root, dataRoot, appId: APP_ID, now: clock });
  if (!reserved.ok) {
    throw new Error(`予約できなかった: ${reserved.reason}`);
  }
  const shadow = join(reserved.dir, "gp-dry-run-x", "data");
  mkdirSync(shadow, { recursive: true });
  commitPreview(root, reserved.id, {
    app_id: APP_ID,
    requester_user_id: "u-1",
    mode,
    shadow_data_root: shadow,
    session_id: "s-1",
    now: clock,
  });
  return reserved.id;
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-preview-store-"));
  dataRoot = join(work, "data");
  root = join(work, "previews");
  mkdirSync(dataRoot, { recursive: true });
  seedAppDb();
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("置き場の根", () => {
  test("既定は `<resolve(dataRoot)>.previews`(dataRoot の外・隣)", () => {
    expect(defaultPreviewRoot(dataRoot)).toBe(`${resolve(dataRoot)}.previews`);
    expect(defaultPreviewRoot("data")).toBe(`${resolve("data")}.previews`);
    expect(resolvePreviewRoot(dataRoot, {})).toBe(`${resolve(dataRoot)}.previews`);
  });

  test("ST_PREVIEW_ROOT があればそれ(絶対パスに直す)。空白だけは無いものとして扱う", () => {
    expect(resolvePreviewRoot(dataRoot, { ST_PREVIEW_ROOT: root })).toBe(root);
    expect(resolvePreviewRoot(dataRoot, { ST_PREVIEW_ROOT: "rel/pv" })).toBe(resolve("rel/pv"));
    expect(resolvePreviewRoot(dataRoot, { ST_PREVIEW_ROOT: "  " })).toBe(
      `${resolve(dataRoot)}.previews`,
    );
  });

  test("予約すると根と置き場が 0700 で作られる", () => {
    const reserved = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(reserved.dir).mode & 0o777).toBe(0o700);
    expect(reserved.dir).toBe(join(root, reserved.id));
    expect(isAbsolute(reserved.dir)).toBe(true);
  });
});

describe("識別子の綴り", () => {
  test("16進32桁(128ビット)で、呼ぶたびに違う", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = newPreviewId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  test("URL 上のアプリID は `pv-<識別子>` で、アプリID の許される綴りに収まる", () => {
    const id = newPreviewId();
    const appId = previewAppId(id);
    expect(appId).toBe(`pv-${id}`);
    expect(appId).toMatch(/^pv-[0-9a-f]{32}$/);
    expect(isValidResourceId(appId)).toBe(true);
    expect(parsePreviewAppId(appId)).toBe(id);
  });

  test("形の違う綴りは下見のアプリID として読まない(陰性対照)", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(parsePreviewAppId(`pv-${id}`)).toBe(id);
    for (const bad of [
      id,
      `pv-${id.slice(1)}`,
      `pv-${id}0`,
      `pv-${id.toUpperCase()}`,
      `pv-${id.slice(1)}g`,
      `px-${id}`,
      "pv-../../etc",
      "",
    ]) {
      expect(parsePreviewAppId(bad)).toBeNull();
    }
  });
});

describe("登録と引き", () => {
  test("登録した meta.json に6項目と絶対パスが入り、期限は作った時刻から 3600 秒", () => {
    expect(PREVIEW_TTL_SECONDS).toBe(3600);
    const id = register(at(0), "sample");
    const meta = findPreview(root, id, at(1)) as PreviewMeta;
    expect(meta).not.toBeNull();
    expect(meta.preview_id).toBe(id);
    expect(meta.app_id).toBe(APP_ID);
    expect(meta.requester_user_id).toBe("u-1");
    expect(meta.mode).toBe("sample");
    expect(meta.created_at).toBe(T0.toISOString());
    expect(meta.expires_at).toBe(new Date(T0.getTime() + 3600 * 1000).toISOString());
    expect(isAbsolute(meta.shadow_data_root)).toBe(true);
    expect(meta.session_id).toBe("s-1");
    const onDisk = JSON.parse(readFileSync(join(root, id, "meta.json"), "utf-8"));
    expect(onDisk).toEqual(meta);
    expect(statSync(join(root, id, "meta.json")).mode & 0o777).toBe(0o600);
  });

  test("期限の直前は引け、期限ちょうどと後は無しとして扱う(時計を注入して前後を撃つ)", () => {
    const id = register(at(0));
    expect(findPreview(root, id, at(3599))).not.toBeNull();
    expect(findPreview(root, id, at(3600))).toBeNull();
    expect(findPreview(root, id, at(7200))).toBeNull();
  });

  test("meta.json が無い・壊れている・形が違う・識別子の綴りが違う → 無し", () => {
    const reserved = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    if (!reserved.ok) throw new Error("予約できなかった");
    expect(findPreview(root, reserved.id, at(0))).toBeNull(); // meta 無し
    writeFileSync(join(reserved.dir, "meta.json"), "{ 壊れた");
    expect(findPreview(root, reserved.id, at(0))).toBeNull();
    writeFileSync(join(reserved.dir, "meta.json"), JSON.stringify({ app_id: APP_ID }));
    expect(findPreview(root, reserved.id, at(0))).toBeNull();
    expect(findPreview(root, "../previews", at(0))).toBeNull();
    expect(findPreview(root, "0123456789abcdef0123456789abcdef", at(0))).toBeNull();
  });

  test("1つ消すと引けなくなり、置き場ごと無くなる。他は残る", () => {
    const a = register(at(0));
    const b = register(at(0));
    removePreview(root, a);
    expect(existsSync(join(root, a))).toBe(false);
    expect(findPreview(root, a, at(1))).toBeNull();
    expect(findPreview(root, b, at(1))).not.toBeNull();
    // 綴りの違う識別子では根の外を消さない。
    removePreview(root, "..");
    expect(existsSync(root)).toBe(true);
  });

  test("予約を取り消すと置き場が消える(登録の途中で失敗したときの後始末)", () => {
    const reserved = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    if (!reserved.ok) throw new Error("予約できなかった");
    discardPreview(root, reserved.id);
    expect(existsSync(reserved.dir)).toBe(false);
  });
});

describe("期限切れを全部消す", () => {
  test("期限切れだけを消し、期限前は残す", () => {
    const old = register(at(0));
    const fresh = register(at(3000));
    const removed = purgeExpiredPreviews(root, at(3600));
    expect(removed).toEqual([old]);
    expect(existsSync(join(root, old))).toBe(false);
    expect(existsSync(join(root, fresh))).toBe(true);
  });

  test("壊れた meta と、期限を過ぎた meta 無しの置き場も消す。作ったばかりの meta 無しは残す", () => {
    const broken = register(at(0));
    writeFileSync(join(root, broken, "meta.json"), "{");
    const pending = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    if (!pending.ok) throw new Error("予約できなかった");
    // 作ったばかり(時計は今)の meta 無しは、作っている途中かもしれないので残す。
    purgeExpiredPreviews(root, () => new Date());
    expect(existsSync(pending.dir)).toBe(true);
    expect(existsSync(join(root, broken))).toBe(false);
    // 期限を過ぎた meta 無しは消す。
    purgeExpiredPreviews(root, () => new Date(Date.now() + (PREVIEW_TTL_SECONDS + 1) * 1000));
    expect(existsSync(pending.dir)).toBe(false);
  });

  test("根が無くても落ちない", () => {
    expect(purgeExpiredPreviews(join(work, "none"), at(0))).toEqual([]);
  });
});

describe("下見が作ったもの以外は消さない(`V20-M13` 点検の処置 中1)", () => {
  test("予約した置き場には目印のファイルが在る", () => {
    expect(PREVIEW_ENTRY_MARKER_FILE).toBe(".smailtalk-preview");
    const reserved = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    if (!reserved.ok) throw new Error(reserved.reason);
    expect(existsSync(join(reserved.dir, PREVIEW_ENTRY_MARKER_FILE))).toBe(true);
  });

  test("16進32桁の名前でも、目印も meta.json も無い古いディレクトリ(中にファイル)は消さない", () => {
    const foreign = "0123456789abcdef0123456789abcdef";
    mkdirSync(join(root, foreign), { recursive: true });
    writeFileSync(join(root, foreign, "important.txt"), "他人のデータ");
    const old = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(join(root, foreign), old, old);
    mkdirSync(join(root, "other"));
    const removed = purgeExpiredPreviews(root, () => new Date("2026-09-26T00:00:00.000Z"));
    expect(removed).toEqual([]);
    expect(readFileSync(join(root, foreign, "important.txt"), "utf-8")).toBe("他人のデータ");
    expect(existsSync(join(root, "other"))).toBe(true);
  });

  test("目印の無い、壊れた meta.json を持つ16進32桁のディレクトリも消さない", () => {
    const foreign = "fedcba9876543210fedcba9876543210";
    mkdirSync(join(root, foreign), { recursive: true });
    writeFileSync(join(root, foreign, "meta.json"), "{ not ours");
    expect(purgeExpiredPreviews(root, at(99999))).toEqual([]);
    expect(existsSync(join(root, foreign, "meta.json"))).toBe(true);
  });

  test("陽性対照: 目印つきで meta.json の無い置き場は、期限を過ぎれば消える", () => {
    const pending = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    if (!pending.ok) throw new Error(pending.reason);
    const old = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(pending.dir, old, old);
    expect(purgeExpiredPreviews(root, () => new Date("2026-09-26T00:00:00.000Z"))).toEqual([
      pending.id,
    ]);
    expect(existsSync(pending.dir)).toBe(false);
  });

  test("陽性対照: 目印つきで期限切れの置き場は消える", () => {
    const expired = register(at(0));
    expect(purgeExpiredPreviews(root, at(PREVIEW_TTL_SECONDS))).toEqual([expired]);
  });
});

describe("上限の数え直し(`V20-M13` 点検の処置 軽8)", () => {
  test("数えてから作るまでの間に他が作って上限を超えたら、自分の置き場を消して断る", () => {
    for (let i = 0; i < PREVIEW_MAX_ENTRIES - 1; i += 1) {
      register(at(i));
    }
    let intruder = "";
    const raced = reservePreview({
      root,
      dataRoot,
      appId: APP_ID,
      now: at(30),
      // 数えた直後に、別のプロセスが1つ作った(20個目)。
      afterCount: () => {
        intruder = register(at(30));
      },
    });
    expect(raced.ok).toBe(false);
    if (raced.ok) return;
    expect(raced.reason).toContain(String(PREVIEW_MAX_ENTRIES));
    const left = readdirSync(root);
    expect(left).toHaveLength(PREVIEW_MAX_ENTRIES);
    expect(left).toContain(intruder);
  });

  test("陰性対照: 割り込みが無ければ20個目は作れる", () => {
    for (let i = 0; i < PREVIEW_MAX_ENTRIES - 1; i += 1) {
      register(at(i));
    }
    const twentieth = reservePreview({
      root,
      dataRoot,
      appId: APP_ID,
      now: at(30),
      afterCount: () => {},
    });
    expect(twentieth.ok).toBe(true);
    expect(readdirSync(root)).toHaveLength(PREVIEW_MAX_ENTRIES);
  });
});

describe("上限", () => {
  test(`個数の上限 ${PREVIEW_MAX_ENTRIES} を超えたら新しい登録を断って理由を返し、古いものは消さない`, () => {
    expect(PREVIEW_MAX_ENTRIES).toBe(20);
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(register(at(i)));
    }
    const refused = reservePreview({ root, dataRoot, appId: APP_ID, now: at(30) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("20");
    // 古いものを1つも消していない。
    for (const id of ids) {
      expect(findPreview(root, id, at(30))).not.toBeNull();
    }
    expect(readdirSync(root).sort()).toEqual([...ids].sort());
  });

  test("期限切れが出れば、予約のときに消えて空きができる", () => {
    for (let i = 0; i < 20; i += 1) {
      register(at(0));
    }
    const later = reservePreview({ root, dataRoot, appId: APP_ID, now: at(3600) });
    expect(later.ok).toBe(true);
    expect(readdirSync(root)).toHaveLength(1);
  });

  test("本体の app.sqlite が 100MB を超えるアプリでは作らず理由を返す(ちょうど 100MB は作る)", () => {
    expect(PREVIEW_MAX_APP_DB_BYTES).toBe(100 * 1024 * 1024);
    seedAppDb(PREVIEW_MAX_APP_DB_BYTES);
    const exact = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    expect(exact.ok).toBe(true);
    if (exact.ok) discardPreview(root, exact.id);

    seedAppDb(PREVIEW_MAX_APP_DB_BYTES + 1);
    const refused = reservePreview({ root, dataRoot, appId: APP_ID, now: at(0) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain("100");
    // 断ったときは置き場を1つも作らない。
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// **V20-M14-T01A 束(見比べ)の登録と案**(計画 `16-v20-m14-plan.md` §9-1・§10-2 / `ADR-0478` §Decision 1-3・1-6・1-9)
// ---------------------------------------------------------------------------

/** 束を1つ作る(最初の案の期限をそのまま使う)。返すのは束の識別子。 */
function makeGroup(
  clock: () => Date,
  candidates: string[],
  mode: "real" | "sample" = "real",
): string {
  const id = newPreviewId();
  const created = clock();
  createGroup(root, id, {
    app_id: APP_ID,
    requester_user_id: "u-1",
    mode,
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
    candidates,
  });
  return id;
}

function candidateOf(group: string): PreviewCandidate {
  return {
    name: "案A",
    tradeoff: "入力は速いが一覧が長くなる",
    diff: { diff_id: "d-a", intent: "一覧を見やすくしたい", operations: [] },
    design_notices: [],
    base_manifest_sha: "0".repeat(64),
    group,
    // 【`V20-M15-T01B` / `ADR-0479` §Decision 4-4】票の7キー目。 旧は group までの6キー。
    off_pattern: false,
  };
}

describe("束の登録(group.json)", () => {
  test("束は目印と group.json(0600)を持ち、meta.json を持たない。置き場は 0700。キーは7つちょうど", () => {
    const first = register(at(0));
    const id = makeGroup(at(0), [first]);
    const dir = join(root, id);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, PREVIEW_ENTRY_MARKER_FILE))).toBe(true);
    expect(existsSync(join(dir, PREVIEW_META_FILE))).toBe(false);
    expect(statSync(join(dir, PREVIEW_GROUP_FILE)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(join(dir, PREVIEW_GROUP_FILE), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(saved).sort()).toEqual([
      "app_id",
      "candidates",
      "created_at",
      "expires_at",
      "group_id",
      "mode",
      "requester_user_id",
    ]);
    expect(saved.group_id).toBe(id);
    expect(saved.candidates).toEqual([first]);
    expect(isGroupEntry(root, id)).toBe(true);
    // 陰性対照: 案(下見)の置き場は束ではない。
    expect(isGroupEntry(root, first)).toBe(false);
    // 束は下見として引けない(meta.json が無い)。
    expect(findPreview(root, id, at(1))).toBeNull();
    // 一時の名前(.tmp-…)の置き場を残さない。
    expect(readdirSync(root).sort()).toEqual([first, id].sort());
  });

  test("期限の直前は引け、期限ちょうどと後は無し。壊れた group.json も無し", () => {
    const id = makeGroup(at(0), [register(at(0))]);
    expect(findGroup(root, id, at(PREVIEW_TTL_SECONDS - 1))?.group_id).toBe(id);
    expect(findGroup(root, id, at(PREVIEW_TTL_SECONDS))).toBeNull();
    writeFileSync(join(root, id, PREVIEW_GROUP_FILE), "{壊れた", "utf-8");
    expect(findGroup(root, id, at(1))).toBeNull();
    expect(findGroup(root, "not-hex", at(1))).toBeNull();
  });

  test("案を足すと作った順に並ぶ。期限切れ・無い束には足せない(null)", () => {
    const a = register(at(0));
    const id = makeGroup(at(0), [a]);
    const b = register(at(10));
    const c = register(at(20));
    expect(appendCandidateToGroup(root, id, b, at(10))?.candidates).toEqual([a, b]);
    expect(appendCandidateToGroup(root, id, c, at(20))?.candidates).toEqual([a, b, c]);
    expect(findGroup(root, id, at(30))?.candidates).toEqual([a, b, c]);
    expect(appendCandidateToGroup(root, id, register(at(40)), at(PREVIEW_TTL_SECONDS))).toBeNull();
    expect(appendCandidateToGroup(root, newPreviewId(), a, at(1))).toBeNull();
    // 取り除く(数え直しで3を超えたときの後始末)。
    removeCandidateFromGroup(root, id, b);
    expect(findGroup(root, id, at(30))?.candidates).toEqual([a, c]);
    expect(COMPARE_MAX_CANDIDATES).toBe(3);
  });
});

describe("束の掃除は group.json の expires_at で決める(mtime を使わない)", () => {
  test("期限切れの束は消える(mtime が新しくても)", () => {
    const id = makeGroup(at(0), [register(at(0))]);
    expect(purgeExpiredPreviews(root, at(PREVIEW_TTL_SECONDS))).toContain(id);
    expect(existsSync(join(root, id))).toBe(false);
  });

  test("期限前の束は、mtime が古くても消えない", () => {
    const id = makeGroup(at(0), [register(at(0))]);
    const old = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(join(root, id), old, old);
    expect(purgeExpiredPreviews(root, at(PREVIEW_TTL_SECONDS - 1))).toEqual([]);
    expect(purgePreviewIfStale(root, id, at(PREVIEW_TTL_SECONDS - 1))).toBe(false);
    expect(existsSync(join(root, id))).toBe(true);
  });

  test("壊れた group.json の束は消える。目印の無いディレクトリは group.json が期限切れでも消さない", () => {
    const broken = makeGroup(at(0), [register(at(0))]);
    writeFileSync(join(root, broken, PREVIEW_GROUP_FILE), "{", "utf-8");
    const foreign = newPreviewId();
    mkdirSync(join(root, foreign));
    writeFileSync(
      join(root, foreign, PREVIEW_GROUP_FILE),
      JSON.stringify({ group_id: foreign, expires_at: "2000-01-01T00:00:00.000Z" }),
    );
    const removed = purgeExpiredPreviews(root, at(1));
    expect(removed).toContain(broken);
    expect(removed).not.toContain(foreign);
    expect(existsSync(join(root, foreign))).toBe(true);
  });
});

describe("上限20は写しを持つ下見だけを数える(束は数えない)", () => {
  test("下見19・束3 のとき、20個目の下見は作れ、21個目は断られる", () => {
    const ids: string[] = [];
    for (let i = 0; i < PREVIEW_MAX_ENTRIES - 1; i += 1) {
      ids.push(register(at(i)));
    }
    for (let i = 0; i < 3; i += 1) {
      makeGroup(at(0), [ids[i] as string]);
    }
    expect(readdirSync(root)).toHaveLength(PREVIEW_MAX_ENTRIES - 1 + 3);
    const twentieth = reservePreview({ root, dataRoot, appId: APP_ID, now: at(30) });
    expect(twentieth.ok).toBe(true);
    const refused = reservePreview({ root, dataRoot, appId: APP_ID, now: at(30) });
    expect(refused.ok).toBe(false);
  });
});

describe("案(candidate.json)", () => {
  // 【`V20-M15-T01B`】キーは 6 → 7(`off_pattern`)。 テスト名の「6キー」は旧のまま残す。
  test("0600 で6キーちょうど。読み戻せる。無い・壊れた → null", () => {
    const id = register(at(0));
    const group = newPreviewId();
    writeCandidate(root, id, candidateOf(group));
    const path = join(root, id, PREVIEW_CANDIDATE_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual([
      "base_manifest_sha",
      "design_notices",
      "diff",
      "group",
      "name",
      "off_pattern",
      "tradeoff",
    ]);
    expect(readCandidate(root, id)).toEqual(candidateOf(group));
    expect(existsSync(`${path}.tmp`)).toBe(false);
    writeFileSync(path, "{", "utf-8");
    expect(readCandidate(root, id)).toBeNull();
    expect(readCandidate(root, register(at(1)))).toBeNull();
  });
});

describe("本物のマニフェストの生バイトの sha256(作る側と前段の両方が呼ぶ1本)", () => {
  test("manifest.json の生バイトの sha256。1バイト変われば変わる。アプリが無ければ null", () => {
    const path = join(dataRoot, "apps", APP_ID, "manifest.json");
    writeFileSync(path, '{"app":{"id":"book-tracker"}}\n', "utf-8");
    const expected = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(manifestSha256(dataRoot, APP_ID)).toBe(expected);
    writeFileSync(path, '{"app":{"id":"book-tracker"}} \n', "utf-8");
    expect(manifestSha256(dataRoot, APP_ID)).not.toBe(expected);
    expect(manifestSha256(dataRoot, "no-such-app")).toBeNull();
  });
});

describe("束を組み立てる一時のディレクトリ `.tmp-<識別子>` の残骸(`V20-M14` 点検の処置 軽5)", () => {
  const staging = (id: string) => join(root, `.tmp-${id}`);
  const old = new Date("2026-01-01T00:00:00.000Z");
  const later = () => new Date("2026-09-26T00:00:00.000Z");

  test("目印つきで期限(1時間)を過ぎた `.tmp-<16進32桁>` は消える", () => {
    const id = newPreviewId();
    mkdirSync(staging(id), { recursive: true });
    writeFileSync(join(staging(id), PREVIEW_ENTRY_MARKER_FILE), "");
    writeFileSync(join(staging(id), PREVIEW_GROUP_FILE), "{");
    utimesSync(staging(id), old, old);
    purgeExpiredPreviews(root, later);
    expect(existsSync(staging(id))).toBe(false);
  });

  test("目印の無い `.tmp-<16進32桁>` は古くても消さない", () => {
    const id = newPreviewId();
    mkdirSync(staging(id), { recursive: true });
    writeFileSync(join(staging(id), "important.txt"), "他人のデータ");
    utimesSync(staging(id), old, old);
    purgeExpiredPreviews(root, later);
    expect(readFileSync(join(staging(id), "important.txt"), "utf-8")).toBe("他人のデータ");
  });

  test("目印つきでも作ったばかり(期限前)の `.tmp-` は消さない(組み立て中かもしれない)", () => {
    const id = newPreviewId();
    mkdirSync(staging(id), { recursive: true });
    writeFileSync(join(staging(id), PREVIEW_ENTRY_MARKER_FILE), "");
    purgeExpiredPreviews(root);
    expect(existsSync(staging(id))).toBe(true);
  });

  test("名前が `.tmp-<16進32桁>` の形でないものは、目印つきで古くても消さない", () => {
    for (const name of [".tmp-foo", `.tmp-${"A".repeat(32)}`, `tmp-${newPreviewId()}`]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, PREVIEW_ENTRY_MARKER_FILE), "");
      utimesSync(join(root, name), old, old);
    }
    purgeExpiredPreviews(root, later);
    expect(existsSync(join(root, ".tmp-foo"))).toBe(true);
    expect(existsSync(join(root, `.tmp-${"A".repeat(32)}`))).toBe(true);
  });

  test("残骸を消しても、消した識別子の一覧(下見と束)には載せない", () => {
    const id = newPreviewId();
    mkdirSync(staging(id), { recursive: true });
    writeFileSync(join(staging(id), PREVIEW_ENTRY_MARKER_FILE), "");
    utimesSync(staging(id), old, old);
    expect(purgeExpiredPreviews(root, later)).toEqual([]);
  });
});

describe("束の錠(`V20-M14` 点検の処置 中1)", () => {
  test("錠の中で呼び、離すと錠のファイルは残らない", () => {
    const id = makeGroup(at(0), []);
    const seen = withGroupLock(root, id, () => existsSync(join(root, id, PREVIEW_GROUP_LOCK_FILE)));
    expect(seen).toBe(true);
    expect(existsSync(join(root, id, PREVIEW_GROUP_LOCK_FILE))).toBe(false);
  });

  test("投げても錠は離す", () => {
    const id = makeGroup(at(0), []);
    expect(() =>
      withGroupLock(root, id, () => {
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(existsSync(join(root, id, PREVIEW_GROUP_LOCK_FILE))).toBe(false);
  });

  test("持ち主の居る新しい錠は待ったうえで投げる / 古い錠(残骸)は外して取る", () => {
    const id = makeGroup(at(0), []);
    const lock = join(root, id, PREVIEW_GROUP_LOCK_FILE);
    writeFileSync(lock, "");
    expect(() => withGroupLock(root, id, () => 1)).toThrow("見比べの束が混み合っています");
    expect(existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(withGroupLock(root, id, () => 2)).toBe(2);
    expect(existsSync(lock)).toBe(false);
  });

  test("束の置き場が無ければ投げる・綴りが違えば投げる", () => {
    expect(() => withGroupLock(root, newPreviewId(), () => 1)).toThrow();
    expect(() => withGroupLock(root, "../x", () => 1)).toThrow("綴り");
  });
});
