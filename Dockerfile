# Один контейнер на весь проект: собирает мини-апп и сервер, запускает сервер,
# который сам отдаёт статику. Railway иначе принимает npm workspaces за монорепу
# и заводит по сервису на воркспейс.

FROM node:22-slim AS builder

# better-sqlite3 — нативный модуль. Обычно ставится из prebuild,
# но инструменты сборки нужны как запасной путь.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Манифесты отдельным слоем: пока зависимости не менялись, слой берётся из кеша.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY miniapp/package.json miniapp/
RUN npm ci

COPY . .
RUN npm run build

# Из образа уезжают только прод-зависимости: vite, typescript и tsx уже отработали.
RUN npm prune --omit=dev


FROM node:22-slim AS runtime

ENV NODE_ENV=production

# Загрузка по ссылке: ffmpeg извлекает аудио, yt-dlp разбирает страницы площадок.
# Берём готовый бинарник с релизов, а не пакет из Debian: тот отстаёт на месяцы,
# а YouTube ломает загрузку регулярно — свежесть здесь важнее воспроизводимости.
# Версия закреплена намеренно: обновление меняет поведение и должно быть решением.
ARG YTDLP_VERSION=2026.08.19
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
     -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && /usr/local/bin/yt-dlp --version \
  && apt-get purge -y --auto-remove curl \
  && rm -rf /var/lib/apt/lists/*

# cwd — server/, поэтому статика находится по относительному пути ../miniapp/dist.
WORKDIR /app/server

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/miniapp/dist /app/miniapp/dist
COPY --from=builder /app/server/package.json ./package.json
COPY --from=builder /app/server/dist ./dist

# Не всё хойстится в корневой node_modules: drizzle-orm из-за своих peer-зависимостей
# остаётся локальным для воркспейса, и без этого слоя сервер падает на импорте.
COPY --from=builder /app/server/node_modules ./node_modules

CMD ["node", "dist/index.js"]
