CREATE TABLE "identity_links" (
	"slack_user_id" text PRIMARY KEY NOT NULL,
	"keycloak_sub" text NOT NULL,
	"refresh_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
