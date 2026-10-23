FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /console .

# Static binary, no shell.
FROM scratch
COPY --from=build /console /console
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/console"]
