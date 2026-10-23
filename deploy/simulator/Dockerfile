# TEST ONLY: simulated vCenter / ESXi (services/vmware/cmd/simulator), built with the same pinned
# govmomi as the adapter. Build context: services/vmware.
FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/simulator ./cmd/simulator
RUN CGO_ENABLED=0 go build -trimpath -o /simulator ./cmd/simulator

FROM alpine:3.22
COPY --from=build /simulator /simulator
USER 1000:1000
ENTRYPOINT ["/simulator"]
