import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  defaultDataRoot,
  defaultRepoRoot,
  nextTrialId,
  parseRunOptions,
  resolveDataRoot,
  resolveRepoRoot,
} from "./run.ts";
import type { TrialMeta } from "./types.ts";

const here = dirname(new URL(import.meta.url).pathname);

/**
 * **公開単位の根**(`apps/smailtalk/`)。このファイルは `<公開単位>/scripts/mcp-trial/` に
 * 在るので**2階層**上げる。
 *
 * **`V9-M11`(`X-G29`)より前は4階層上げて正本のルート(リポジトリの根)に着いていた。**
 * `V9-M11-T01` が `apps/smailtalk/.mcp.json` を新設したので、**公開単位より上へ出る必要が
 * 無くなった**(公開単位だけを切り出した木でも、この定数が実在の場所を指す)。
 */
const PUBLISH_UNIT_ROOT = join(here, "..", "..");

/**
 * **テンポラリの偽ルート**(`docs/plan/v9/records/v9-m2.md` §7 の 12 / §6 の 3)。
 *
 * 以前は正本のルートそのものを子プロセスの `cwd` に渡し、`data-skill-arm-meta-test` を
 * **リポジトリ直下に作って消していた**。`--repo-root` を明示の入力にしたので、
 * **試行が触るのは丸ごと捨てられる一時ディレクトリだけになる。**
 *
 * `.mcp.json` は**実物を複製する** —— 中身を書き起こすと、実物から
 * `smailtalk` サーバの定義が消えてもこの検査は緑のままになるからである。
 * **複製元は `run.ts` が実行時に読むのと同じ1本**(`apps/smailtalk/.mcp.json`)であり、
 * **`V9-M11` で正本のルート直下の `.mcp.json` から移した。** 読み先が変わっただけで、
 * 「実物が壊れたら赤くなる」という意図はそのまま残っている。
 */
function makeFakeRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gp-trial-root-"));
  copyFileSync(join(PUBLISH_UNIT_ROOT, ".mcp.json"), join(root, ".mcp.json"));
  return root;
}

describe("nextTrialId", () => {
  test("最初の試行は 001", () => {
    expect(nextTrialId([], "bootstrap")).toBe("001-bootstrap");
  });

  test("既存の連番の続きになる(破棄した試行の番号も消費する)", () => {
    expect(nextTrialId(["001-bootstrap", "002-undo-consent"], "bootstrap")).toBe("003-bootstrap");
  });

  test("シナリオが違っても連番は全体で1本", () => {
    expect(nextTrialId(["001-bootstrap"], "undo-consent")).toBe("002-undo-consent");
  });

  test("連番でない名前は無視する", () => {
    expect(nextTrialId(["README.md", "007-x", "notes"], "bootstrap")).toBe("008-bootstrap");
  });
});

describe("parseRunOptions", () => {
  test("既定値(--data-root を指定しなければ未指定のまま残る)", () => {
    const options = parseRunOptions(["--scenario", "bootstrap"]);
    expect(options.scenario).toBe("bootstrap");
    expect(options.dataRoot).toBeUndefined();
    expect(options.out).toBe("docs/evidence/cp-6/transcripts");
    expect(options.dryRun).toBe(false);
  });

  test("上書きできる", () => {
    const options = parseRunOptions([
      "--scenario",
      "undo-consent",
      "--data-root",
      "data-trial",
      "--out",
      "/tmp/out",
      "--note",
      "1回目は破棄",
      "--dry-run",
    ]);
    expect(options.dataRoot).toBe("data-trial");
    expect(options.out).toBe("/tmp/out");
    expect(options.note).toBe("1回目は破棄");
    expect(options.dryRun).toBe(true);
  });

  test("--scenario は必須", () => {
    expect(() => parseRunOptions([])).toThrow(/--scenario/);
  });

  test("知らないフラグは落とす", () => {
    expect(() => parseRunOptions(["--scenario", "x", "--nope"])).toThrow(/--nope/);
  });
});

/**
 * `V9-M3-T01`: **ルートの位置を明示の入力にした**(`repoRoot()` の廃止)。
 *
 * `V9-M1` / `V9-M2` の前は「`run.ts` から2つ上」がそのまま正本のルートだった。
 * 公開単位が `apps/smailtalk/` へ動いたあと、その2つ上は `apps/smailtalk/` を指し、
 * **そこに `.mcp.json` は無かった** —— 試行が1件も残らなくなっていた。
 *
 * **`V9-M11`(`X-G29` / `X-G30`)で `.mcp.json` を `apps/smailtalk/` に置いたので、
 * 「2つ上」が今日の正解になった。** 根は公開単位そのものであり、その上には出ない。
 */
