# 配布物(Runner)のコンテナイメージ(V5-M7-T01 / V5-M7-T02 / R-G1 のイメージ側)。
#
# ============================================================================
# 【このイメージに入っていないもの。1つずつ書く】
#
#   1. 編集系5ルート                  … 起動プロファイル runner が登録しない
#                                        (POST /diffs / POST /undo / GET /undo/preview /
#                                         GET /changelog / GET /requirements)
#   2. D-V5-96 が落とした5エントリ      … 逃げ道CSS の発行・失効・一覧・申請一覧 + GET /api/apps
#   3. アプリ一覧の画面 / 運営育成用パネル … 画面は build:runner の成果物だけを入れる
#                                        (web/src/App.tsx / AppListPage.tsx / AppWorkspace.tsx は
#                                         ソースごと入っていない)
#   4. MCP の入口                      … src/mcp/ をディレクトリごと入れない
#                                        (stdio の index.ts も HTTP の http-entry.ts /
#                                         http-transport.ts も)。@modelcontextprotocol/sdk も消す
#   5. package.json                    … scripts の "mcp" / "mcp:http" ごと入れない
#   6. 移行器 scripts/migrate-volume.ts … scripts/ をディレクトリごと入れない(ADR-0252 限定4)
#   7. 他アプリの行                     … data は scripts/build-runner-data.ts が1アプリ分だけ組む
#
# 【禁止の履行】これは「編集できない」ことを1ミリも意味しない
# (docs/plan/v5/01-distribution-baseline.md §8-1 の禁止1)。
# **この Dockerfile を書き換えれば、上の7つはどれも入る。**
# 書けるのは「今日のこの Dockerfile が作るイメージに入っていない」までである。
#
# 検査は scripts/runner-image/verify-image.ts が持つ(否定形8項目 + 起動プロファイル2項目)。
# ============================================================================
#
# 【組み方】
#   正本のリポジトリの中から(cwd = 正本のルート):
#     mise exec -- bun run apps/smailtalk/scripts/runner-image/prepare-context.ts --demo
#     docker build -f apps/smailtalk/Dockerfile \
#       --build-arg GP_RUNNER_APP_ID=runner-demo -t smailtalk-runner:local apps/smailtalk
#   切り出した木の中から(cwd = 公開単位の根):
#     mise exec -- bun run scripts/runner-image/prepare-context.ts --demo
#     docker build -f Dockerfile --build-arg GP_RUNNER_APP_ID=runner-demo -t smailtalk-runner:local .
#
# 【build context は公開単位の根(apps/smailtalk)である(V9-M12-T03 / X-G33 が移した)】
#   **かつてここには「`apps/smailtalk/` を context にはできない」と書いてあった。**
#   挙げていた理由は「`package.json` / `bun.lock` / `tsconfig.json` が正本のルートに残り、
#   `data-runner-image/` も正本のルート直下に置かれる」であり、**今日はどちらも成り立たない** ——
#     - `package.json` / `bun.lock` / `bunfig.toml` / `tsconfig.json` は
#       `V9-M11-T01` / `V9-M12-T01` が `apps/smailtalk/` 直下に置いた
#       (**正本のルートの `bunfig.toml` は今日もう無い。`bun.lock` は残す —— `ADR-0361`**)。
#     - `prepare-context.ts` の既定の書き込み先は `X-G29` の対応で
#       `<公開単位の根>/data-runner-image/` に動いた。
#   **docker が context の外を `COPY` できないことは今日も変わらない。**
#   変わったのは、**`COPY` したいものが全部 context の中に来たこと**である。
#   したがってこの Dockerfile の `COPY` のソースは**すべて `apps/smailtalk/` からの相対**である。
#   **`-f` に渡す綴りだけは、打つ場所によって変わる**(上の【組み方】の2通り)。
#
# 【動かし方。D-V5-6 の履行】
#   docker run --rm -p 127.0.0.1:3000:3000 -v <volume>:/data smailtalk-runner:local
#   ポートの公開先を 127.0.0.1 に限る。0.0.0.0 に公開すると LAN に開く
#   (ADR-0003 §8 / ADR-0014 §15 の「ローカルホスト以外に公開してはならない」)。
#   コンテナの中では 0.0.0.0 に束ねる(ST_BIND_HOST)—— docker の -p は
#   コンテナの非ループバックのインタフェースへ接続するためである。
#   **既定の公開範囲を守るのは運用であって機構ではない。**

ARG BUN_IMAGE=oven/bun:1.3.14-alpine

# ---------------------------------------------------------------------------
# 1段目: 建てる。**この段には devDependencies も web/src も入っている。**
#         2段目へ渡すのは、この段が作った成果物と本番依存だけである。
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS builder
WORKDIR /build

