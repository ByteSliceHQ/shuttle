-- The machines people run a local sandbox on. A runner signs in with a token of its own, made
-- for one machine of one person in one organization, so a machine can be removed without
-- signing the person out anywhere else. Only the token's hash is kept.
create table "shuttle_runner_device" (
  "org_id" text not null,
  "user_id" text not null,
  "device_id" text not null,
  "name" text not null,
  "platform" text not null,
  "token_hash" text not null unique,
  "created_at" integer not null,
  primary key ("org_id", "user_id", "device_id")
);
