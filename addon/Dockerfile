# Built from the repository root:
#   docker build -f addon/Dockerfile -t guest-assistant .
# The guest frontend must be built into ./public first
# (guest-assistant-frontend: script/build_guest_assistant, then copy guest-assistant/dist).

# The admin page is built with Bun (Svelte + Tailwind plugins, no Vite).
FROM oven/bun:1.4-alpine AS admin-ui
WORKDIR /app
COPY package.json bun.lock ./
COPY admin-ui/package.json ./admin-ui/
RUN bun install --frozen-lockfile
COPY admin-ui ./admin-ui
RUN bun run build:admin

FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
COPY admin-ui/package.json ./admin-ui/
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./
COPY public ./public
COPY --from=admin-ui /app/admin-ui/dist ./admin-ui/dist

ENV PORT=3001 INGRESS_PORT=8099 DATA_DIR=/data
EXPOSE 3001 8099
CMD ["bun", "run", "src/index.ts"]
