/**
 * **公開単位(`apps/smailtalk/`)の中のコードが、自分より上の階層を解決していないかを測る評価器**
 * (`V9-M11-T03`。`V9-M10` 裁定11)。
 *
 * ## なぜ綴りの `grep` ではいけないのか
 *
 * 「上へ出る式」は1つの綴りに揃っていない。**実体は引数が分割されて書かれている**
 * (`join(import.meta.dir, "..", "..", "..", "..")`)、**入れ子で書かれている**
 * (`dirname(dirname(dirname(dirname(import.meta.dir))))`)、**中間変数を経由している**
 * (`const PRODUCT_ROOT = …;` … `join(PRODUCT_ROOT, "..", "..")`)。
 * さらに `import.meta.url` を経る形もある(`resolve(dirname(new URL(import.meta.url).pathname), "..", …)`)。
 *
 * **そして決定的なのは、綴りが同じでも答えが違うことである。**
 * `join(import.meta.dir, "..", "..", "..")` は
 * `apps/smailtalk/scripts/` から書けば**正本のルート(外)** に着くが、
 * `apps/smailtalk/src/mcp/tools/` から書けば **`apps/smailtalk` 自身(中)** に着く。
 * **綴りだけを見る限り、この2つは区別できない。**
 * (実測: 綴りで数えると 9、実体は 18 だった。段数が変数やループに入れば綴りは何も言えない。)
 *
 * **したがってこの評価器は、式を括弧対応で切り出し、実際にパスを解決してから判定する。**
 *
 * ## 走査の根 —— **正本のルートを1度も算出しない**
 *
 * 本ファイルは公開単位の中(`apps/smailtalk/scripts/`)に在る。
 * したがって走査の根は `dirname(import.meta.dir)` = **`apps/smailtalk`** であり、
 * **評価器自身が正本のルートを算出することは1度も無い**(それをやったら測る側が違反になる)。
 *
 * ## 何を「外へ出た」と判定するか
 *
 * 式を解決して得た絶対パス `P` について、`relative(apps/smailtalk, P)` が `..` で始まるとき
 * 「外へ出た」とする。**`apps/smailtalk` 自身に着くのは中である**(公開単位の根)。
 *
 * ## この評価器が測れないもの(**全量は保証しない**)
 *
 * 1. **動的 `import()` / 実行時に組み立てるパス。** 実行時にしか決まらない値は静的には解けない。
 * 2. **環境変数から根を受け取る形**(`process.env.ST_*` を根にする経路)。値を持たないので解けない。
 * 3. **文字列連結**(`dir + "/../.."`、テンプレートリテラル `` `${dir}/../..` ``)。
 *    本評価器は `join` / `resolve` / `dirname` の呼び出しだけを解く。
 *    **テンプレートリテラルの `${…}` の中身は文字列として遮蔽され、走査されない。**
 * 4. **`.ts` / `.tsx` 以外**(`.js` / `.mjs` / `.json` / `.sh` / `Dockerfile` / YAML)。
 * 5. **スコープを持たない。** 同名の変数が関数ごとに違う値を持つ場合、後勝ちで1つに潰れる。
 *    関数の引数・分割代入・再代入は追わない(`const` / `let` / `var` の初期化だけを読む)。
 * 6. **関数の戻り値を追わない。** `const REPO_ROOT = resolveRepoRoot();` は解けない
 *    (その関数の中の `const candidate = resolve(import.meta.dir, "..", "..", "..");` は解ける)。
 * 7. **末尾が変数の式は「途中まで」しか解かない。** `join(import.meta.dir, "..", "..", x)` は
 *    `apps/smailtalk` までを解いて `partial` と記録する。**その先が `..` ならば見落とす。**
 * 8. **シンボリックリンクを解決しない**(`realpath` を取らない)。
 * 9. **走査するのは公開単位だけである。** 正本のルート直下の他のディレクトリについては何も言わない。
 * 10. **git に追跡されていないファイルは走査しない**(一覧が `git ls-files` だから)。
 *     `git` が使えない木ではディレクトリを歩く代替に落ちるので、**そちらでは逆に未追跡も読む。**
 *     つまり**一覧の中身は木によって変わる**。`filesScanned` を必ず添えて報告すること。
 *
 * ## 使い方
 *
 * ```
 * bun apps/smailtalk/scripts/upward-path-scan.ts             # 一覧を出す(見つかれば exit 1)
 * bun apps/smailtalk/scripts/upward-path-scan.ts --partials  # 限界7 の死角(打ち切った式)も出す
 * bun apps/smailtalk/scripts/upward-path-scan.ts --json      # JSON で出す
 * ```
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// 走査の根
// ---------------------------------------------------------------------------

/**
 * **公開単位の根。** 本ファイルは `apps/smailtalk/scripts/` に在るので、1つ上が根である。
 * **ここより上を計算しない**(計算したら、この評価器自身が測られる側の違反になる)。
 */
