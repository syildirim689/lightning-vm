FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /vmware .

# Static binary, no shell; uid 1000 matches the owner of the mounted service token file.
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /vmware /vmware
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/vmware"]
