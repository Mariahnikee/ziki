-- Agent mode (#agent-mode): auto takes offers on its own, ask checks with its owner first.

-- CreateEnum
CREATE TYPE "AgentMode" AS ENUM ('auto', 'ask');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "mode" "AgentMode" NOT NULL DEFAULT 'auto';
