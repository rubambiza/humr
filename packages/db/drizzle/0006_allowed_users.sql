CREATE TABLE "allowed_users" (
	"instance_id" text NOT NULL,
	"owner" text NOT NULL,
	"keycloak_sub" text NOT NULL,
	CONSTRAINT "allowed_users_instance_id_keycloak_sub_pk" PRIMARY KEY("instance_id","keycloak_sub")
);
