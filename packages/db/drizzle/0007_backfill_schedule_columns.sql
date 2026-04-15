ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "schedule_id" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "schedule_active" boolean DEFAULT true NOT NULL;