describe("V9-M3-T01: 根は明示の入力である(既定は公開単位)", () => {
  test("--repo-root を指定すればその場所を使う(既定を見に行かない)", () => {
    const options = parseRunOptions([
      "--scenario",
      "bootstrap",
      "--repo-root",
      "/tmp/gp-fake-root",
    ]);
    expect(options.repoRoot).toBe("/tmp/gp-fake-root");
    expect(resolveRepoRoot(options)).toBe("/tmp/gp-fake-root");
    expect(resolveRepoRoot(options)).not.toBe(defaultRepoRoot());
  });

  test("未指定なら既定は .mcp.json が実在する公開単位の根である", () => {
    const root = resolveRepoRoot(parseRunOptions(["--scenario", "bootstrap"]));
    expect(root).toBe(defaultRepoRoot());
    // **`.mcp.json` が実在すること**が「根に着いた」ことの実測である。
    expect(existsSync(join(root, ".mcp.json")), `${root} に .mcp.json が無い`).toBe(true);
    // --- 段数の取り違えを名指しで止める2行。**`X-G29` 限定5 で向きを書き換えた。** ---
    // **1階層しか上げないと `scripts/` に、3階層上げるとモノレポでは `apps/` に着く。**
    // この行は元から「`apps/` で止まっていないこと」を止めていた。**向きは変えていない。**
    expect(basename(root)).not.toBe("apps");
    // **この行は元は `not.toBe("smailtalk")` だった** —— 根が正本のルート(リポジトリの根)
    // だった頃、`smailtalk` に着くのは「4階層上げるべきところを2階層しか上げなかった」
    // 取り違えの印だったからである。**`V9-M11` で根を公開単位に移したので、その
    // `smailtalk` が今日の正解になった。** 止めているものは変わっていない ——
    // **段数を取り違えて意図しない階層に着くこと**である。逆向きに固定して同じ穴を塞ぐ。
    //
    // 【訂正 —— 直上の「`smailtalk` が今日の正解になった」は**成り立たない**】
    // **一度は `toBe("smailtalk")` と書いたが、本物の `tools/publish/publish.ts` が出した
    // 切り出した木で落ちた**(`Expected: "smailtalk" / Received: "pub-t03"`)。
    // **切り出した木では公開単位そのものが木の根になり、そのフォルダ名は受け取った人が付ける。**
    // `smailtalk` とは限らない。**名前を決め打ちすると、切り出した木でこそ落ちる**という
    // 本末転倒になる。そこで**フォルダ名に依らない形**へ直した ——
    // 1階層しか上げないと着く `scripts` を名指しで止め(この名前は公開単位の**中**なので
    // 木の名前が何であっても不変)、**段数そのものは直後の構造で固定する。**
    expect(basename(root)).not.toBe("scripts");
    // **段数の裏づけ(フォルダ名を1つも使わない)。**
    // 「根 + `scripts/mcp-trial` = このファイルの在り処」が成り立つのは**2階層上げたときだけ**で、
    // 1階層でも3階層でも成り立たない。モノレポでも切り出した木でも同じように効く。
    expect(join(root, "scripts", "mcp-trial")).toBe(here);
  });
});

describe("V1-M0-T06 (d): シナリオごとの独立データルートが既定", () => {
  test("既定のデータルートはシナリオIDから決まる", () => {
    expect(defaultDataRoot("bootstrap")).toBe("data-bootstrap");
    expect(defaultDataRoot("undo-consent")).toBe("data-undo-consent");
  });

  test("2つのシナリオを続けて実行しても既定ではデータルートが衝突しない", () => {
    const a = resolveDataRoot(parseRunOptions(["--scenario", "bootstrap"]), "bootstrap");
    const b = resolveDataRoot(
      parseRunOptions(["--scenario", "out-of-vocabulary"]),
      "out-of-vocabulary",
    );
    expect(a).not.toBe(b);
  });

  test("共有したい場合は --data-root で明示する(明示が上書きする)", () => {
    const options = parseRunOptions(["--scenario", "out-of-vocabulary", "--data-root", "data-cp6"]);
    expect(resolveDataRoot(options, "out-of-vocabulary")).toBe("data-cp6");
  });

  test("既定値も assertIsolatedDataRoot が要求する data- 接頭辞を満たす", () => {
    expect(defaultDataRoot("bootstrap").startsWith("data-")).toBe(true);
  });
});

