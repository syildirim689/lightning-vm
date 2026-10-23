package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisStore shares state with the API through Redis. Keys:
//
//	console:session:<sha256(token)>  one-time session written by the API (GETDEL here, 60 s TTL)
//	console:active                   hash of live consoles, for the admin list
//	console:events                   stream the worker copies into audit_events
//	console:revoke                   pub/sub channel the API publishes revocations on
type redisStore struct{ rdb *redis.Client }

func (s *redisStore) Consume(ctx context.Context, key string) (*Session, error) {
	raw, err := s.rdb.GetDel(ctx, "console:session:"+key).Bytes()
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

func (s *redisStore) Active(ctx context.Context, sess *Session, started time.Time) error {
	v, _ := json.Marshal(map[string]any{"userId": sess.UserID, "vm": sess.VM, "vmName": sess.VMName, "connectionId": sess.ConnectionID, "startedAt": started.UTC()})
	return s.rdb.HSet(ctx, "console:active", sess.Key, v).Err()
}

func (s *redisStore) Inactive(ctx context.Context, sess *Session) error {
	return s.rdb.HDel(ctx, "console:active", sess.Key).Err()
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