# 依存を先に入れる(ソースが変わっても層が効く)。
# lockfile を更新する形にしない —— 更新されると「検査した依存」と「リポジトリの依存」が割れる。
#
# 【V9-M12-T03 / X-G33。ここに workspaces の形はもう無い】
#   1. **依存は公開単位の package.json(= context の直下)に在る。**
#      context が公開単位の根になったので、`package.json` はそのまま /build 直下に来る。
#   2. **bun.lock も公開単位が自分で持っている**(`V9-M12-T01` が単独で成立する形に作り直した)。
#      **正本のルートの `bunfig.toml` は今日もう無い。`bun.lock` は残す —— `ADR-0361`。**
#   3. **bunfig.toml も置く。** `linker = "hoisted"` を明示しておくためである
#      (workspaces を持たない今日の bun 1.3.14 では既定でも巻き上がるが、
#      **2段目が COPY するのは /build/node_modules だけ**なので、
#      リンカが isolated に振れた瞬間に空の node_modules を配ることになる。明示で固定する)。
#
# 【2026-08-18 に消した行と、その理由。ここは以前と逆のことを書いている】
#   かつてここには、束ねの器の package.json とは別に、**workspace メンバ2本の
#   package.json を1本ずつ置く COPY が2行**在った(smailtalk 自身と、もう1つの受け皿)。
#   直上のコメントが書いていた理由は「**workspace メンバの package.json は、1本でも
#   欠けると `lockfile had changes, but lockfile is frozen` で止まる**」であり、
#   2026-08-17 に実CI の `container` ジョブが実際にこれで1度落ちた実測から来ていた。
#   **その理由は、束ねが無くなった今日は理由ごと成り立たない** ——
#   公開単位の `bun.lock` は workspaces を1本も列挙しないので、他の器の package.json は
#   解決に要らない(そもそも context の外に在って `COPY` できない)。
#   **したがって2行とも消した。** `COPY package.json` の1行が同じ役目を果たす。
#   **配るのは smailtalk だけである**という帰結は変わっていない。
#   **この Dockerfile は、もう1つの器の綴りを1文字も持たない**(`X-G33` 限定3)。
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY schemas ./schemas
COPY src ./src
COPY web ./web

# どのアプリを描くかはビルド時に入れる(V5-M4-T01)。**与えないと建てない。**
# 与えずに建てると画面は「与えられていません」と出るだけの成果物になり、
# それが配布物として出荷されうる。ここで止める。
ARG GP_RUNNER_APP_ID
RUN test -n "${GP_RUNNER_APP_ID}" || (echo "GP_RUNNER_APP_ID を --build-arg で与えてください" >&2; exit 1)

# 実行専用エントリだけを建てる(web/index.html は建てない)。
# 出力の入口は runner.html なので index.html に改名する ——
# src/server/app.ts の SPA フォールバックが index.html しか見ないためである
# (docs/plan/v5/records/v5-m4.md §5 の 3 が V5-M7 へ申し送った点)。
#
# 【V9-M12-T03 / X-G33】`build:runner` は公開単位の package.json に在り、
# その package.json は context の直下なので /build に居る。**降りる先はもう無い。**
# (`V9-M1-T04` はここに `WORKDIR /build/apps/smailtalk` を置いていた。
#  context が公開単位の根になり、その階層自体が消えたので、行ごと消した。
#  1段目の WORKDIR は先頭の `WORKDIR /build` ただ1つである。)
RUN GP_RUNNER_APP_ID="${GP_RUNNER_APP_ID}" bun run build:runner \
 && mv web/runner/dist/runner.html web/runner/dist/index.html

# 配布物に入れない src を、ここで落とす。
#   - src/mcp   … MCP の入口(stdio / HTTP の両方)。ADR-0005 / v5-m9.md §5 の 1
#   - src/cli   … 配布物から呼ぶ口が1本も無い
#   - *.test.ts … 検査は配布物の一部ではない
RUN rm -rf src/mcp src/cli \
 && find src -name '*.test.ts' -delete \
 && find src -name '*.test.tsx' -delete

# 本番依存だけに入れ直す。**@modelcontextprotocol/sdk は dependencies に居るので、
# --production では落ちない。** 名指しで消す —— サーバは1バイトも import していない
# (src/server / src/kernel / src/shared / src/auth からの参照は0件。2026-08-06 実測)。
#
# 【V9-M12-T03 / X-G33】入れ直しも /build で行う —— 束ねが無くなり、頂点はここ1つである。
# (`V9-M1-T04` はここに `WORKDIR /build` を置いて器の側へ戻していた。
#  直前の `WORKDIR /build/apps/smailtalk` が消えたので、戻る先も消えた。)
RUN rm -rf node_modules \
 && bun install --frozen-lockfile --production \
 && rm -rf node_modules/@modelcontextprotocol

# ---------------------------------------------------------------------------
# 2段目: 配る。**ここに COPY したものだけがイメージに入る。**
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS runtime
WORKDIR /app

