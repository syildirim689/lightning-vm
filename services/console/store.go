package main

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisStore shares state with the API through Redis. Keys:
//
//	<ns>:session:<sha256(token)>     one-time session written by the API (GETDEL here, 60 s TTL); ns is
//	                                 "console" or "terminal" (the host terminal mode)
//	<ns>:active                      hash of live sessions, for the admin list
//	console:events                   stream the worker copies into audit_events
//	console:revoke                   pub/sub channel the API publishes revocations on
//	console:revoked:user:<id>        markers the API sets with a revocation (the time in Unix milliseconds, 90 s TTL),
//	console:revoked:auth:<hash>      for tickets issued before it and not redeemed yet; both gateways read them
//	console:revoked:all
type redisStore struct {
	rdb *redis.Client
	ns  string
}

func (s *redisStore) Consume(ctx context.Context, key string) (*Session, error) {
	raw, err := s.rdb.GetDel(ctx, s.ns+":session:"+key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var sess Session
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil, err
	}
	sess.Key = key
	return &sess, nil
}

func (s *redisStore) Revoked(ctx context.Context, sess *Session) (bool, error) {
	keys := []string{"console:revoked:all"}
	if sess.UserID != "" {
		keys = append(keys, "console:revoked:user:"+sess.UserID)
	}
	if sess.AuthHash != "" {
		keys = append(keys, "console:revoked:auth:"+sess.AuthHash)
	}
	values, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return false, err
	}
	for _, v := range values {
		text, ok := v.(string)
		if !ok {
			continue // no marker under this key
		}
		// A marker that cannot be read as a time counts: it is there because something was revoked.
		if at, err := strconv.ParseInt(text, 10, 64); err != nil || at >= sess.IssuedAt {
			return true, nil
		}
	}
	return false, nil
}

func (s *redisStore) Active(ctx context.Context, sess *Session, started time.Time) error {
	v, _ := json.Marshal(map[string]any{"userId": sess.UserID, "vm": sess.VM, "vmName": sess.VMName, "connectionId": sess.ConnectionID, "startedAt": started.UTC()})
	return s.rdb.HSet(ctx, s.ns+":active", sess.Key, v).Err()
}

func (s *redisStore) Inactive(ctx context.Context, sess *Session) error {
	return s.rdb.HDel(ctx, s.ns+":active", sess.Key).Err()
}

func (s *redisStore) Event(ctx context.Context, fields map[string]any) {
	fields["at"] = time.Now().UTC().Format(time.RFC3339Nano)
	if err := s.rdb.XAdd(ctx, &redis.XAddArgs{Stream: "console:events", MaxLen: 10000, Approx: true, Values: fields}).Err(); err != nil {
		logger.Error("console_event_failed", "error", err.Error())
	}
}

func (s *redisStore) Revocations(ctx context.Context) <-chan Revocation {
	out := make(chan Revocation)
	sub := s.rdb.Subscribe(ctx, "console:revoke")
	go func() {
		defer close(out)
		defer sub.Close()
		for msg := range sub.Channel() {
			var r Revocation
			if json.Unmarshal([]byte(msg.Payload), &r) == nil {
				out <- r
			}
		}
	}()
	return out
}
