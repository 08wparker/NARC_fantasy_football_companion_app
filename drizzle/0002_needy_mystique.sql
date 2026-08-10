DROP INDEX "users_email_uq";--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");