describe("V1-M0-T06 (c): --dry-run は試行ディレクトリを作らず連番を消費しない", () => {
  test("--dry-run 後に出力先の中身が増えない", async () => {
    const out = mkdtempSync(join(tmpdir(), "gp-t06-dryrun-"));
    const fakeRoot = makeFakeRepoRoot();
    mkdirSync(join(out, "001-bootstrap"));
    writeFileSync(join(out, "001-bootstrap", "meta.json"), "{}");
    const before = readdirSync(out).sort();

    const proc = Bun.spawn(
      [
        process.execPath,
        join(here, "run.ts"),
        "--scenario",
        "bootstrap",
        "--out",
        out,
        "--repo-root",
        fakeRoot,
        "--dry-run",
      ],
      { cwd: fakeRoot, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(readdirSync(out).sort()).toEqual(before);
    // 連番も消費していない: 次の試行は 002 のままである。
    expect(nextTrialId(readdirSync(out), "bootstrap")).toBe("002-bootstrap");
    // 既定のデータルートがシナリオごとに分かれていることを、実行時の出力でも示す。
    expect(stderr).toContain("data-bootstrap");
    // **明示したルートの下に解けている**(既定の位置ではない)。
    expect(stderr).toContain(join(fakeRoot, "data-bootstrap"));

    rmSync(out, { recursive: true, force: true });
    rmSync(fakeRoot, { recursive: true, force: true });
  }, 30_000);
});

/**
 * 説明書(skill)の2腕と、名乗り。
 *
 * シナリオ `shared-lending-app` は `Skill` をどちらのリストにも書かない。
 * **腕の別は CLI が付ける**ので、フラグを取り違えたまま走ると
 * 「2腕を測ったつもりで同じ腕を2回測る」ことになる。ここで形を固定する。
 */
describe("--skill / --actor", () => {
  test("既定では今日と同じ(どちらも未指定のまま残る)", () => {
    const options = parseRunOptions(["--scenario", "shared-lending-app"]);
    expect(options.skillArm).toBeUndefined();
    expect(options.actor).toBeUndefined();
  });

  test("腕と名乗りを指定できる", () => {
    const options = parseRunOptions([
      "--scenario",
      "shared-lending-app",
      "--skill",
      "allow",
      "--actor",
      "unei",
    ]);
    expect(options.skillArm).toBe("allow");
    expect(options.actor).toBe("unei");
    expect(parseRunOptions(["--scenario", "x", "--skill", "deny"]).skillArm).toBe("deny");
  });

  test("allow / deny 以外の腕は落とす", () => {
    expect(() => parseRunOptions(["--scenario", "x", "--skill", "both"])).toThrow(/--skill/);
    expect(() => parseRunOptions(["--scenario", "x", "--skill"])).toThrow(/--skill/);
  });

  test("--dry-run でも腕が実際の引数に現れる(dry-run で確認できなくならない)", async () => {
    const fakeRoot = makeFakeRepoRoot();
    const proc = Bun.spawn(
      [
        process.execPath,
        join(here, "run.ts"),
        "--scenario",
        "shared-lending-app",
        "--skill",
        "allow",
        "--repo-root",
        fakeRoot,
        "--dry-run",
      ],
      { cwd: fakeRoot, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    // allow の腕なので、`--allowedTools ... Skill` の側に現れる。
    expect(/--allowedTools[^\n]*\bSkill\b[^\n]*--disallowedTools/.test(stderr)).toBe(true);
    rmSync(fakeRoot, { recursive: true, force: true });
  }, 30_000);

  test("meta.json を読むだけでどちらの腕かが分かる", async () => {
    const out = mkdtempSync(join(tmpdir(), "gp-skill-arm-"));
    const fakeRoot = makeFakeRepoRoot();
    // `claude` の代わりに何も出さない偽物を置く。ここで測るのは
    // **証跡に腕と名乗りが残るか**だけなので、モデルを起こす必要はない。
    const fakeBin = join(out, "fake-claude.sh");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBin, 0o755);

    const proc = Bun.spawn(
      [
        process.execPath,
        join(here, "run.ts"),
        "--scenario",
        "shared-lending-app",
        "--data-root",
        "data-skill-arm-meta-test",
        "--out",
        join(out, "transcripts"),
        "--repo-root",
        fakeRoot,
        "--skill",
        "deny",
        "--actor",
        "unei",
      ],
      {
        cwd: fakeRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ST_TRIAL_CLAUDE_BIN: fakeBin },
      },
    );
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    await proc.exited;

    const trialDir = join(out, "transcripts", "001-shared-lending-app");
    const meta = JSON.parse(readFileSync(join(trialDir, "meta.json"), "utf-8")) as TrialMeta;
    expect(meta.skillArm).toBe("deny");
    expect(meta.actor).toBe("unei");
    // 既存フィールドは1つも消えていない。
    expect(meta.scenarioId).toBe("shared-lending-app");
    expect(meta.disallowedTools).toContain("Skill");
    expect(meta.allowedTools).not.toContain("Skill");
    // 名乗りは評価専用の mcp.json にも入っている(これが無いと24本が全部落ちる)。
    const mcpConfig = JSON.parse(readFileSync(join(trialDir, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(mcpConfig.mcpServers.smailtalk?.env.ST_MCP_ACTOR).toBe("unei");

    // **評価用のデータルートは偽ルートの下にできている**(正本のルート直下ではない)。
    expect(meta.dataRoot).toBe(join(fakeRoot, "data-skill-arm-meta-test"));

    rmSync(out, { recursive: true, force: true });
    // 偽ルートごと捨てる。**正本のルートには1バイトも書いていない。**
    rmSync(fakeRoot, { recursive: true, force: true });
  }, 60_000);
});
