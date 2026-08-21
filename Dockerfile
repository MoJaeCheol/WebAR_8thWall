# Render 배포용 — Node 웹서버 + Python 측위 서버를 한 컨테이너에서 돌린다.
# 로컬 개발 구조(Node → 127.0.0.1:8000 중계)를 그대로 유지하기 위함이다.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 레이어 (소스보다 먼저 — 캐시 활용)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY vps/requirements-server.txt vps/
RUN python3 -m venv /venv \
  && /venv/bin/pip install --no-cache-dir -r vps/requirements-server.txt

# 앱 소스 + 맵 (data/maps 는 커밋되어 있어야 한다)
COPY . .

ENV NODE_ENV=production
CMD ["./start.sh"]
