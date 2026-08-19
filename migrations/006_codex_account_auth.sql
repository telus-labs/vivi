-- ChatGPT account sessions may refresh through the OpenAI auth service.
INSERT OR IGNORE INTO network_rules (pattern, description) VALUES
  ('auth.openai.com', 'Codex ChatGPT authentication');
