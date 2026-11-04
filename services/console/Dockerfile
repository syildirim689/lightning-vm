FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /console .

# Host terminal for administrators (compose service "terminal", off by default): nsenter enters the host as root.
FROM alpine:3.24 AS terminal
RUN apk add --no-cache util-linux-misc
COPY --from=build /console /console
EXPOSE 8080
ENTRYPOINT ["/console"]
CMD ["terminal"]

# Static binary, no shell.
FROM scratch
COPY --from=build /console /console
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/console"]
