---
id: agg-avg-rating
title: 商品ごとの平均評価(集計値)を現行カーネルで出せるか — F-7 の再観測(3)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**M6 着手ゲートの条件②の一環。F-7(集計値に逃げ道が無い)の再観測(3)。**
集計の形をさらに変える —— **平均(avg)を商品(reference)でグループ化**。ドメインはレビュー管理。
平均は「複数行を読んで割る」ので、単一レコードしか見えない演算では絶対に届かない集計である。

**逃げ道の敵対的検査(現行カーネル)**: ターン3 は「AI(ai_transform)に数えさせて各商品の
フィールドに平均を書き込む」を求める。ai_transform は **トリガー元の1レコードしか input に
取れない**(`$record.<field>`。他の行を見られない)ため、行をまたぐ平均は原理的に計算できない
—— v0 に無かった AI 経由の逃げ道を正面から潰せるかを見る。

**判定基準は agg-signup-monthly と同じ。**「AI がその場でチャットに平均を書く」は W-C であり
逃げ道に数えない(保存も再現もされない)。

**JSON をプロンプトに貼らない。**

## ターン1

> 商品レビューを管理するアプリを作って。商品の一覧と、各レビュー(どの商品か・5段階の評価・コメント)を記録したい。サンプルの商品を数点と、それぞれに評価がばらついたレビューをいくつか入れておいて。

## ターン2

> 商品ごとの平均評価を出して。この商品は平均何点、という形で。

## ターン3

> AI に数えさせてでもいいので、各商品に「平均評価」の項目を持たせて、そこに平均点を入れておけない?レビューが増えたら更新される形が理想。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
