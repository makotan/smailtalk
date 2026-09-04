---
id: error-self-correction
title: 型名・ビュー形の誤りからの自己修正
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**ツールエラーを読んで、人間の追加入力なしに修正版を再適用し成功するか**を観測する。
CP-5 では並び順の指定(`sort` の形)とビュー更新の形で、いずれも人間の入力0回で直っている
(docs/evidence/cp-5.md 確認方法4 観察1・観察2)。

判定は judge の `errorEpisodes` を見る。`selfCorrected: true` かつ `humanInputBetween: false`
であるものが「自力の修正」である。ターンをまたいで直った場合は人間の助けが入っているので数えない。

ターン2は存在しない型を名指しする。ここは拒否になることも多い(CP-5 の selfcorrect-1 は拒否になった)。
**拒否になった場合は自己修正の観察としては空振りだが、拒否の観察としては有効**なので、判定を書き換えず記録する。

## ターン1

> 読んだ本を記録するアプリを作って。
> タイトル・著者・状態・評価・読み始めと読み終わりの日付・感想メモが欲しい。
> 画面は一覧・詳細・登録フォームの3つ。一覧は読み終わりの日付が新しいものから並べて。

## ターン2

> 購入金額を通貨型で、タグを複数選択型で持てるようにして。一覧にも両方出して。

## ターン3

> 一覧に出す項目を、タイトル・著者・状態だけに絞って。並びは評価の高い順にして。
