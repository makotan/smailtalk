#!/bin/sh
# 配布物(Runner)の起動口(V5-M7-T01 / V5-M7-T02)。
#
# ここがやることは3つだけである。
#   (1) 起動プロファイルの取り違えを止める(V5-M5 が名指しした穴)
#   (2) ボリュームが空なら、イメージのデータで種を撒く
#   (3) 定義側(manifest.json)をイメージからボリュームへ結線する(R-G6 の帰属先)
#
# 【この口が持たないもの】
#   - 版のゲートを迂回する手段を1つも持たない(ADR-0251 限定5)。
#     版の照合は src/server/index.ts が起動時に行い、合わなければ exit 1 する。
#     ここはその判定に1バイトも触らない。
#   - MCP の起動口を持たない。移行器を呼ぶ口も持たない(ADR-0252 限定4)。
set -eu

APP_ID="${GP_RUNNER_APP_ID:-}"
IMAGE_DATA="/app/image-data"
DATA_ROOT="${ST_DATA_ROOT:-/data}"

# --- (1) 起動プロファイルの取り違えを止める ----------------------------------
#
# 【V5-M5 が名指しした穴】docs/plan/v5/records/v5-m5.md の逐語:
#   「V5-M7 が ST_SERVER_PROFILE=runner を渡し忘れると配布物は full で起動し
#     ゲートも走らない。渡し忘れを赤にする検査は1本もありません」
#
# ここが「赤にする」側の実体である。Dockerfile の ENV から runner が消えても、
# docker run -e ST_SERVER_PROFILE=full で上書きされても、起動しない。
#
# 【黙って runner に直さない】上書きを黙って捨てると、利用者は「full で起動した」と
# 思ったまま runner のサーバを触ることになる(憲法6)。止めて理由を書く。
if [ "${ST_SERVER_PROFILE:-}" != "runner" ]; then
  echo "[smailtalk runner] 起動を中止します: ST_SERVER_PROFILE が \"runner\" ではありません" >&2
  echo "  実際の値: \"${ST_SERVER_PROFILE:-(与えられていない)}\"" >&2
  echo "  この配布物は実行専用プロファイルでしか起動しません(V5-M3-T02 / D-V5-96)。" >&2
  echo "  full で起動すると編集系5ルートが登録され、版のゲートも走りません。" >&2
  exit 1
fi

if [ -z "${APP_ID}" ]; then
  echo "[smailtalk runner] 起動を中止します: GP_RUNNER_APP_ID がイメージに焼かれていません" >&2
  echo "  docker build --build-arg GP_RUNNER_APP_ID=<app_id> で与えてください。" >&2
  exit 1
fi

# --- (2) ボリュームが空なら、イメージのデータで種を撒く -----------------------
#
# 【正直に書く】これは「初回だけ」である。2回目以降は 1バイトも上書きしない。
# ボリュームに既に kernel.sqlite が在るとき、その中身がこのイメージの版と合うかは
# ここでは1つも判定しない —— 判定するのは src/server/index.ts の版のゲートである。
mkdir -p "${DATA_ROOT}"
if [ ! -f "${DATA_ROOT}/kernel.sqlite" ]; then
  echo "[smailtalk runner] ボリュームが空なので、イメージのデータで初期化します: ${DATA_ROOT}" >&2
  cp -R "${IMAGE_DATA}/." "${DATA_ROOT}/"
fi

# --- (3) 定義側をイメージからボリュームへ結線する(R-G6 / V5-M7-T02)----------
#
# 定義(manifest.json)はイメージ側が正であり、データ(app.sqlite)はボリューム側が正である。
# src/kernel/storage-paths.ts は1バイトも触っていない —— 置き場の分離は
# 「イメージに焼き、起動時にボリュームへ写す」というこの2行だけで行う
# (v5-m0.md §2-6 の S4 ② が W-B と等級づけた形)。
#
# 【この形の代償。隠さない】
#   - ファイル単位の結線であり、脆い(v5-m0.md §2-6 S4 ② の (ii))。
#   - ボリューム側の manifest.json は毎回上書きされる。ボリューム側で書き換えても
#     次の起動で消える。配布物に編集の口は無い(runner プロファイル)が、
#     ボリュームを直接いじれば書き換えられる。
if [ -d "${DATA_ROOT}/apps/${APP_ID}" ] && [ -f "${IMAGE_DATA}/apps/${APP_ID}/manifest.json" ]; then
  cp "${IMAGE_DATA}/apps/${APP_ID}/manifest.json" "${DATA_ROOT}/apps/${APP_ID}/manifest.json"
fi

export ST_DATA_ROOT="${DATA_ROOT}"
exec bun run /app/src/server/index.ts
