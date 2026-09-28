# Built from the repository root:
#   docker build -f addon/Dockerfile -t guest-assistant .
# The guest frontend must be built into ./public first
# (guest-assistant-frontend: script/build_guest_assistant, then copy guest-assistant/dist).
FROM oven/bun:1.4-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./
COPY public ./public

ENV PORT=3001 INGRESS_PORT=8099 DATA_DIR=/data
EXPOSE 3001 8099
CMD ["bun", "run", "src/index.ts"]
