#!/usr/bin/env bash
# 配布物のコンテナを「組んで・起こして・中身を検査する」一連の手順(V5-M7-T04 / D-V5-91)。
#
# 【なぜスクリプトにしたか】
# .github/workflows/ci.yml の container ジョブと、手元で通す手順を**同じ1本**にするため。
# 別々に書くと、CI だけが通る/手元だけが通る状態が静かに生まれる。
#
# 【この手順が確かめるもの】
#   1. docker build が通る
#   2. 起動して1アプリの定義が返る
#   3. 否定形8項目 + 起動プロファイル2項目 + 肯定形1項目(verify-image.ts)
#   4. 版の合わないボリュームでは起動が止まり、移行コマンドが出る
#
# 【この手順が確かめないもの】
#   - 利用者環境では1度も動かしていない(D-V5-3)。動かしたのは手元と CI のランナーだけである。
#   - ブラウザで画面を目視していない。
#
# 【V5-M7d が入れた「必ず有限時間で終わる」という性質】
#
# 2026-08-06 の実 CI(run 31087823324 / sha 1137b2b)で、**手順6 が 19分08秒のあいだ
# 1バイトも出力せずに止まり**、ジョブが 20分の timeout で cancelled になった。
# 元の手順6 は前面実行の `docker run` を `$( ... || true )` で包んでおり、
# **版のゲートが発火しないとサーバが前面で起き続け、出力は $( ) に吸われたまま永久に待つ。**
# **これは「20分では足りなかった」ではなく「終わらない」である。**
# 詳しい実測は `docs/plan/v5/records/v5-m7d.md` §1 にある。
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-smailtalk-runner:ci}"
APP_ID="${APP_ID:-runner-demo}"
HOST_PORT="${HOST_PORT:-33100}"
CONTAINER_NAME="${CONTAINER_NAME:-gp-runner-ci}"
BASE_URL="http://127.0.0.1:${HOST_PORT}"
VOLUME_DIR="$(mktemp -d)"