export const PUBLIC_UNIT_ROOT: string = dirname(import.meta.dir);

/** 走査から外すディレクトリ名(自分の資産ではないもの)。ファイル一覧の代替経路でだけ使う。 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

// ---------------------------------------------------------------------------
// 出力の型
// ---------------------------------------------------------------------------

/** 「上へ出た」1件。 */
export type UpwardFinding = {
  /** 公開単位の根からの相対パス。 */
  file: string;
  /** 式の開始行(1 始まり)。 */
  line: number;
  /** 切り出した式の逐語(空白を1つに畳んだもの)。 */
  expression: string;
  /** 解決先。公開単位の根からの相対で表す(必ず `..` で始まる)。 */
  resolved: string;
  /** 末尾に解けない引数が在り、途中までで打ち切った場合に true(限界7)。 */
  partial: boolean;
};

/** 走査の結果。 */
export type UpwardScanResult = {
  /** 上へ出た式(ファイル順・行順)。 */
  findings: UpwardFinding[];
  /** 実際に読んだファイルの相対パス(空振りで緑にならないための主張)。 */
  filesScanned: string[];
  /** 実際に読んだ総バイト数。 */
  bytesRead: number;
  /**
   * 根(`import.meta.dir` 等)に届いてはいるが、末尾が解けずに途中で打ち切った式の件数。
   * **限界7 の実測値である。** 0 でないときは「全量を数えた」と言ってはいけない。
   */
  partialCount: number;
  /**
   * **打ち切った時点で公開単位の中に居た式**(`findings` には出てこない)。
   * **ここが限界7 の死角そのものである** —— 解けなかった末尾が `..` だったなら、
   * 実際は外へ出ているのに本評価器は黙って見逃している。**目で見て確かめるための一覧。**
   * (`resolved` は打ち切った時点の解決先。中なので `..` では始まらない。)
   */
  partialsInside: UpwardFinding[];
};

// ---------------------------------------------------------------------------
// 字句の遮蔽 —— コメント・文字列・正規表現リテラルを式と取り違えない
// ---------------------------------------------------------------------------

type Masked = {
  /** コメントを空白で潰した本文(長さは元と同じ。行番号がずれない)。 */
  code: string;
  /** その位置が文字列/テンプレート/正規表現の**中身**なら 1。引用符そのものは 0。 */
  masked: Uint8Array;
};

