-- A GitHub App installation can be connected to several organizations. Whether a person may
-- connect one is decided by GitHub, which says which installations they can access, so there is
-- no first owner to protect. Each organization still uses only the installations it connected.
create table "shuttle_github_installation_org" (
  "installation_id" integer not null,
  "org_id" text not null,
  "created_at" integer not null,
  primary key ("installation_id", "org_id")
);

insert into "shuttle_github_installation_org" ("installation_id", "org_id", "created_at")
select "installation_id", "org_id", "created_at" from "shuttle_github_installation";

drop table "shuttle_github_installation";

create index "shuttle_github_installation_org_org_idx" on "shuttle_github_installation_org" ("org_id");