# --- 後片付け(V5-M7e)-------------------------------------------------------
#
# 【V5-M7d が半分だけ当てて、半分を外した所】
# `V5-M7d` はここに「**Linux ではボリュームの中身はコンテナの root が作るので、
# 実行ユーザが消せないことがある**」と書きながら、**消せなかったときの扱いを間違えた。**
# 実 CI(run 31092586131 / sha f69c03c)の逐語:
#
#   == 全部通った ==
#   rm: cannot remove '/tmp/tmp.6fCvijGGMx/apps/runner-demo/app.sqlite': Permission denied
#   ...(4本)
#   ##[error]Process completed with exit code 1.
#
# **検査は全部通ったのに、後片付けだけでジョブが赤くなった。**
#
# 【`trap` と `set -e` の関係。手元で実測した(記録 §7)】
# **`set -e` の下では、`trap` の中で1つでも失敗すると、そこで `trap` が打ち切られ、
# スクリプトは 1 で終わる。** 末尾を `true` で締めても、`return <元の値>` しても 1 になる。
# **本体の結果は、そのままでは必ず上書きされる。**
# そこで **(i) 冒頭で本体の終了コードを捕まえ、(ii) 失敗しうる所は `if !` で受け止め、
# (iii) 最後に自分で `exit` する。**
cleanup() {
  # (i) **本体の終了コードを最初に捕まえる。** これより前に何も置かない。
  local status=$?

  # --- (a) コンテナの後始末 ---------------------------------------------------
  # 【失敗を握り潰してよい理由】**手順2 の組み立てで落ちたときはコンテナが1つも無く、
  # `docker rm` は「そんなコンテナは無い」で 1 を返す。無いことは失敗ではない。**
  if ! docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1; then
    : # 無かった。報告するに値しない。
  fi

  # --- (b) ボリュームの中身は、**作った側(コンテナの root)に消させる** --------
  #
  # **ホストの実行ユーザでは消せない**(上の実 CI の逐語)。**書けなかったのと同じ理由で、
  # 消せてもいない。** そこで、中身を消すのはコンテナの中の root にやらせ、
  # **空になった入れ物だけをホストが消す**(入れ物は `mktemp -d` が作ったので実行ユーザの持ち物)。
  #
  # **`/data` そのものはマウント先なのでコンテナの中からは消せない。中身だけを消す。**
  local cleaned_inside=0
  if [ -d "${VOLUME_DIR}" ] && docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
    # **前面実行にしない**(V5-M7d の規律)。締切つきで待ち、超えても `exit` しない ——
    # **後片付けの都合で本体の結果を書き換えないためである。**
    local cid=""
    if cid="$(docker run -d -v "${VOLUME_DIR}:/data" --entrypoint /bin/sh "${IMAGE_TAG}" \
                -c 'rm -rf /data/..?* /data/.[!.]* /data/*' 2>/dev/null)"; then
      local waited=0
      while [ "$(docker inspect -f '{{.State.Running}}' "${cid}" 2>/dev/null || echo false)" = "true" ] &&
            [ "${waited}" -lt 30 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      cleaned_inside=1
      if ! docker rm -f "${cid}" >/dev/null 2>&1; then
        : # 消せなくても、下の `rm -rf` の成否で分かる。
      fi
    fi
  fi

  # --- (c) 空になった入れ物をホストで消す --------------------------------------
  if [ -d "${VOLUME_DIR}" ] && ! rm -rf "${VOLUME_DIR}" 2>/dev/null; then
    # **黙って緑にしない。** ただし**本体の結果は書き換えない**(下の `exit "${status}"`)。
    echo "[後片付け] 一時ディレクトリを消せなかった: ${VOLUME_DIR}" >&2
    echo "  **これは後片付けの失敗であって、検査の結果ではない**(検査の終了コード=${status})。" >&2
    if [ "${cleaned_inside}" -eq 0 ]; then
      echo "  コンテナの中からの掃除を行えなかった(イメージ ${IMAGE_TAG} が無い)。" >&2
    fi
    echo "  手で消すには:" >&2
    echo "    docker run --rm -v \"${VOLUME_DIR}:/data\" --entrypoint /bin/sh ${IMAGE_TAG} \\" >&2
    echo "      -c 'rm -rf /data/..?* /data/.[!.]* /data/*' && rmdir \"${VOLUME_DIR}\"" >&2
  fi

  # (iii) **本体の終了コードで終わる。**
  # **中身が通ったのに後片付けで落ちる形も、中身が落ちたのに後片付けで通る形も作らない。**
  exit "${status}"
}
trap cleanup EXIT

# --- 前面実行の `docker run` を、必ず有限時間で終わらせる器(V5-M7d-T02 の 1)------
#
# **`RUN_OUTPUT`(標準出力と標準エラーを混ぜたもの)と `RUN_EXIT_CODE` に結果を置く。**
# 締切を超えたら、**何を待っていたか**と**コンテナのログ**を出して 1 で落ちる。
#
# 【`timeout(1)` を使わない理由。2つとも手元で実測した(§1)】
#   1. **macOS の素の環境に `timeout` は無い。** coreutils を入れた人にしか無く、
#      入っていない環境では `command not found` になって、待ちが素通りする。
#   2. **`timeout` は `docker` の CLI を殺すだけで、コンテナは走り続ける。**
#      手元で打ち切った後も、そのコンテナが `docker ps` に居座ることを実測した。
# そこで `-d` で起こして自分で締切を見張り、超えたら**コンテナごと**始末する。
#
# 【この器が変えていないこと】起動のさせ方は `-d` になるが、**イメージにも起動口にも
# 1バイトも触っていない。** ゲートは前面実行のときと同じ経路を通る。
RUN_OUTPUT=""
RUN_EXIT_CODE=0
run_with_deadline() {
  local label="$1"
  local deadline="$2"
  shift 2

  local cid
  cid="$(docker run -d "$@")"

  local waited=0
  while :; do
    # 【`|| echo false` を残す理由】コンテナが既に消えている場合に `docker inspect` は
    # 1 を返す。**その場合も「走っていない」として扱いたい**(下で終了コードを読む側が
    # 失敗すれば、そこで落ちる)。
    if [ "$(docker inspect -f '{{.State.Running}}' "${cid}" 2>/dev/null || echo false)" != "true" ]; then
      RUN_EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "${cid}")"
      RUN_OUTPUT="$(docker logs "${cid}" 2>&1)"
      docker rm -f "${cid}" >/dev/null 2>&1 || true
      return 0
    fi
    if [ "${waited}" -ge "${deadline}" ]; then
      echo "${deadline}秒たっても終わらなかった: ${label}" >&2
      echo "  待っていたもの: このコンテナが自分で終了すること(コンテナID=${cid})。" >&2
      echo "  **20分後の打ち切りではなく、ここで落としている**(V5-M7d)。" >&2
      echo "  コンテナのログ:" >&2
      # 【`|| true` を残す理由】ログが取れなくても、落ちる理由は上の行で既に書いてある。
      # ここで失敗して `exit 1` に届かなくなる方が悪い。
      docker logs "${cid}" >&2 2>&1 || true
      docker rm -f "${cid}" >/dev/null 2>&1 || true
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# 【V9-M3-T01(群D)。ここから下のパスは「正本のルートを cwd とした相対」である】
# `V9-M1` が製品コードを apps/smailtalk/ へ移し、`V9-M2` が scripts/ を
# apps/smailtalk/scripts/(161本)と tools/(10本)へ割った。
# **scripts/ は今日、正本のルート直下に1本も無い。**
# .github/workflows/ci.yml は actions/checkout の既定の cwd(= 正本のルート)から
# `bash apps/smailtalk/scripts/runner-image/ci-container-check.sh` を走らせるので、
# ここの相対パスの起点は正本のルートである。手元でも同じ場所から打つこと。
echo "== 1. build context の data/ を1アプリ分だけ組む =="
# **`--context-root` を渡さない(V9-M12-T03 / X-G33)。** `prepare-context.ts` の既定の
# 書き込み先は `X-G29` の対応で「公開単位の根(apps/smailtalk)直下」に動いており、
# 下の `docker build` の context も公開単位の根になった。**既定のままで当たる。**
#
# 【2026-08-18 に消した指定と、その履歴】`V9-M11-T03` はここに
# `--context-root data-runner-image` を渡し、書き込み先を正本のルート直下へ**戻して**いた。
# 当時の context が正本のルートだったからである。**今日それを渡すと、
# `Dockerfile` の `COPY data-runner-image/data` が context(= apps/smailtalk)の中に
# 見つけられず落ちる。** したがって指定ごと消した。
bun run apps/smailtalk/scripts/runner-image/prepare-context.ts --demo --app "${APP_ID}"

echo "== 2. イメージを組む =="
# **`-f` で Dockerfile を名指しし、context は公開単位の根(末尾の `apps/smailtalk`)にする。**
#
# 【2026-08-18(V9-M12-T03 / X-G33)。ここは以前と逆のことを書いている】
# **かつてここには「context を公開単位の根にはできない」という趣旨の1文が在った**
# (逐語は残さない。残すと `X-G33` 限定4 の検査が、消したはずの文言を数えてしまう)。
# 挙げていた理由は2つで、**今日はどちらも成り立たない**:
#   (1) `package.json` / `bun.lock` / `bunfig.toml` / `tsconfig.json` が正本のルートに
#       しか無い —— `V9-M11-T01` / `V9-M12-T01` が `apps/smailtalk/` 直下に置いた。
#       **正本のルートの `bunfig.toml` は今日もう無い。`bun.lock` は残す —— `ADR-0361`。**
#   (2) `prepare-context.ts` が `data-runner-image/` を正本のルート直下に置く ——
#       `X-G29` の対応で既定の書き込み先が公開単位の根の直下に動いた(上の手順1)。
# **docker が context の外を COPY できないことは今日も変わらない。**
# 変わったのは、**COPY したいものが全部 context の中に来たこと**である。
# したがって `Dockerfile` の `COPY` のソースは**すべて apps/smailtalk からの相対**になった。
#
# **`-f` の綴りだけが正本のルートからの相対のままである。** このスクリプトを走らせる
# cwd は今日も正本のルートだからである(上の【V9-M3-T01(群D)】のコメント)。
#
# **`.dockerignore` の実体は apps/smailtalk/Dockerfile.dockerignore である。**
# docker は `-f <path>` を与えられたとき (1) <path>.dockerignore (2) <context>/.dockerignore
# の順に探す。V9-M1 のメインが docker 29.1.3 / buildx v0.30.1 で実測して改名した。
# **context を移しても (1) が先に当たるので、読まれるファイルは変わらない。**
#
# **1行のまま置く。** ci-container-check.test.ts は本文を行単位で走査するので、
# `\` で折ると `-f` と context が別の行に割れて走査から漏れる。
docker build -f apps/smailtalk/Dockerfile --build-arg "GP_RUNNER_APP_ID=${APP_ID}" -t "${IMAGE_TAG}" apps/smailtalk

echo "== 3. 起こす(公開先はループバックに限る。D-V5-6)=="
# 【`|| true` を残す理由】前の実行の残骸が無いのが普通であり、
# 「無かった」を失敗にしたくない。
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run -d --name "${CONTAINER_NAME}" \
  -p "127.0.0.1:${HOST_PORT}:3000" \
  -v "${VOLUME_DIR}:/data" \
  "${IMAGE_TAG}" >/dev/null

echo "== 4. 起動を待つ(最大60秒)=="
ready=0
for _ in $(seq 1 60); do
  # `--max-time` を付ける(V5-M7d-T03)。**繋がったまま1バイトも返さないサーバに当たると、
  # `curl` は既定では待ち続ける。** 待ちには必ず上限を置く。
  #
  # **【`V8-M21` / `J-G24a` / `D-V8-21`】旧: `.../manifest`。**
  # **`GET /manifest` は今日からログインを要求するので、未認証の `curl` では 401 になり、
  # `-f` が非0で返って「起動しなかった」と誤判定する。** **未ログインでも読める
  # `GET /api/apps/<app>/public`(アプリ名と匿名に開いた画面の名前だけ)へ移した。**
  if curl -fsS --max-time 10 "${BASE_URL}/api/apps/${APP_ID}/public" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "${ready}" -ne 1 ]; then
  echo "起動しなかった。コンテナのログ:" >&2
  # 【`|| true` を残す理由】既に「起動しなかった」と書いて `exit 1` する経路であり、
  # ログが取れないことで理由を書けなくなる方が悪い。
  docker logs "${CONTAINER_NAME}" >&2 || true
  exit 1
