-- Make the coding agent an explicit property of sessions and profiles.
-- Existing installations keep their current behavior through the Claude default.

ALTER TABLE active_containers ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE active_containers ADD COLUMN task_description TEXT;
ALTER TABLE profiles ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'claude';

-- OpenAI Codex API traffic uses the same placeholder-key injection path as
-- Anthropic. Seed the host so fresh installs work without manual allowlist edits.
INSERT OR IGNORE INTO network_rules (pattern, description) VALUES
  ('api.openai.com', 'OpenAI API'),
  ('chatgpt.com', 'Codex CLI authentication and updates');
