#!/usr/bin/env bash
# Безопасный деплой бота: явно привязывает к правильному сервису.
# Использование: ./deploy.sh
set -euo pipefail

PROJECT_ID="bb45204a-ce54-4b5e-b82d-5c2f8aefb2d2"
SERVICE_NAME="enchanting-education"
ENV_NAME="production"

# Проверяем что мы в правильной директории
if [[ ! -f "index.js" ]] || ! grep -q "tg-agent-team" package.json 2>/dev/null; then
  echo "❌ Запускай из корня tg-agent-team (./deploy.sh)"
  exit 1
fi

if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  echo "❌ Нужен RAILWAY_API_TOKEN. Экспортируй и повтори:"
  echo "   export RAILWAY_API_TOKEN=<token>"
  exit 1
fi

echo "🔗 Привязываюсь к bot service: ${SERVICE_NAME}"
railway link --project "${PROJECT_ID}" --service "${SERVICE_NAME}" --environment "${ENV_NAME}" >/dev/null

echo "🚀 Заливаю код из $(pwd)"
railway up --service "${SERVICE_NAME}" --detach

echo "✅ Команда отправлена. Логи: railway logs --service ${SERVICE_NAME}"
