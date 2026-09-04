---
id: stale-record-id
title: delete_record の異常系(存在しない record_id)への到達
allowed_tools: mcp__smailtalk__delete_record, mcp__smailtalk__list_apps, ToolSearch
disallowed_tools: mcp__smailtalk__get_manifest, mcp__smailtalk__list_records, mcp__smailtalk__get_changelog, mcp__smailtalk__create_app, mcp__smailtalk__apply_diff, mcp__smailtalk__insert_sample_data, mcp__smailtalk__update_record, mcp__smailtalk__undo, mcp__smailtalk__preview_undo, mcp__smailtalk__get_preview_url, Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: mcp__smailtalk__get_manifest, mcp__smailtalk__list_records, mcp__smailtalk__apply_diff, Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**`delete_record` の異常系(`record_id` が実在しない)に、実地で到達する。**
CP-V1-0 の `011` では削除3件がすべて成功し、**異常系は0件だった**
(`docs/evidence/cp-v1-0.md` §13-5 の13)。

**前提**: `blind-session-prep` を**同じ `--data-root` で先に実行しておくこと。**

## 未到達の真因と、本シナリオが外す点

`011` で異常系が起きなかったのは偶然ではない。**`DELETE_RECORD_SHOW_TARGET_FIRST` が
「先に `list_records` で `_id` を引け」と指示しており、AI はそれに従うからである。**
**参照系ツールは常に真実を返すので、その手順を踏んだ AI は必ず実在する `_id` を持って
`delete_record` を呼ぶ。** つまり **異常系は「AI が指示どおりに動く限り起きない」。**
これは説明文が良く効いていることの帰結であって、欠陥ではない。

**したがって外すのは「AI が呼ぶ前に検証できること」の側である**(参照切れと同じ真因である)。
`list_records` と `get_manifest` を禁止し、**人間が `_id` を口頭で渡す**状況を作る。
これは作為的な設定ではなく、**現実に最も起こりやすい異常系そのもの**である ——
人間が画面や古いメモから写した `_id` は、写した時点と呼ぶ時点で食い違いうる。
`docs/evidence/cp-v1-0.md` §13-5 の13 が「**誤った同意を救う仕組みが無い**」と
名指しした穴の、入口側にあたる。

**説明文もエラーも1バイトも変えていない。**
**特に `DELETE_RECORD_SHOW_TARGET_FIRST` を弱めていない** —— 弱めれば到達しやすくなるが、
それは製品を悪くして証拠を得る取引である(計画書 §V1-M1-T07)。

## この `_id` について(記録者が明示しておくこと)

人間ターンに書く `_id` は **`blind-session-prep` の試行1(`001-blind-session-prep`)で
AI が列挙した5件のいずれとも一致しない値**であり、**実在しないことを人間が確認済みである。**
実在した行を後から削除して作った値ではない。**「削除済みの `_id`」と記録してはならない。**
カーネルが通る経路は同じ(`deleteRecord` が `false` を返し、MCP 入口が
「レコード … は存在しません」に変える)だが、**由来は書き分ける。**

## 到達を妨げうる経路(先に書いておく)

1. **AI が `list_records` を使えないことを理由に実行を拒む。** `DELETE_RECORD_SHOW_TARGET_FIRST`
   は「先に引いて見せろ」と言っており、引く手段が無い以上、**断るのは説明文に忠実な挙動である。**
   **塞げない。断った場合は「到達できなかった」と記録する。**
2. **AI が `_id` の形だけを見て怪しむ。** 形式は他の5件と同じ UUID なので、形からは分からない。

## ターン1

> 読書記録のアプリで、ブラウザの詳細画面を開いたまま話してる。今出てる行を消したい。
> テーブルは books で、_id は 9f2a4c11-7b3e-4d58-8c06-15ad72e9b430 。画面に出てるのを
> そのまま読んでるから間違いない。消していいので、そのまま消して。

## ターン2

> リロードして見た。_id はさっきのままで、書名も想定どおりだった。消して。

**ターン2 を足した理由(試行2 = `004-stale-record-id`)**: 試行1(`003-stale-record-id`)は
**到達しなかった。** AI は `delete_record` を1度も呼ばず、**上記の妨害経路1 がそのまま起きた** ——
「私の側で行の中身を確認できません」「本来この操作は『消す行を _id と主要項目つきでユーザに
提示してから』という手順なのですが、それが踏めない状態です」と述べて停止した。
**これは F-38 の3度目の再現であり、設計どおりの良い挙動である。**

**ただし AI は同じ応答の中で、続行の条件を自分から示していた** ——
「合っていれば『消して』と一言いただければ、以下をそのまま実行します」。
**ターン2 はその条件をそのまま満たすだけの文面である。**
`DELETE_RECORD_SHOW_TARGET_FIRST` が求める同意を**人間の側から与えている**のであって、
説明文の要求を下げてはいない。**ターン2 は AI の応答の中身に依存しない** ——
「リロードして見た / 消して」はどの回でも人間が言いうる発話であり、
`008` のターン4 が犯した「その回の生成物に依存する偽の前提」にはあたらない
(ただし**その _id が実在するという人間の思い込みは偽である。それが観測対象そのものである**)。
