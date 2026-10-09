# Built by the Supervisor from the folder that scripts/build-addon.sh packages
# (dist/addon/guest_assistant) and that CI builds the images from. app.tar.gz holds the source plus the already
# built guest frontend (public) and admin page (admin-ui/dist); only runtime
# dependencies are installed here.
FROM oven/bun:1.4-alpine
# Set by the Supervisor when it builds on the device, and by CI.
ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL io.hass.type="addon" io.hass.name="Guest Assistant" io.hass.arch="${BUILD_ARCH}" io.hass.version="${BUILD_VERSION}" \
      org.opencontainers.image.source="https://github.com/wendevlin/guest-assistant" org.opencontainers.image.licenses="Apache-2.0"
# su-exec lets entrypoint.sh drop from root to `bun` once /data is prepared.
COPY entrypoint.sh /usr/local/bin/guest-assistant-entrypoint
RUN apk add --no-cache su-exec && chmod 755 /usr/local/bin/guest-assistant-entrypoint
WORKDIR /app
ADD app.tar.gz ./
RUN bun install --production --frozen-lockfile

ENV PORT=3123 INGRESS_PORT=8099 DATA_DIR=/data
EXPOSE 3123 8099
# The proxy runs as `bun`, not root (entrypoint.sh); both ports are unprivileged.
ENTRYPOINT ["/usr/local/bin/guest-assistant-entrypoint"]
CMD ["bun", "run", "src/index.ts"]
