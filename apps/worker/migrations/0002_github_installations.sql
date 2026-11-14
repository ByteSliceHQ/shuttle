-- Which organization a GitHub App installation is connected to. An installation belongs to one
-- organization, so its repositories and webhooks can never reach another.
create table "shuttle_github_installation" (
  "installation_id" integer not null primary key,
  "org_id" text not null,
  "created_at" integer not null
);

create index "shuttle_github_installation_org_idx" on "shuttle_github_installation" ("org_id");
