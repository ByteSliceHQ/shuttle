-- The label in a preview hostname (`p3000-<key>.preview.example`) for each session. A preview is
-- loaded in an iframe on its own hostname, which carries no sign-in, so the key is what grants
-- access: it is random, and handed only to people who can open the session.
create table "shuttle_preview_key" (
  "key" text not null primary key,
  "run_id" text not null unique,
  "created_at" integer not null
);
