# Built by the Supervisor from the folder that scripts/build-addon.sh packages
# (dist/addon/guest_assistant). app.tar.gz holds the source plus the already
# built guest frontend (public) and admin page (admin-ui/dist); only runtime
# dependencies are installed here.
FROM oven/bun:1.4-alpine
# Set by the Supervisor when it builds on the device, and by CI.
ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL io.hass.type="addon" io.hass.name="Guest Assistant" io.hass.arch="${BUILD_ARCH}" io.hass.version="${BUILD_VERSION}" \
      org.opencontainers.image.source="https://github.com/wendevlin/guest-assistant" org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ADD app.tar.gz ./
RUN bun install --production --frozen-lockfile

ENV PORT=3001 INGRESS_PORT=8099 DATA_DIR=/data
EXPOSE 3001 8099
CMD ["bun", "run", "src/index.ts"]
