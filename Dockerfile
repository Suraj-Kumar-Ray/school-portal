# ============================================================================
# GREEN VALLEY PUBLIC SCHOOL portal — production container
# ----------------------------------------------------------------------------
# The school's data is ONE SQLite file (data/school.db). Everything else can be
# rebuilt; that file cannot. A Docker volume mounted on /app/data keeps it alive
# across restarts, updates and rebuilds — never ship a container without it.
#
#   docker build -t school-portal .
#   docker run -d -p 3000:3000 \
#     -e SESSION_SECRET="$(openssl rand -hex 32)" \
#     -v school-data:/app/data \
#     --name school school-portal
# ============================================================================

FROM node:18-bookworm-slim

# better-sqlite3 ships prebuilt binaries for node 18; build tools only kick in
# when no binary matches, so keep them present and the image never fails to build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Dependencies first — this layer only rebuilds when package.json changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# The application.
COPY server.js Dockerfile render.yaml ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY db ./db

# Where the database lives (override with -e DATA_DIR=... if the disk is mounted elsewhere).
ENV DATA_DIR=/app/data \
    PORT=3000
VOLUME ["/app/data"]

EXPOSE 3000

# The platform's probe hits /healthz (src/app.js) — it queries the database, so a
# half-dead process never passes as healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
