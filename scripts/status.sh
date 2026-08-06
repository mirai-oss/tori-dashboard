#!/usr/bin/env bash
# =====================================================================
# tori-dashboard 現状チェック（作業を始める前に必ず実行）
#
#   bash scripts/status.sh
#
# ドキュメントは古くなるが、ここで見る値（ping / 公開ファイル / git）は
# 「今この瞬間の本当の状態」。食い違ったら実測を信じること。
# 認証情報は一切使わない・書かない（Publicリポジトリのため）。
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

GAS_URL='https://script.google.com/macros/s/AKfycbz9rd37EZa6X8WRMVEBrXobN8DbYWkHRlhFNYU5rd1UZ0V8j0-6shMQjEeoi4HDWZ0B/exec'
PAGES_URL='https://mirai-oss.github.io/tori-dashboard'
warn=0

echo "════════════════════════════════════════════════"
echo " tori-dashboard 現状チェック  $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════"

# ---------- 1. git（並行セッションの検出） ----------
echo
echo "▼ 1. git（他のセッションが先行していないか）"
git fetch origin -q 2>/dev/null
sb=$(git status -sb | head -1)
echo "   $sb"
if echo "$sb" | grep -q 'behind'; then
  echo "   ⚠️  リモートが先行しています。必ず rebase で統合してください（上書き厳禁）"
  echo "      git stash && git pull --rebase origin main && git stash pop"
  warn=$((warn+1))
fi
if echo "$sb" | grep -q 'ahead'; then
  echo "   ℹ️  未pushのコミットがあります"
fi
dirty=$(git status --short | wc -l | tr -d ' ')
if [ "$dirty" != "0" ]; then
  echo "   ℹ️  未コミットの変更 ${dirty}件:"
  git status --short | sed 's/^/      /'
fi
echo "   直近のコミット:"
git log --oneline -3 --format='      %h %ad %s' --date=format:'%m/%d %H:%M'

# ---------- 2. GAS（本番に何が出ているか） ----------
echo
echo "▼ 2. GAS（本番デプロイ版）"
repo_ver=$(grep -o "ver: '[^']*'" gas/Code.gs 2>/dev/null | head -1 | sed "s/ver: '//;s/'//")
live_ver=$(curl -sL -m 30 "${GAS_URL}?action=ping" 2>/dev/null | sed -n 's/.*"ver":"\([^"]*\)".*/\1/p')
echo "   リポジトリ: ${repo_ver:-取得失敗}"
echo "   本番稼働中: ${live_ver:-応答なし}"
if [ -z "$live_ver" ]; then
  echo "   ⚠️  GASが応答しません（デプロイ削除・認可切れの可能性）"
  warn=$((warn+1))
elif [ "$repo_ver" != "$live_ver" ]; then
  echo "   ⚠️  不一致 = Code.gsの変更が未デプロイ。ユーザーに貼り替え＋再デプロイを依頼すること"
  echo "      （デプロイを管理 → 編集(鉛筆) → 新バージョン → デプロイ）"
  warn=$((warn+1))
else
  echo "   ✅ 一致（リポジトリの内容が本番に出ています）"
fi

# ---------- 3. GitHub Pages（公開中のapp.js） ----------
echo
echo "▼ 3. GitHub Pages（公開中のフロント）"
local_v=$(grep -o 'app\.js?v=[0-9]*' index.html 2>/dev/null | head -1 | sed 's/.*v=//')
live_v=$(curl -sL -m 30 "${PAGES_URL}/index.html" 2>/dev/null | grep -o 'app\.js?v=[0-9]*' | head -1 | sed 's/.*v=//')
echo "   ローカル: v=${local_v:-?}"
echo "   公開中  : v=${live_v:-取得失敗}"
if [ -n "$live_v" ] && [ "$local_v" != "$live_v" ]; then
  echo "   ⚠️  不一致 = 未pushか、Pagesのデプロイ待ち（1〜2分）"
  warn=$((warn+1))
elif [ -n "$live_v" ]; then
  echo "   ✅ 一致"
fi

# ---------- 4. 依存する外部サービス ----------
# BigQueryの生死はログイン必須（未認証だとBQに到達する前にunauthorizedで弾かれ、
# 「生きている」と誤判定する）。認証情報はPublicリポジトリに置けないので、
# 確認したいときだけ環境変数でトークンを渡す。
#   T=$(curl -sL "$GAS_URL?action=login&id=<ID>&pw=<PW>" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
#   DASH_TOKEN=$T bash scripts/status.sh
echo
echo "▼ 4. 外部サービス（BigQuery）"
if [ -z "${DASH_TOKEN:-}" ]; then
  echo "   ⏭️  スキップ（要ログイン）。確認するには:"
  echo "      DASH_TOKEN=<ログインで得たtoken> bash scripts/status.sh"
else
  bq=$(curl -sL -m 60 "${GAS_URL}?action=bqDetail&token=${DASH_TOKEN}&from=2026-01-01&to=2026-01-02" 2>/dev/null)
  case "$bq" in
    *"BigQuery is not defined"*)
      echo "   ⚠️  停止中（appsscript.jsonから高度なサービスが消えています）"
      echo "      → 明細分析タブと毎朝のdinii-ordersが失敗します。gas/appsscript_注意.md 参照"
      warn=$((warn+1));;
    *'"ok":true'*) echo "   ✅ 生存（集計が返りました）";;
    *"unauthorized"*) echo "   ？ トークンが無効です（期限12時間）。取り直してください";;
    *) echo "   ？ 判定不能 → ${bq:0:80}";;
  esac
fi

# ---------- 5. 未完了タスク ----------
echo
echo "▼ 5. HANDOFF.md の未完了タスク"
awk '/^## 3\. 未完了のタスク/,/^## 4\./' HANDOFF.md 2>/dev/null \
  | grep -E '^\| *(⏳|💡)' | sed 's/^/   /' | head -12
echo
echo "   最新の作業ログ:"
grep -m3 -E '^### 20[0-9]{2}-' HANDOFF.md 2>/dev/null | sed 's/^/      /'

# ---------- まとめ ----------
echo
echo "════════════════════════════════════════════════"
if [ "$warn" -eq 0 ]; then
  echo " ✅ 要対応なし。作業を開始できます"
else
  echo " ⚠️  要注意 ${warn}件（上の⚠️を確認してから作業を始めること）"
fi
echo "════════════════════════════════════════════════"
