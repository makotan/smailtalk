/**
 * **束に案を入れる段(`attachCandidate`)を直接撃つ**(`V20-M14` 点検の処置。`records/v20-m14-audit.md` の中1・中2)。
 *
 * - **中2**: 「数え直して3を超えていれば自分の案を消して断る」見張り(`attachCandidate` の
 *   `index >= COMPARE_MAX_CANDIDATES`)を、照合を通った後に束が3案で埋まった形で撃つ。 見張りを外すと赤くなる。
 * - **中1**: 束の枠は**生きている案**(置き場に登録票 `meta.json` と案の票 `candidate.json` が在り、期限内)だけで
 *   数える。 実体の無い識別子で枠が塞がらない。
 * - **中1**: 別のプロセスが同じ束へ同時に足す形(点検が撃った形。`Bun.spawn` の子8本が同じ時刻に
 *   `attachCandidate` を呼ぶ)を20回撃ち、(a) 一時ファイルの奪い合いで投げない(「登録できなかった」が0件)、
 *   (b) 生きている案が3を超えない、(c) 生きている案が3未満なら、その後の1案は断られない、を確かめる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPARE_MAX_CANDIDATES,
  commitPreview,
  createGroup,
  findGroup,
  newPreviewId,
  PREVIEW_ENTRY_MARKER_FILE,
  PREVIEW_GROUP_FILE,
  type PreviewMeta,
  previewAppId,
  readCandidate,
  writeCandidate,
} from "../server/preview-store.ts";
import {
  attachCandidate,
  COMPARE_FULL_REASON_HEAD,
  liveGroupCandidates,
} from "./preview-compare.ts";

const APP_ID = "workshop";
const REQUESTER = "u-requester";

let work = "";
let root = "";

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "st-compare-attach-"));
  root = join(work, "previews");
  mkdirSync(root, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** 写しを持たない下見の置き場を1つ作る(目印と `meta.json`。`attachCandidate` が要るのはこの2つだけ)。 */
function seedPreview(at: string = root): PreviewMeta {
  const id = newPreviewId();
  const dir = join(at, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, PREVIEW_ENTRY_MARKER_FILE), "", { mode: 0o600 });
  return commitPreview(at, id, {
    app_id: APP_ID,
    requester_user_id: REQUESTER,
    mode: "real",
    shadow_data_root: join(dir, "shadow"),
    session_id: `s-${id}`,
  });
}

function attachInput(meta: PreviewMeta, group: string | undefined, at: string = root) {
  return {
    previewRoot: at,
    meta,
    name: `案-${meta.preview_id.slice(0, 6)}`,
    tradeoff: "とれーどおふ",
    diff: { diff_id: "d-attach", intent: "いんてんと", operations: [] },
    designNotices: [],
    baseManifestSha: "0".repeat(64),
    group,
  };
}

/** 束を1つ作り、`candidates` をそのまま書く(実体の有無は呼ぶ側が決める)。 */
function seedGroup(candidates: string[]): string {
  const groupId = newPreviewId();
  const now = new Date();
  createGroup(root, groupId, {
    app_id: APP_ID,
    requester_user_id: REQUESTER,
    mode: "real",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 3600 * 1000).toISOString(),
    candidates,
  });
  return groupId;
}

/** 生きている案(下見の登録票と案の票が在る)を1つ作る。 */
function seedLiveCandidate(groupId: string): string {
  const meta = seedPreview();
  writeCandidate(root, meta.preview_id, {
    name: "既存の案",
    tradeoff: "既存",
    diff: { operations: [] },
    design_notices: [],
    base_manifest_sha: "0".repeat(64),
    group: groupId,
    off_pattern: false, // 【`V20-M15-T01B`】票の7キー目。
  });
  return meta.preview_id;
}

function groupCandidates(groupId: string, at: string = root): string[] {
  return (
    JSON.parse(readFileSync(join(at, groupId, PREVIEW_GROUP_FILE), "utf-8")) as {
      candidates: string[];
    }
  ).candidates;
}