fi
docker logs "${CONTAINER_NAME}"

echo "== 5. イメージの中身の否定形の検査 =="
bun run apps/smailtalk/scripts/runner-image/verify-image.ts \
  --image "${IMAGE_TAG}" --app "${APP_ID}" --base-url "${BASE_URL}"

echo "== 6. 版の合わないボリュームでは起動が止まり、移行コマンドが出る(ADR-0251)=="
# `-t 5` を明示する(V5-M7d)。**既定の 10秒を丸々待っていた** ——
# PID 1 の `bun` が SIGTERM を握らないので、`docker stop` は毎回 SIGTERM を捨てられ、
# 10秒たってから SIGKILL に進む(手元で 10.4秒を実測。§4)。
docker stop -t 5 "${CONTAINER_NAME}" >/dev/null

# --- 6-1. ボリューム側の `app.sqlite` の印だけを別の値にする -------------------
#
# **イメージには1バイトも触らない。**
#
# 【なぜホスト側の `bun` で書かないか。V5-M7d-T02 の 4】
# ボリュームは bind mount であり、**このイメージのコンテナは root で走る**
# (`Dockerfile` に `USER` が1行も無い)。**Linux では、コンテナが作ったファイルは
# ホストから見て `root` 所有になり、CI の実行ユーザ(`runner`)は書けない。**
# 手元(macOS / Rancher Desktop)は所有者をホストの実行ユーザに読み替えるので、
# **この差は手元では1度も出ない**(§1 に実測を貼った)。
# **そこで、書くのも読み戻すのも「同じイメージの中の root」に寄せる。**
# ホスト側に `bun` が要るかどうかにも、ホスト側の権限にも依存しなくなる。
run_with_deadline "ボリュームの印を 4242 に書き換える" 60 \
  -v "${VOLUME_DIR}:/data" --entrypoint bun "${IMAGE_TAG}" -e '
