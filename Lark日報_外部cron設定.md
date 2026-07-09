# 日報を毎日12:00ちょうどに届ける（外部cron設定ガイド）

GitHub内蔵のスケジュールは時刻が数十分〜数時間ずれます（無料/publicリポジトリの仕様）。
そこで **cron-job.org（無料）** から毎日12:00にGitHubのAPIを叩いて、日報ワークフローを正確に起動します。

所要 約10分・一度きりの設定です。

---

## ステップ1: GitHubトークン（PAT）を作る

外部サービスがあなたの代わりにワークフローを起動するための鍵です。

1. https://github.com/settings/personal-access-tokens/new を開く（Fine-grained token）
2. 次のとおり設定:
   - **Token name**: `cron-lark-report`（任意）
   - **Expiration**: `No expiration`（または1年。切れると止まるので長め推奨）
   - **Resource owner**: `mirai-oss`
   - **Repository access**: `Only select repositories` → **`mirai-oss/tori-dashboard`** を選択
   - **Repository permissions** → **Actions** を **`Read and write`** に変更
     （Metadata: Read-only は自動で付きます。他は変更不要）
3. **Generate token** を押し、表示された `github_pat_xxxxx...` を**コピー**（この画面を離れると二度と見えません）

> このトークンは cron-job.org に貼り付けるだけで、コードやGitHubには保存しません。

---

## ステップ2: cron-job.org でジョブを3つ作る

1. https://cron-job.org/en/ に登録・ログイン（無料）
2. **右上 Account → 表示タイムゾーンを `Asia/Tokyo` に設定**（時刻をJSTで指定できる）
3. **Create cronjob** で以下を **3つ** 作成します。共通設定は下記、違うのは「時刻」と「本文の kind」だけです。

### 3ジョブ共通の設定

| 項目 | 値 |
|---|---|
| **URL** | `https://api.github.com/repos/mirai-oss/tori-dashboard/actions/workflows/lark-report.yml/dispatches` |
| **Request method** | `POST` |
| **Advanced → Headers** | 下記3行を追加 |
| **Advanced → Request body** | 下記（ジョブごとに kind を変える） |

**Headers（3行）**:
```
Authorization: Bearer ここにステップ1のトークンを貼る
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

### ジョブ①　日報（毎日 12:00）
- **Schedule**: Every day / 12:00
- **Request body**:
```json
{"ref":"main","inputs":{"kind":"daily"}}
```

### ジョブ②　週報（1・8・15・22・29日 12:10）
- **Schedule**: Custom → Days of month に `1,8,15,22,29` / 12:10
- **Request body**:
```json
{"ref":"main","inputs":{"kind":"weekly"}}
```

### ジョブ③　月報（毎月1日 12:20）
- **Schedule**: Custom → Day of month `1` / 12:20
- **Request body**:
```json
{"ref":"main","inputs":{"kind":"monthly"}}
```

> ヒント: cron-job.org の各ジョブに「Enable」を付け、Content type が `application/json` になっていればOK。
> body欄の下に content type 設定がある場合は `application/json` を選んでください。

---

## ステップ3: 動作テスト

- ジョブ①の詳細画面で **「Run now」（今すぐ実行）** を押す
- GitHub → Actions に「Lark自動レポート」の新しい実行が数秒で現れれば成功
- 少ししてLarkに日報カードが届けばOK（成功なら以後、毎日12:00ちょうどに届きます）

うまくいかない時に多い原因:
- トークンの権限が **Actions: Read and write** になっていない
- URL末尾が `/dispatches` になっていない
- body の `kind` のスペルミス（daily/weekly/monthly）

---

## 補足

- **GitHub内蔵スケジュールは無効化済み**（遅延の原因なので外しました）。外部cronが唯一のトリガーです。
- 手動で送りたい時は、GitHub → Actions →「Lark自動レポート」→ Run workflow から種別を選んで実行できます。
- 対象店舗（8店舗版）を変えたい時は `.github/workflows/lark-report.yml` の `REPORT_STORES:` を編集。
- 過去の特定日を送り直したい時は、私（Claude）に「6/15の週報を送って」等と言ってください（`REPORT_DATE` で対応）。