describe("中2: 照合の後に束が3案で埋まっていたら、数え直しで自分の案を消して断る", () => {
  test("束に生きている案が既に3つ → 「見比べは3案までです」・自分の下見は消える・束は3のまま", () => {
    const groupId = seedGroup([]);
    const existing = [
      seedLiveCandidate(groupId),
      seedLiveCandidate(groupId),
      seedLiveCandidate(groupId),
    ];
    writeFileSync(
      join(root, groupId, PREVIEW_GROUP_FILE),
      `${JSON.stringify({ ...findGroup(root, groupId), candidates: existing }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const mine = seedPreview();
    const result = attachCandidate(attachInput(mine, previewAppId(groupId)));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain(COMPARE_FULL_REASON_HEAD);
    expect(existsSync(join(root, mine.preview_id))).toBe(false);
    expect(groupCandidates(groupId)).toEqual(existing);
    expect(existing.length).toBe(COMPARE_MAX_CANDIDATES);
  });

  test("陽性対照: 生きている案が2つなら3案目は入る(count 3)", () => {
    const groupId = seedGroup([]);
    const existing = [seedLiveCandidate(groupId), seedLiveCandidate(groupId)];
    writeFileSync(
      join(root, groupId, PREVIEW_GROUP_FILE),
      `${JSON.stringify({ ...findGroup(root, groupId), candidates: existing }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const mine = seedPreview();
    const result = attachCandidate(attachInput(mine, previewAppId(groupId)));
    expect(result).toEqual({ ok: true, groupId, count: 3 });
    expect(groupCandidates(groupId)).toEqual([...existing, mine.preview_id]);
  });
});

describe("中1: 枠は生きている案だけで数える(実体の無い識別子で枠が塞がらない)", () => {
  test("束の3つのうち2つが実体の無い識別子 → 新しい案は断られずに入る", () => {
    const groupId = seedGroup([]);
    const live = seedLiveCandidate(groupId);
    const ghosts = [newPreviewId(), newPreviewId()];
    writeFileSync(
      join(root, groupId, PREVIEW_GROUP_FILE),
      `${JSON.stringify({ ...findGroup(root, groupId), candidates: [live, ...ghosts] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const mine = seedPreview();
    const result = attachCandidate(attachInput(mine, previewAppId(groupId)));
    expect(result).toEqual({ ok: true, groupId, count: 2 });
    expect(liveGroupCandidates(root, groupId)).toEqual([live, mine.preview_id]);
  });

  test("案の票の無い下見・期限切れの下見は生きていない", () => {
    const groupId = seedGroup([]);
    const live = seedLiveCandidate(groupId);
    const noTicket = seedPreview().preview_id;
    const expired = seedLiveCandidate(groupId);
    const metaPath = join(root, expired, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as PreviewMeta;
    writeFileSync(metaPath, JSON.stringify({ ...meta, expires_at: "2000-01-01T00:00:00.000Z" }), {
      mode: 0o600,
    });
    writeFileSync(
      join(root, groupId, PREVIEW_GROUP_FILE),
      `${JSON.stringify(
        { ...findGroup(root, groupId), candidates: [live, noTicket, expired] },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    expect(liveGroupCandidates(root, groupId)).toEqual([live]);
  });
});

// ---------------------------------------------------------------------------
// 中1: 別のプロセスの同時追加(点検が撃った形)
// ---------------------------------------------------------------------------

const ROUNDS = 20;
const CHILDREN = 8;
const ROUND_STEP_MS = 60;

type ChildResult = { ok: true; groupId: string; count: number } | { ok: false; reason: string };

describe("中1: 別のプロセスが同じ束へ同時に足す", () => {
  test(`子 ${String(CHILDREN)} 本 × ${String(ROUNDS)} 回: 投げない・生きている案は3以下・入ったと答えた案は束に居る・3未満なら次の1案は入る`, async () => {
    const rounds: { root: string; group: string; metas: PreviewMeta[] }[] = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const roundRoot = join(work, `round-${String(r)}`);
      mkdirSync(roundRoot, { recursive: true, mode: 0o700 });
      const first = seedPreview(roundRoot);
      const created = attachCandidate(attachInput(first, undefined, roundRoot));
      if (!created.ok) throw new Error(`1案目が作れなかった: ${created.reason}`);
      const metas = Array.from({ length: CHILDREN }, () => seedPreview(roundRoot));
      rounds.push({ root: roundRoot, group: previewAppId(created.groupId), metas });
    }
    const start = Date.now() + 2500;
    const planPath = join(work, "plan.json");
    writeFileSync(planPath, JSON.stringify({ rounds, start, step: ROUND_STEP_MS }));
    const modulePath = join(import.meta.dir, "preview-compare.ts");
    const children = Array.from({ length: CHILDREN }, (_, index) =>
      Bun.spawn({
        cmd: [
          "bun",
          "-e",
          `const { attachCandidate } = require(${JSON.stringify(modulePath)});
           const plan = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(planPath)}, "utf-8"));
           const out = [];
           plan.rounds.forEach((round, r) => {
             const at = plan.start + r * plan.step;
             while (Date.now() < at) {}
             const meta = round.metas[${String(index)}];
             out.push(attachCandidate({
               previewRoot: round.root, meta, name: "案-" + meta.preview_id.slice(0, 6),
               tradeoff: "とれーどおふ", diff: { diff_id: "d-attach", intent: "いんてんと", operations: [] },
               designNotices: [], baseManifestSha: "0".repeat(64), group: round.group,
             }));
           });
           console.log(JSON.stringify(out));`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = await Promise.all(
      children.map(async (child) => {
        const [text, errText] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (child.exitCode !== 0) throw new Error(`子が落ちた: ${errText}`);
        return JSON.parse(text) as ChildResult[];
      }),
    );

    const thrown: string[] = [];
    const overfull: number[] = [];
    const blocked: string[] = [];
    let okCount = 0;
    let okButMissing = 0;
    let deadIds = 0;
    const mismatched: string[] = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const round = rounds[r] as (typeof rounds)[number];
      const groupId = round.group.slice(3);
      for (const [index, output] of outputs.entries()) {
        const result = output[r] as ChildResult;
        if (!result.ok && result.reason.includes("登録できなかった")) thrown.push(result.reason);
        if (result.ok) {
          okCount += 1;
          const id = (round.metas[index] as PreviewMeta).preview_id;
          if (!groupCandidates(groupId, round.root).includes(id)) okButMissing += 1;
        }
      }
      const live = liveGroupCandidates(round.root, groupId);
      const okInRound = outputs.filter((output) => (output[r] as ChildResult).ok).length;
      if (okInRound !== live.length - 1) {
        mismatched.push(
          `回 ${String(r)}: ok ${String(okInRound)} / 生きている案 ${String(live.length)}`,
        );
      }
      deadIds += groupCandidates(groupId, round.root).length - live.length;
      if (live.length > COMPARE_MAX_CANDIDATES) overfull.push(r);
      if (live.length < COMPARE_MAX_CANDIDATES) {
        const next = seedPreview(round.root);
        const result = attachCandidate(attachInput(next, round.group, round.root));
        if (!result.ok)
          blocked.push(`回 ${String(r)}: 生きている案 ${String(live.length)} で ${result.reason}`);
        else expect(readCandidate(round.root, next.preview_id)).not.toBeNull();
      }
    }
    // 記録のための印字(合否は下の expect で決める)。
    console.log(
      `[中1 同時追加] rounds=${String(ROUNDS)} children=${String(CHILDREN)} ok=${String(okCount)} ` +
        `thrown=${String(thrown.length)} overfull=${String(overfull.length)} blocked=${String(blocked.length)} ` +
        `okButMissing=${String(okButMissing)} deadIds=${String(deadIds)}`,
    );
    expect(thrown).toEqual([]);
    expect(overfull).toEqual([]);
    expect(blocked).toEqual([]);
    // 束への追記は錠(`group.lock`)の中で行うので、「束に入った」と答えた案が束から落ちることも、
    // 実体の無い識別子が束に残ることも無い。 1回ごとに ok の数 = 生きている案 - 1案目。
    expect(okButMissing).toBe(0);
    expect(deadIds).toBe(0);
    expect(mismatched).toEqual([]);
  }, 60_000);
});
