---
id: bootstrap
title: ブートストラップ課題(プラットフォーム管理アプリ)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

本命のシナリオ。V0-P6-T03「会話**だけ**で第一号アプリ『プラットフォーム管理』を作る」を実施する。
完成条件は (1) 実在する全アプリの一覧が見える (2) 各アプリの diff 履歴が intent 付きで読める、の2点
(docs/plan/v0/07-bootstrap.md V0-P6-T03)。

プロンプトには **JSON もマニフェストの断片も一切書かない**。完成形を貼れば AI は転記するだけになり、
「会話だけで作れた」という主張が成立しなくなるため、judge が機械的に弾く(prompt-lint.ts)。
人間の役割はプロンプト・ブラウザでの確認・承認の発話だけである。

## ターン1

> このプラットフォームで育てたアプリを、私が普段使いできる管理画面にしたい。
> まずは、今このプラットフォームにあるアプリが一覧で見られるところまで作って。
> アプリの名前と、いつ作られたかが分かれば十分です。

## ターン2

> ブラウザで見ました。アプリの一覧が出ています。
> 次に、それぞれのアプリがどう変わってきたのかの履歴も見たい。
> いつ・どの変更が・どういう意図で入ったのかが読める形にしてください。

## ターン3

> 履歴も画面で読めました。並びは新しいものが上に来るようにしてほしい。
> あと、この管理アプリ自身もアプリ一覧に出ているはずなので、それも確認したい。

## ターン4

> 確認できました。最後に、いまの画面を見るための URL を教えてください。
> それと、この管理アプリを作るまでにあなたが入れた変更が、この管理アプリ自身の履歴画面で
> ちゃんと読める状態になっているかも確かめてください。
