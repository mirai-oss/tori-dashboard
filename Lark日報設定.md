# Lark 自動日報・週報・月報の設定手順

ダッシュボードの売上を1枚の画像レポートにして、Larkのグループへ自動投稿します。

## 配信スケジュール（自動）

| 種類 | タイミング | 内容 |
|---|---|---|
| **日報** | 毎日 12:00 | 前日の店舗別売上・前年比・客数・客単価・月間累計（画像1枚） |
| **週報** | 毎月 1・8・15・22・29日 12:10 | 直前の週ブロック（1〜7日 / 8〜14日 / 15〜21日 / 22〜28日 / 29〜末日） |
| **月報** | 毎月1日 12:20 | 前月の店舗別売上・前年比・FL率など |

しくみ: GitHub Actions（無料）が定時にダッシュボードを開いてスクリーンショット → Lark に投稿。サーバー不要です。

---

## セットアップ（1回だけ・約15分）

### STEP 0: 定時実行ワークフローを配置する（GitHubの画面で1回だけ）
※権限の都合でこのファイルだけ手動配置が必要です。

1. このリンクを開く（新規ファイル作成画面が開きます）:
   **https://github.com/mirai-oss/tori-dashboard/new/main?filename=.github/workflows/lark-report.yml**
2. 内容には、リポジトリ内の **[scripts/lark-report.workflow.yml](https://github.com/mirai-oss/tori-dashboard/blob/main/scripts/lark-report.workflow.yml)** を開いて「Raw」→全文コピーして貼り付け
3. 右上の「Commit changes...」→ そのまま Commit

これで毎日12:00（JST）に自動起動するようになります（Secrets未設定の間は安全にスキップされます）。

### STEP 1: Bot用のログインアカウントを作る
スプレッドシートの「アカウント」タブに1行追加：

| ログインID | パスワード | 表示名 | 権限 | 担当店舗 | 有効 |
|---|---|---|---|---|---|
| report | （強いパスワード） | 日報Bot | 本部 | 全店 | TRUE |

### STEP 2: Larkグループに Webhook ボットを追加
1. 配信したいLarkグループを開く → 右上「…」→ **設定 → ボット → ボットを追加**
2. **「カスタムボット（Custom Bot）」** を選んで追加
3. 発行された **Webhook URL** をコピー（`https://open.larksuite.com/open-apis/bot/v2/hook/...`）

### STEP 3: 画像送信用の Lark アプリを作る（画像1枚で送るために必要）
1. https://open.larksuite.com/app （日本のLarkの場合。Feishuなら open.feishu.cn）にログイン
2. **「カスタムアプリ（企業向けアプリ）を作成」** → 名前は「日報Bot」など
3. 左メニュー **権限管理** → 検索で `im:resource` または「画像」→ **「画像のアップロード（im:resource / im:image:upload）」権限を追加**
4. **バージョンを作成して公開**（社内利用の承認）
5. **アプリID（App ID）** と **App Secret** を控える（基本情報ページ）

> STEP 3 を飛ばしてもOK：その場合は画像の代わりに数値サマリーのカードが届きます（後からSecretsを足せば画像に切り替わります）。

### STEP 4: GitHub に Secrets を登録
https://github.com/mirai-oss/tori-dashboard → **Settings → Secrets and variables → Actions → New repository secret** で以下を登録：

| Name | 値 |
|---|---|
| `DASH_ID` | report（STEP 1のID） |
| `DASH_PW` | STEP 1のパスワード |
| `LARK_WEBHOOK` | STEP 2のWebhook URL |
| `LARK_APP_ID` | STEP 3のApp ID（画像送信する場合） |
| `LARK_APP_SECRET` | STEP 3のApp Secret（同上） |
| `LARK_DOMAIN` | （Feishu利用時のみ）`https://open.feishu.cn` |

### STEP 5: テスト実行
1. リポジトリの **Actions** タブ → 左の「Lark自動レポート（日報・週報・月報）」
2. 「Run workflow」→ kind: **daily** → Run
3. 1〜3分でLarkグループに日報が届けば完了 🎉
   - 失敗した場合はログ（赤い×のステップ）と、Artifactsの `report.png` を確認

---

## 補足

- **配信時刻の変更**: `.github/workflows/lark-report.yml` の cron を編集（UTC表記。JST-9時間。例 12:00 JST = `0 3 * * *`）
- **レポートの見た目確認**: ダッシュボードにログインして、URL末尾に `?report=daily`（weekly / monthly も可、`&date=2026-07-01` で日付指定）を付けると、配信されるカードと同じ画面が見られます
- **土台のデータ**: 日報は「前日」分です（朝のデータ取込後の12:00に配信するため）
- GitHub Actions のスケジュールは数分遅れることがあります（GitHub側の仕様）
