CREATE TABLE "emails_sent" (
	"key" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails_sent" ADD CONSTRAINT "emails_sent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;