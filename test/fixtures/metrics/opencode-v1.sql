-- OpenCode legacy storage (1.x): session + message with the role inside data.
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
INSERT INTO session VALUES ('ses_old','prj',NULL,'old','/work','Old','1.14.0',1795172400000,1795172410000);
INSERT INTO message VALUES ('o1','ses_old',1795172400000,1795172400000,'{"role": "user", "time": {"created": 1795172400000}}');
INSERT INTO message VALUES ('o2','ses_old',1795172405000,1795172409000,'{"role": "assistant", "agent": "build", "modelID": "qwen3.6-plus", "providerID": "opencode-go", "cost": 0.007, "time": {"created": 1795172405000, "completed": 1795172409000}, "tokens": {"total": 1311, "input": 30, "output": 250, "reasoning": 0, "cache": {"read": 1000, "write": 31}}}');