# 【V9-M12-T03 / X-G33】1段目の中の置き場が /build/apps/smailtalk/… から /build/… へ戻った
# (context が公開単位の根になり、`apps/smailtalk` という階層が1段目から消えたため)。
# **イメージの中の綴り(/app/schemas / /app/src / /app/web/dist / /app/node_modules)は
# ここでも1バイトも動いていない** —— scripts/runner-image/verify-image.ts の
# 否定形8項目が見るのはこちら側である。
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/schemas ./schemas
COPY --from=builder /build/src ./src
# 実行専用エントリの成果物を、サーバの既定の配信元(<cwd>/web/dist)に置く。
# **src/server/app.ts の既定値を1バイトも変えていない。**
COPY --from=builder /build/web/runner/dist ./web/dist

# 定義側(manifest.json)を焼き込む(V5-M7-T02 = R-G6 の帰属先)。
# **src/kernel/storage-paths.ts を1バイトも触っていない。**
# 起動時に docker/runner-entrypoint.sh がボリュームへ結線する。
#
# 【V9-M12-T03 / X-G33】**この行の綴りは1バイトも変わっていないが、指す先は変わった。**
# context が公開単位の根になったので、`data-runner-image/` は
# `apps/smailtalk/data-runner-image/`(= `prepare-context.ts` の**既定の**書き込み先)を指す。
# ci-container-check.sh が渡していた `--context-root data-runner-image` の上書きは消えた。
COPY data-runner-image/data ./image-data

COPY docker/runner-entrypoint.sh /usr/local/bin/runner-entrypoint.sh
RUN chmod +x /usr/local/bin/runner-entrypoint.sh

ARG GP_RUNNER_APP_ID
ENV GP_RUNNER_APP_ID=${GP_RUNNER_APP_ID}

# 【V5-M5 が名指しした穴を塞ぐ側の片方】
# ここに runner が焼かれていること、および起動口がそれ以外の値で止まることを
# scripts/runner-image/verify-image.ts の (P1) / (P2) が検査する。
ENV ST_SERVER_PROFILE=runner
ENV ST_DATA_ROOT=/data
ENV PORT=3000
# コンテナの中では 0.0.0.0 に束ねる(理由は冒頭の「動かし方」)。
# **src/server/index.ts の既定は 127.0.0.1 のままである。**
ENV ST_BIND_HOST=0.0.0.0
# 既定の origin は配布物の待ち受けに合わせる(rpID は localhost のまま)。
#
# ============================================================================
# 【この1行が docker build のたびに1件の警告を出す。消さないと決めた(V5-M7f-T03)】
#
#   逐語: SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive
#         data (ENV "ST_AUTH_EXPECTED_ORIGIN")
#
# 【当該の値は何か】
#   Passkey(WebAuthn)の検証で「ブラウザが名乗ってきた origin がこれと一致するか」を
#   照合するための **URL** である(src/auth/config.ts:71 が読み、expectedOrigins になる)。
#   ここに書いてある値は http://localhost:3000 —— **利用者が自分でアドレス欄に打つ URL**
#   そのものであり、下の EXPOSE 3000 や手順書の -p 127.0.0.1:3000:3000 と同じものである。
#
# 【なぜ秘密ではないか】
#   1. **利用者と、そのブラウザと、同じ機械の上の誰もが最初から知っている。**
#      ブラウザは同じ値を毎リクエストの Origin ヘッダに載せて送ってくる。隠す相手が居ない。
#   2. **知っても何もできない。** これは鍵でも合言葉でもなく、**照合される側の期待値**である。
#      この値を知っても Passkey の署名は作れない(秘密鍵は利用者の端末にある)。
#      むしろこの値が**厳しいほど**、別 origin からの持ち込みが弾かれる。
#   3. **本物の秘密はここに1つも無い。** 外部接続の secret は「どの環境変数を読むか」の
#      名前だけを持ち、値はイメージにもボリュームにも入らない(M4 の capability モデル)。
#
# 【なぜ警告が出るのか】
#   検査器は**値ではなく名前**を見ている —— 名前に AUTH が含まれるので秘密だと判定した。
#   **誤検知である。**
#
# 【消さないと決めた理由。メイン(計画側)の裁定】
#   消すには (a) 名前を変える (b) ENV をやめて起動時に組み立てる のどちらかになるが、
#   どちらも**検査器の誤検知に合わせて設計を歪める**ことになる。
#   名前は src/auth/config.ts と手順書と検査が共有している綴りであり、
#   ENV に置くのは「イメージだけを受け取った人が、何も渡さずに起動できる」ためである。
#   **抑止の指定(警告を黙らせる注釈)も足さない** ——
#   足すと、**本物の秘密が ENV に混ざった日にも黙って通る。**
#   したがって **警告は出たまま配る。** 手順書(docs/release-runner.md §2)が読者に隠していない。
#
# 【この判断が確かめていないこと】
#   **この警告以外の誤検知が将来出たときにどうするかは、決めていない。**
#   決めたのは、今日この1件についてだけである。
# ============================================================================
ENV ST_AUTH_EXPECTED_ORIGIN=http://localhost:3000

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/runner-entrypoint.sh"]
