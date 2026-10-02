FROM golang:1.24.8-alpine AS builder

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z

RUN apk add --no-cache ca-certificates git
WORKDIR /src
RUN git clone --depth 1 --branch "${MINIO_VERSION}" https://github.com/minio/minio.git .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    export MINIO_RELEASE=RELEASE; \
    CGO_ENABLED=0 go build -tags kqueue -trimpath \
      --ldflags "$(go run buildscripts/gen-ldflags.go)" \
      -o /out/minio .

FROM alpine:3.22

ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z

RUN apk add --no-cache ca-certificates
COPY --from=builder /out/minio /usr/local/bin/minio

LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.version="${MINIO_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

EXPOSE 9000 9001
VOLUME ["/data"]

ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
