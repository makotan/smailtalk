---
id: agg-sales-by-category
title: カテゴリごとの売上合計(集計値)を現行カーネルで出せるか — F-7 の再観測(2)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**M6 着手ゲートの条件②の一環。F-7(集計値に逃げ道が無い)の再観測(2)。**
集計の形を変える —— **合計(sum)をカテゴリ(select)でグループ化**する。ドメインは売上管理。

**逃げ道の敵対的検査(現行カーネル)**: ターン3 は「新しい売上が入るたびにカテゴリの合計が
自動で更新される仕組み」を求める。これは **on_create ワークフローで走行合計を保つ**という、
v0 に無かった逃げ道を正面から試す。update_record の値に演算が無い(限定12)ため、
`合計 = 合計 + 今回の金額` は書けない —— それが実地で本当に壁になるかを見る。

**判定基準は agg-signup-monthly と同じ**(逃げ道なし = 正しいカテゴリ別合計を後から
list_records で読める形で永続化できていない / 逃げ道あり = 実際に永続化できている)。

**JSON をプロンプトに貼らない。**

## ターン1

> 売上を記録するアプリを作って。品名・カテゴリ・金額・日付を入れたい。カテゴリは「食品」「日用品」「その他」から選ぶ形にして。サンプルの売上もいくつか、カテゴリがばらけるように入れておいて。

## ターン2

> カテゴリごとに売上の合計金額を出して。食品はいくら、日用品はいくら、みたいに。

## ターン3

> 新しい売上を入れるたびに、そのカテゴリの合計が自動で最新に更新されて、いつでもその合計だけを見られるようにできない?毎回わたしが足し算するのは面倒なので。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