const { Database } = require("bun:sqlite");
const db = new Database(process.argv[1]);
db.exec("PRAGMA user_version = 4242;");
db.close();
' "/data/apps/${APP_ID}/app.sqlite"
if [ "${RUN_EXIT_CODE}" -ne 0 ]; then
  echo "印の書き換えが失敗した(終了コード=${RUN_EXIT_CODE})。" >&2
  echo "${RUN_OUTPUT}" >&2
  exit 1
fi

# --- 6-2. **書き換えが効いたことを、進む前に読み戻して確かめる**(V5-M7d-T02 の 2)---
#
# **これが無いと、印が効かなかったときに「版が合っている」ボリュームで 6-3 に進み、
# サーバが起きて待ち続ける。** 2026-08-06 の実 CI はその形で 19分止まった(§1)。
# **別プロセス(別コンテナ)で読み直す** —— 書いた側の同じ接続で読むと、
# ディスクに落ちていなくても値が返りうる。
run_with_deadline "書き換えた印を読み戻す" 60 \
  -v "${VOLUME_DIR}:/data" --entrypoint bun "${IMAGE_TAG}" -e '
const { Database } = require("bun:sqlite");
const db = new Database(process.argv[1], { readonly: true });
console.log(db.query("PRAGMA user_version").get().user_version);
db.close();
' "/data/apps/${APP_ID}/app.sqlite"
stamped="$(printf "%s" "${RUN_OUTPUT}" | tr -d "\r" | tail -n 1)"
if [ "${RUN_EXIT_CODE}" -ne 0 ] || [ "${stamped}" != "4242" ]; then
  echo "印の書き換えが効いていない。ここで止める(V5-M7d)。" >&2
  echo "  期待した user_version: 4242" >&2
  echo "  読み戻した値: \"${stamped}\"(読み戻しの終了コード=${RUN_EXIT_CODE})" >&2
  echo "  読み戻したファイル: ${VOLUME_DIR}/apps/${APP_ID}/app.sqlite" >&2
  echo "  **このまま進むと版が合ったままなのでゲートは発火せず、サーバが起きて待ち続ける。**" >&2
  exit 1