/** 直前の非空白文字から見て、この `/` が正規表現リテラルの開始か。 */
function looksLikeRegexStart(code: string, slashIdx: number): boolean {
  for (let i = slashIdx - 1; i >= 0; i--) {
    const c = code[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    return "(,=:[!&|?{};+-*%~^<>".includes(c);
  }
  return true;
}

/**
 * コメントを空白で潰し、文字列・テンプレート・正規表現の中身に印を付ける。
 *
 * **`${…}` の中身も文字列として印を付ける**(限界3)。式として読まない。
 */
export function maskSource(src: string): Masked {
  const out = src.split("");
  const masked = new Uint8Array(src.length);
  const len = src.length;
  let i = 0;
  while (i < len) {
    const c = src[i] as string;
    const d = i + 1 < len ? (src[i + 1] as string) : "";
    if (c === "/" && d === "/") {
      while (i < len && src[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < len) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < len) {
        if (src[i] === "\\") {
          masked[i] = 1;
          if (i + 1 < len) masked[i + 1] = 1;
          i += 2;
          continue;
        }
        if (src[i] === c) break;
        masked[i] = 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "/" && looksLikeRegexStart(src, i)) {
      i += 1;
      let inClass = false;
      while (i < len) {
        if (src[i] === "\\") {
          masked[i] = 1;
          if (i + 1 < len) masked[i + 1] = 1;
          i += 2;
          continue;
        }
        if (src[i] === "\n") break; // 正規表現ではなかった。行末で諦める。
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        masked[i] = 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return { code: out.join(""), masked };
}

// ---------------------------------------------------------------------------
// 括弧対応
// ---------------------------------------------------------------------------

/** `openIdx` の開き括弧に対応する閉じ括弧の位置。見つからなければ -1。 */
export function matchBracket(m: Masked, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < m.code.length; i++) {
    if (m.masked[i]) continue;
    const c = m.code[i] as string;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `[start, end)` を最上位のカンマで割る。 */
function splitTopLevelCommas(m: Masked, start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    if (m.masked[i]) continue;
    const c = m.code[i] as string;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push([from, i]);
      from = i + 1;
    }
  }
  if (m.code.slice(from, end).trim() !== "") parts.push([from, end]);
  return parts;
}

// ---------------------------------------------------------------------------
// 式の評価
// ---------------------------------------------------------------------------

/** 評価結果。`path` はディレクトリ/ファイルの絶対パス、`str` はただの文字列。 */
type Val = { kind: "path"; path: string; partial: boolean } | { kind: "str"; str: string };

type EvalContext = {
  /** そのファイルが在るディレクトリの絶対パス(= `import.meta.dir`)。 */
  fileDir: string;
  /** そのファイル自身の絶対パス(= `import.meta.path`)。 */
  filePath: string;
  /** 中間変数の表(`const PRODUCT_ROOT = …` などで埋まる)。 */
  env: Map<string, string>;
};

/** パスを組み立てる関数(最後のドット区切りだけを見る。`path.join` も `join` も同じ)。 */
const JOINING_FUNCTIONS = new Set(["join", "resolve"]);

/** 文字列リテラルの中身を取り出す(単純なエスケープだけ戻す)。 */
function unquote(text: string): string | null {
  const q = text[0];
  if ((q !== '"' && q !== "'") || text[text.length - 1] !== q || text.length < 2) return null;
  const body = text.slice(1, -1);
  // テンプレートリテラルはここに来ない(バッククォートは受け付けない)。
  return body.replace(/\\(["'\\nt])/g, (_all, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch;
  });
}

const IMPORT_META_DIR_RE = /^import\s*\.\s*meta\s*\.\s*(dir|dirname)$/;
const IMPORT_META_PATH_RE = /^import\s*\.\s*meta\s*\.\s*path$/;
const IMPORT_META_URL_RE = /^import\s*\.\s*meta\s*\.\s*url$/;
const URL_PATHNAME_RE = /^new\s+URL\(\s*import\s*\.\s*meta\s*\.\s*url\s*\)\s*\.\s*(pathname|href)$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const CALL_HEAD_RE = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/;

/** `[start, end)` の式を評価する。解けなければ null。 */
function evalRange(m: Masked, start: number, end: number, ctx: EvalContext): Val | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(m.code[s] as string)) s += 1;
  while (e > s && /\s/.test(m.code[e - 1] as string)) e -= 1;
  if (s >= e) return null;

  // まるごと括弧で包まれている場合はほどく。
  if (m.code[s] === "(" && !m.masked[s] && matchBracket(m, s) === e - 1) {
    return evalRange(m, s + 1, e - 1, ctx);
  }

  const text = m.code.slice(s, e);

  if (IMPORT_META_DIR_RE.test(text)) return { kind: "path", path: ctx.fileDir, partial: false };
  if (IMPORT_META_PATH_RE.test(text)) return { kind: "path", path: ctx.filePath, partial: false };
  if (URL_PATHNAME_RE.test(text)) return { kind: "path", path: ctx.filePath, partial: false };
  if (IMPORT_META_URL_RE.test(text)) return null; // 単独では場所ではない(URL 文字列)

  if (text === "__dirname") {
    const bound = ctx.env.get("__dirname");
    return { kind: "path", path: bound ?? ctx.fileDir, partial: false };
  }
  if (text === "__filename") {
    const bound = ctx.env.get("__filename");
    return { kind: "path", path: bound ?? ctx.filePath, partial: false };
  }

  const literal = unquote(text);
  if (literal !== null) return { kind: "str", str: literal };

  if (IDENTIFIER_RE.test(text)) {
    const bound = ctx.env.get(text);
    return bound === undefined ? null : { kind: "path", path: bound, partial: false };
  }

  const head = CALL_HEAD_RE.exec(text);
  if (head === null) return null;
  const openIdx = s + head[0].length - 1;
  if (matchBracket(m, openIdx) !== e - 1) return null; // 呼び出しの外に何か付いている
  const segments = (head[1] as string).split(".").map((part) => part.trim());
  const fn = segments[segments.length - 1] as string;
  const args = splitTopLevelCommas(m, openIdx + 1, e - 1);

  if (fn === "dirname") {
    if (args.length !== 1) return null;
    const first = args[0] as [number, number];
    const inner = evalRange(m, first[0], first[1], ctx);
    if (inner === null || inner.kind !== "path") return null;
    return { kind: "path", path: dirname(inner.path), partial: inner.partial };
  }

  if (fn === "fileURLToPath") {
    if (args.length < 1) return null;
    const first = args[0] as [number, number];
    if (IMPORT_META_URL_RE.test(m.code.slice(first[0], first[1]).trim())) {
      return { kind: "path", path: ctx.filePath, partial: false };
    }
    return null;
  }

  if (!JOINING_FUNCTIONS.has(fn)) return null;

  let acc: string | null = null;
  let partial = false;
  for (const [argStart, argEnd] of args) {
    const value = evalRange(m, argStart, argEnd, ctx);
    if (value === null) {
      // **末尾が解けない。** 途中までを答えにして `partial` を立てる(限界7)。
      partial = true;
      break;
    }
    if (value.kind === "path") {
      acc =
        acc === null
          ? value.path
          : fn === "resolve"
            ? resolve(acc, value.path)
            : join(acc, value.path);
      if (value.partial) {
        partial = true;
        break;
      }
      continue;
    }
    if (acc === null) {
      // 先頭が相対の文字列 —— 根に届いていないので、この式は対象ではない
      // (`args.join(" ")` のような配列の join もここで落ちる)。
      if (!isAbsolute(value.str)) return null;
      acc = value.str;
      continue;
    }
    acc = fn === "resolve" ? resolve(acc, value.str) : join(acc, value.str);
  }
  if (acc === null || !isAbsolute(acc)) return null;
  return { kind: "path", path: acc, partial };
}

// ---------------------------------------------------------------------------
// 1ファイルの走査
// ---------------------------------------------------------------------------

const DECLARATION_RE = /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=/g;
const CALL_START_RE = /(?<![\w$.])([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;

/** 宣言の右辺(`=` の次から、最上位の `;` まで)の範囲。 */
function declarationRhsRange(m: Masked, eqIdx: number): [number, number] | null {
  let depth = 0;
  for (let i = eqIdx + 1; i < m.code.length; i++) {
    if (m.masked[i]) continue;
    const c = m.code[i] as string;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (c === ";" && depth === 0) return [eqIdx + 1, i];
  }
  return null;
}

/** 1 始まりの行番号。 */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * 1ファイル分の走査。**`unitRoot` の外へ出る式だけを返す。**
 *
 * `relPath` は `unitRoot` からの相対パス(報告に使う)。`source` はそのファイルの本文。
 */
export function findUpwardEscapes(
  unitRoot: string,
  relPath: string,
  source: string,
): { findings: UpwardFinding[]; partialCount: number; partialsInside: UpwardFinding[] } {
  const absolutePath = join(unitRoot, relPath);
  const m = maskSource(source);
  const ctx: EvalContext = {
    fileDir: dirname(absolutePath),
    filePath: absolutePath,
    env: new Map<string, string>(),
  };

  // (1) 中間変数を埋める。前方参照のために表が増えなくなるまで繰り返す(最大3周)。
  for (let pass = 0; pass < 3; pass++) {
    const before = ctx.env.size;
    DECLARATION_RE.lastIndex = 0;
    let declaration = DECLARATION_RE.exec(m.code);
    while (declaration !== null) {
      const eqIdx = declaration.index + declaration[0].length - 1;
      if (!m.masked[declaration.index]) {
        const range = declarationRhsRange(m, eqIdx);
        if (range !== null) {
          const value = evalRange(m, range[0], range[1], ctx);
          if (value !== null && value.kind === "path" && !value.partial) {
            ctx.env.set(declaration[1] as string, value.path);
          }
        }
      }
      declaration = DECLARATION_RE.exec(m.code);
    }
    if (ctx.env.size === before) break;
  }

  // (2) すべての呼び出し式を括弧対応で切り出し、解決して外へ出るものを拾う。
  const raw: Array<UpwardFinding & { start: number; end: number }> = [];
  const partialsInside: UpwardFinding[] = [];
  let partialCount = 0;
  CALL_START_RE.lastIndex = 0;
  let call = CALL_START_RE.exec(m.code);
  while (call !== null) {
    const start = call.index;
    if (!m.masked[start]) {
      const openIdx = start + call[0].length - 1;
      const close = matchBracket(m, openIdx);
      if (close !== -1) {
        const value = evalRange(m, start, close + 1, ctx);
        if (value !== null && value.kind === "path") {
          if (value.partial) partialCount += 1;
          const rel = relative(unitRoot, value.path).replaceAll("\\", "/");
          if (rel.startsWith("..") || isAbsolute(rel)) {
            raw.push({
              file: relPath,
              line: lineAt(source, start),
              expression: source.slice(start, close + 1).replace(/\s+/g, " "),
              resolved: rel,
              partial: value.partial,
              start,
              end: close + 1,
            });
          } else if (value.partial) {
            // **中に着いたまま打ち切った。** 解けなかった末尾が `..` なら見逃している(限界7)。
            partialsInside.push({
              file: relPath,
              line: lineAt(source, start),
              expression: source.slice(start, close + 1).replace(/\s+/g, " "),
              resolved: rel === "" ? "." : rel,
              partial: true,
            });
          }
        }
      }
    }
    call = CALL_START_RE.exec(m.code);
  }

  // (3) 入れ子は外側だけを1件として数える(内側が外へ出ていても二重に数えない)。
  const findings = raw
    .filter(
      (candidate) =>
        !raw.some(
          (other) =>
            other !== candidate && other.start <= candidate.start && other.end >= candidate.end,
        ),
    )
    .map(({ start: _s, end: _e, ...rest }) => rest);

  return { findings, partialCount, partialsInside };
}

// ---------------------------------------------------------------------------
// ファイル一覧
// ---------------------------------------------------------------------------

const isSourceFile = (name: string): boolean => name.endsWith(".ts") || name.endsWith(".tsx");

/** `git ls-files` の一覧(`unitRoot` を作業ディレクトリにするので、上を1度も算出しない)。 */
function gitListedFiles(unitRoot: string): string[] | null {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("git", ["ls-files", "-z"], {
      cwd: unitRoot,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const files = result.stdout.split("\0").filter((name) => name !== "");
  return files.length === 0 ? null : files;
}

/** `git` が使えない木(切り出した配布物など)のための代替。ディレクトリを歩く。 */
function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(root, prefix));
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    let isDir: boolean;
    try {
      isDir = statSync(join(root, rel)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walkFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

/** 公開単位の `.ts` / `.tsx` の相対パス一覧(整列済み)。 */
export function listUnitSourceFiles(unitRoot: string = PUBLIC_UNIT_ROOT): string[] {
  const listed = gitListedFiles(unitRoot) ?? walkFiles(unitRoot);
  return listed.filter(isSourceFile).sort();
}

// ---------------------------------------------------------------------------
// 走査の入口
// ---------------------------------------------------------------------------

/** 与えられたファイル一覧を走査する(一時ディレクトリにも当てられる形)。 */
export function scanFiles(unitRoot: string, relPaths: string[]): UpwardScanResult {
  const findings: UpwardFinding[] = [];
  const partialsInside: UpwardFinding[] = [];
  const filesScanned: string[] = [];
  let bytesRead = 0;
  let partialCount = 0;
  for (const relPath of relPaths) {
    let source: string;
    try {
      source = readFileSync(join(unitRoot, relPath), "utf-8");
    } catch {
      continue;
    }
    filesScanned.push(relPath);
    bytesRead += source.length;
    const result = findUpwardEscapes(unitRoot, relPath, source);
    findings.push(...result.findings);
    partialsInside.push(...result.partialsInside);
    partialCount += result.partialCount;
  }
  return { findings, filesScanned, bytesRead, partialCount, partialsInside };
}

/** 公開単位を丸ごと走査する。 */
export function scanPublicUnit(unitRoot: string = PUBLIC_UNIT_ROOT): UpwardScanResult {
  return scanFiles(unitRoot, listUnitSourceFiles(unitRoot));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const result = scanPublicUnit();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const finding of result.findings) {
      console.log(
        `${finding.file}:${finding.line}\t-> ${finding.resolved}${finding.partial ? " (途中まで)" : ""}\t${finding.expression}`,
      );
    }
    if (process.argv.includes("--partials")) {
      console.log("\n--- 中に着いたまま打ち切った式(限界7 の死角) ---");
      for (const partial of result.partialsInside) {
        console.log(
          `${partial.file}:${partial.line}\t-> ${partial.resolved}\t${partial.expression}`,
        );
      }
    }
    console.log(
      `\n走査 ${result.filesScanned.length} ファイル / ${result.bytesRead} バイト。` +
        `上へ出た式 ${result.findings.length} 件。`,
    );
    console.log(
      `**全量ではない。** 末尾が解けずに途中で打ち切った式が ${result.partialCount} 件あり、` +
        `そのうち ${result.partialsInside.length} 件は打ち切り時点で中に居た` +
        "(`--partials` で一覧が出る)。**解けなかった末尾が `..` なら見逃している。**",
    );
    console.log(
      "そのほか測れないもの(動的 import・環境変数・文字列連結・.ts/.tsx 以外・未追跡ファイル)は" +
        " upward-path-scan.ts の冒頭に列挙してある。",
    );
  }
  process.exit(result.findings.length === 0 ? 0 : 1);
}