fi
echo "印を書き換えて読み戻した: user_version = ${stamped}"

# --- 6-3. 版の合わないボリュームで起こしてみる --------------------------------
#
# **`|| true` を使わない**(V5-M7d-T02 の 3)。元の手順はここを `$( ... || true )` で
# 包んでおり、**失敗も、終わらないことも、両方が握り潰されていた。**
# 終了コードは `run_with_deadline` が `RUN_EXIT_CODE` に持ち帰る。
run_with_deadline "版の合わないボリュームでの起動(ゲートが発火して自分で終了するはず)" 60 \
  -v "${VOLUME_DIR}:/data" "${IMAGE_TAG}"
gate_output="${RUN_OUTPUT}"
gate_exit="${RUN_EXIT_CODE}"
echo "${gate_output}"
if ! echo "${gate_output}" | grep -q "版が合わないため起動を中止します"; then
  echo "版の不一致で止まらなかった。" >&2
  exit 1
fi
if ! echo "${gate_output}" | grep -q "scripts/migrate-volume.ts"; then
  echo "移行コマンドが出なかった(D-V5-14)。" >&2
  exit 1
fi
# **終了コードが 0 でないことも見る。**「メッセージは出したが起動した」を通さない。
# **V5-M7d でイメージを起こす回数を1回に減らした** —— 元は同じ `docker run` を
# もう1度打って終了コードだけを見ており、そのぶん前面実行の待ちが1つ増えていた。
# **今は、文言を見たのと同じ起動の終了コードを見ている**(見る対象が1つに寄った)。
if [ "${gate_exit}" -eq 0 ]; then
  echo "版が合わないのに終了コードが 0 だった。" >&2
  exit 1
fi

echo "== 全部通った =="
