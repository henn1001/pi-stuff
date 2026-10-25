/** Durable workspace state, independent of conversation navigation and adapter lifetime.
 * Composite foreign keys prevent cross-workspace identity references.
 */
export const SCHEMA_VERSION = 8;
export const SCHEMA = `
CREATE TABLE workspace (
  workspace_id TEXT PRIMARY KEY CHECK(length(workspace_id) > 0), schema_version INTEGER NOT NULL CHECK(schema_version = 8)
) STRICT;
CREATE UNIQUE INDEX one_workspace ON workspace((1));
CREATE TABLE sessions (
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  session_id TEXT NOT NULL CHECK(length(session_id) > 0), role TEXT NOT NULL CHECK(role IN ('lead','member')),
  role_json TEXT NOT NULL CHECK(json_valid(role_json)), session_file TEXT,
  CHECK(json_extract(role_json,'$.kind') IS role),
  CHECK(json_extract(role_json,'$.sessionId') IS session_id),
  CHECK(json_extract(role_json,'$.workspaceId') IS workspace_id),
  PRIMARY KEY(workspace_id, session_id)
) STRICT;
CREATE TABLE lead_ownership (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(workspace_id), session_id TEXT NOT NULL,
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,session_id)
) STRICT;
CREATE TABLE retired_leads (
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, successor_session_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,session_id),
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,session_id),
  FOREIGN KEY(workspace_id,successor_session_id) REFERENCES sessions(workspace_id,session_id)
) STRICT;
CREATE TRIGGER session_identity BEFORE UPDATE OF workspace_id,session_id,role,role_json ON sessions BEGIN
  SELECT RAISE(ABORT,'The recorded request identity does not match this submission.');
END;
CREATE TABLE agent_tree (
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, root_lead_session_id TEXT NOT NULL,
  parent_session_id TEXT, definition_name TEXT, task_name TEXT,
  PRIMARY KEY(workspace_id,session_id),
  UNIQUE(workspace_id,parent_session_id,task_name),
  CHECK(session_id <> parent_session_id),
  CHECK((parent_session_id IS NULL) = (session_id = root_lead_session_id)),
  CHECK(task_name IS NULL OR (length(task_name) BETWEEN 1 AND 64
    AND substr(task_name,1,1) GLOB '[a-z]' AND task_name NOT GLOB '*[^a-z0-9_-]*')),
  CHECK(parent_session_id IS NOT NULL OR (task_name IS NULL AND definition_name IS NULL)),
  CHECK(task_name IS NULL OR NOT (length(task_name)=36 AND substr(task_name,9,1)='-'
    AND substr(task_name,14,1)='-' AND substr(task_name,19,1)='-' AND substr(task_name,24,1)='-'
    AND length(replace(task_name,'-',''))=32 AND replace(task_name,'-','') NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY(workspace_id,session_id) REFERENCES sessions(workspace_id,session_id),
  FOREIGN KEY(workspace_id,root_lead_session_id) REFERENCES sessions(workspace_id,session_id),
  FOREIGN KEY(workspace_id,parent_session_id) REFERENCES agent_tree(workspace_id,session_id)
) STRICT;
CREATE TRIGGER tree_identity BEFORE INSERT ON agent_tree BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sessions WHERE workspace_id=NEW.workspace_id
      AND session_id=NEW.root_lead_session_id AND role='lead'
      AND session_id=(SELECT session_id FROM lead_ownership WHERE workspace_id=NEW.workspace_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM sessions WHERE workspace_id=NEW.workspace_id AND session_id=NEW.session_id
      AND role=CASE WHEN NEW.parent_session_id IS NULL THEN 'lead' ELSE 'member' END
  ) OR (NEW.parent_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_tree p WHERE p.workspace_id=NEW.workspace_id
      AND p.session_id=NEW.parent_session_id AND p.root_lead_session_id=NEW.root_lead_session_id
  )) OR (NEW.task_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_names n JOIN operations o USING(workspace_id,request_id)
    WHERE n.workspace_id=NEW.workspace_id AND n.parent_session_id=NEW.parent_session_id
      AND n.task_name=NEW.task_name AND n.child_session_id IS NULL
      AND o.definition_name=NEW.definition_name AND o.state IN ('in_progress','uncertain')
  )) THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER tree_immutable BEFORE UPDATE ON agent_tree BEGIN
  SELECT RAISE(ABORT,'The recorded request identity does not match this submission.');
END;
CREATE TRIGGER tree_retained BEFORE DELETE ON agent_tree BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TABLE instances (
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, instance_id TEXT NOT NULL CHECK(length(instance_id) > 0),
  pid INTEGER NOT NULL CHECK(pid>0), process_start TEXT NOT NULL CHECK(length(process_start)>0),
  host_id TEXT NOT NULL CHECK(length(host_id)>0), boot_id TEXT NOT NULL CHECK(length(boot_id)>0), pane_id TEXT,
  auto_exit INTEGER NOT NULL DEFAULT 0 CHECK(auto_exit IN (0,1)),
  takeover INTEGER NOT NULL DEFAULT 0 CHECK(takeover IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('running','released','exited')),
  PRIMARY KEY(workspace_id, session_id, instance_id),
  FOREIGN KEY(workspace_id, session_id) REFERENCES sessions(workspace_id, session_id)
) STRICT;
CREATE UNIQUE INDEX running_instance ON instances(workspace_id,session_id) WHERE status = 'running';
CREATE TABLE relationships (
  workspace_id TEXT NOT NULL, owner_session_id TEXT NOT NULL, child_session_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL, handshake_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('proposed','accepted','confirmed','ready','orphaned')),
  origin TEXT NOT NULL CHECK(origin IN ('spawned','joined')),
  PRIMARY KEY(workspace_id, owner_session_id, child_session_id),
  UNIQUE(workspace_id, owner_session_id, handshake_id),
  CHECK(parent_session_id <> child_session_id),
  CHECK(owner_session_id IN (parent_session_id,child_session_id)),
  FOREIGN KEY(workspace_id,owner_session_id) REFERENCES sessions(workspace_id,session_id)
) STRICT;
CREATE TABLE assignments (
  workspace_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, child_session_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL CHECK(length(assignment_id) > 0), instance_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','outstanding','settled','failed-start')),
  prompt TEXT NOT NULL,
  PRIMARY KEY(workspace_id,parent_session_id,assignment_id),
  UNIQUE(workspace_id,parent_session_id,child_session_id,assignment_id,instance_id),
  FOREIGN KEY(workspace_id,parent_session_id) REFERENCES sessions(workspace_id,session_id),
  FOREIGN KEY(workspace_id,child_session_id,instance_id) REFERENCES instances(workspace_id,session_id,instance_id)
) STRICT;
CREATE TRIGGER assignment_parent BEFORE INSERT ON assignments BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agent_tree WHERE workspace_id=NEW.workspace_id AND session_id=NEW.child_session_id
      AND parent_session_id=NEW.parent_session_id
  ) THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER assignment_identity BEFORE UPDATE ON assignments BEGIN
  SELECT CASE WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.parent_session_id<>NEW.parent_session_id
    OR OLD.child_session_id<>NEW.child_session_id OR OLD.assignment_id<>NEW.assignment_id
    OR OLD.instance_id<>NEW.instance_id OR NOT (OLD.state=NEW.state
      OR (OLD.state='prepared' AND NEW.state IN ('outstanding','failed-start'))
      OR (OLD.state='outstanding' AND NEW.state='settled'))
    THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER assignment_retained BEFORE DELETE ON assignments BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE UNIQUE INDEX one_outstanding ON assignments(workspace_id,parent_session_id,child_session_id)
  WHERE state IN ('prepared','outstanding');
CREATE TABLE buffered_inputs (
  workspace_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, child_session_id TEXT NOT NULL,
  input_id TEXT NOT NULL, previous_instance_id TEXT NOT NULL, prompt TEXT NOT NULL CHECK(length(trim(prompt)) > 0),
  state TEXT NOT NULL CHECK(state IN ('buffered','launching','released')),
  PRIMARY KEY(workspace_id,parent_session_id,child_session_id),
  UNIQUE(workspace_id,parent_session_id,input_id),
  FOREIGN KEY(workspace_id,parent_session_id) REFERENCES sessions(workspace_id,session_id),
  FOREIGN KEY(workspace_id,child_session_id,previous_instance_id) REFERENCES instances(workspace_id,session_id,instance_id)
) STRICT;
CREATE TABLE outbox (
  workspace_id TEXT NOT NULL, child_session_id TEXT NOT NULL, report_id TEXT NOT NULL CHECK(length(report_id) > 0),
  parent_session_id TEXT NOT NULL, assignment_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(length(trim(payload)) > 0),
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
  PRIMARY KEY(workspace_id,child_session_id,report_id),
  UNIQUE(workspace_id,child_session_id,report_id,parent_session_id,assignment_id,instance_id),
  FOREIGN KEY(workspace_id,parent_session_id,child_session_id,assignment_id,instance_id)
    REFERENCES assignments(workspace_id,parent_session_id,child_session_id,assignment_id,instance_id)
) STRICT;
CREATE TABLE receipts (
  workspace_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, report_id TEXT NOT NULL CHECK(length(report_id) > 0),
  child_session_id TEXT NOT NULL, assignment_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  payload TEXT NOT NULL, acknowledgment TEXT NOT NULL, late INTEGER NOT NULL CHECK(late IN (0,1)),
  PRIMARY KEY(workspace_id,parent_session_id,report_id),
  FOREIGN KEY(workspace_id,child_session_id,report_id,parent_session_id,assignment_id,instance_id)
    REFERENCES outbox(workspace_id,child_session_id,report_id,parent_session_id,assignment_id,instance_id)
) STRICT;
CREATE TABLE settlements (
  workspace_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('report','incomplete')), report_id TEXT, payload TEXT NOT NULL,
  PRIMARY KEY(workspace_id,parent_session_id,assignment_id),
  CHECK((kind = 'report') = (report_id IS NOT NULL)),
  FOREIGN KEY(workspace_id,parent_session_id,assignment_id) REFERENCES assignments(workspace_id,parent_session_id,assignment_id),
  FOREIGN KEY(workspace_id,parent_session_id,report_id) REFERENCES receipts(workspace_id,parent_session_id,report_id)
) STRICT;
CREATE TABLE pending_outcomes (
  workspace_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, outcome_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL, report_id TEXT, payload TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','delivered','processed')),
  processing_turn_id TEXT,
  PRIMARY KEY(workspace_id,parent_session_id,outcome_id),
  FOREIGN KEY(workspace_id,parent_session_id,assignment_id) REFERENCES settlements(workspace_id,parent_session_id,assignment_id),
  FOREIGN KEY(workspace_id,parent_session_id,report_id) REFERENCES receipts(workspace_id,parent_session_id,report_id)
) STRICT;
CREATE UNIQUE INDEX one_report_delivery ON pending_outcomes(workspace_id,parent_session_id,report_id) WHERE report_id IS NOT NULL;
CREATE UNIQUE INDEX one_exit_delivery ON pending_outcomes(workspace_id,parent_session_id,assignment_id) WHERE report_id IS NULL;
CREATE TABLE operations (
  submission_order INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL, request_id TEXT NOT NULL CHECK(length(request_id)>0),
  caller_session_id TEXT NOT NULL, recipient_session_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('spawn','message','report','automatic_report','unexpected_exit','close')),
  payload TEXT NOT NULL, definition_name TEXT, task_name TEXT, assignment_id TEXT, launch_directory TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','in_progress','succeeded','failed','uncertain')),
  error_code TEXT, error_message TEXT, resolved_agent_id TEXT,
  UNIQUE(workspace_id,request_id),
  CHECK((error_code IS NULL) = (error_message IS NULL)),
  CHECK((state IN ('failed','uncertain')) = (error_code IS NOT NULL)),
  CHECK((kind='spawn') = (definition_name IS NOT NULL)),
  CHECK((kind='spawn') = (launch_directory IS NOT NULL)),
  CHECK(kind<>'spawn' OR length(trim(payload))=0 OR task_name IS NOT NULL),
  CHECK(kind='spawn' OR recipient_session_id IS NOT NULL),
  CHECK(kind NOT IN ('report','automatic_report','unexpected_exit') OR assignment_id IS NOT NULL),
  CHECK(kind='spawn' OR length(trim(payload))>0 OR kind='close'),
  CHECK(task_name IS NULL OR (kind='spawn' AND length(task_name) BETWEEN 1 AND 64
    AND substr(task_name,1,1) GLOB '[a-z]' AND task_name NOT GLOB '*[^a-z0-9_-]*')),
  CHECK(task_name IS NULL OR NOT (length(task_name)=36 AND substr(task_name,9,1)='-'
    AND substr(task_name,14,1)='-' AND substr(task_name,19,1)='-' AND substr(task_name,24,1)='-'
    AND length(replace(task_name,'-',''))=32 AND replace(task_name,'-','') NOT GLOB '*[^0-9a-f]*')),
  FOREIGN KEY(workspace_id,caller_session_id) REFERENCES sessions(workspace_id,session_id),
  FOREIGN KEY(workspace_id,recipient_session_id) REFERENCES sessions(workspace_id,session_id)
) STRICT;
CREATE TRIGGER operation_identity BEFORE UPDATE ON operations BEGIN
  SELECT CASE WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.request_id<>NEW.request_id
    OR OLD.submission_order<>NEW.submission_order OR OLD.caller_session_id<>NEW.caller_session_id
    OR OLD.kind<>NEW.kind OR OLD.payload<>NEW.payload OR OLD.definition_name IS NOT NEW.definition_name
    OR OLD.task_name IS NOT NEW.task_name OR OLD.assignment_id IS NOT NEW.assignment_id
    OR OLD.launch_directory IS NOT NEW.launch_directory
    OR (OLD.resolved_agent_id IS NOT NULL AND OLD.resolved_agent_id IS NOT NEW.resolved_agent_id)
    OR OLD.recipient_session_id IS NOT NEW.recipient_session_id
    OR NOT ((OLD.state='pending' AND NEW.state IN ('in_progress','failed'))
      OR (OLD.state='in_progress' AND NEW.state IN ('succeeded','failed','uncertain'))
      OR (OLD.state='uncertain' AND NEW.state IN ('succeeded','failed')))
    THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER operation_retained BEFORE DELETE ON operations BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TABLE task_names (
  workspace_id TEXT NOT NULL, parent_session_id TEXT NOT NULL, task_name TEXT NOT NULL,
  request_id TEXT NOT NULL, child_session_id TEXT,
  PRIMARY KEY(workspace_id,parent_session_id,task_name),
  UNIQUE(workspace_id,request_id),
  FOREIGN KEY(workspace_id,parent_session_id) REFERENCES agent_tree(workspace_id,session_id),
  FOREIGN KEY(workspace_id,request_id) REFERENCES operations(workspace_id,request_id),
  FOREIGN KEY(workspace_id,child_session_id) REFERENCES agent_tree(workspace_id,session_id)
) STRICT;
CREATE TRIGGER reserve_task_name BEFORE INSERT ON task_names BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operations WHERE workspace_id=NEW.workspace_id AND request_id=NEW.request_id
      AND kind='spawn' AND caller_session_id=NEW.parent_session_id AND task_name=NEW.task_name
      AND state IN ('pending','in_progress','uncertain')
  ) OR EXISTS (
    SELECT 1 FROM agent_tree WHERE workspace_id=NEW.workspace_id
      AND parent_session_id=NEW.parent_session_id AND task_name=NEW.task_name
  ) THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER retain_task_name BEFORE DELETE ON task_names BEGIN
  SELECT CASE WHEN OLD.child_session_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM agent_tree WHERE workspace_id=OLD.workspace_id
      AND parent_session_id=OLD.parent_session_id AND task_name=OLD.task_name
  ) OR NOT EXISTS (
    SELECT 1 FROM operations WHERE workspace_id=OLD.workspace_id AND request_id=OLD.request_id AND state='failed'
  ) THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER bind_task_name BEFORE UPDATE ON task_names BEGIN
  SELECT CASE WHEN OLD.child_session_id IS NOT NULL OR NEW.child_session_id IS NULL
    OR OLD.workspace_id<>NEW.workspace_id OR OLD.parent_session_id<>NEW.parent_session_id
    OR OLD.task_name<>NEW.task_name OR OLD.request_id<>NEW.request_id OR NOT EXISTS (
      SELECT 1 FROM agent_tree WHERE workspace_id=NEW.workspace_id AND session_id=NEW.child_session_id
        AND parent_session_id=NEW.parent_session_id AND task_name=NEW.task_name
    ) THEN RAISE(ABORT,'The recorded request identity does not match this submission.') END;
END;
CREATE TRIGGER reserve_spawn_name AFTER INSERT ON operations WHEN NEW.kind='spawn' AND NEW.task_name IS NOT NULL BEGIN
  INSERT INTO task_names VALUES(NEW.workspace_id,NEW.caller_session_id,NEW.task_name,NEW.request_id,NULL);
END;
CREATE INDEX pending_recipient_input ON operations(workspace_id,recipient_session_id,state,kind);
CREATE INDEX caller_launches ON operations(workspace_id,caller_session_id,kind,submission_order);
CREATE TABLE execution_attempts (
  workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt_id TEXT NOT NULL CHECK(length(attempt_id)>0),
  coordinator_session_id TEXT NOT NULL, coordinator_instance_id TEXT NOT NULL,
  recipient_instance_id TEXT, command TEXT NOT NULL CHECK(command IN ('launch','resume','prompt','close')),
  state TEXT NOT NULL CHECK(state IN ('in_progress','succeeded','failed','uncertain')),
  PRIMARY KEY(workspace_id,request_id), UNIQUE(workspace_id,attempt_id),
  FOREIGN KEY(workspace_id,request_id) REFERENCES operations(workspace_id,request_id),
  FOREIGN KEY(workspace_id,coordinator_session_id,coordinator_instance_id)
    REFERENCES instances(workspace_id,session_id,instance_id)
) STRICT;
CREATE TRIGGER attempt_authority BEFORE INSERT ON execution_attempts BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sessions s JOIN instances i USING(workspace_id,session_id)
    WHERE s.workspace_id=NEW.workspace_id AND s.session_id=NEW.coordinator_session_id AND s.role='lead'
      AND i.instance_id=NEW.coordinator_instance_id AND i.status='running'
      AND s.session_id=(SELECT session_id FROM lead_ownership WHERE workspace_id=NEW.workspace_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM operations WHERE workspace_id=NEW.workspace_id AND request_id=NEW.request_id AND state='in_progress'
      AND ((kind='spawn' AND NEW.command='launch') OR (kind='close' AND NEW.command='close')
        OR (kind='message' AND NEW.command IN ('resume','prompt'))
        OR (kind IN ('report','automatic_report','unexpected_exit') AND NEW.command='prompt'))
  ) OR (NEW.recipient_instance_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM instances i JOIN operations o ON i.workspace_id=o.workspace_id AND i.session_id=o.recipient_session_id
    WHERE o.workspace_id=NEW.workspace_id AND o.request_id=NEW.request_id AND i.instance_id=NEW.recipient_instance_id
  )) THEN RAISE(ABORT,'Only the recorded lead coordinator may change this operation''s state.') END;
END;
CREATE TRIGGER attempt_identity BEFORE UPDATE ON execution_attempts BEGIN
  SELECT CASE WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.request_id<>NEW.request_id
    OR OLD.attempt_id<>NEW.attempt_id OR OLD.coordinator_session_id<>NEW.coordinator_session_id
    OR OLD.coordinator_instance_id<>NEW.coordinator_instance_id
    OR OLD.recipient_instance_id IS NOT NEW.recipient_instance_id OR OLD.command<>NEW.command
    OR NOT ((OLD.state='in_progress' AND NEW.state IN ('succeeded','failed','uncertain'))
      OR (OLD.state='uncertain' AND NEW.state IN ('succeeded','failed')))
    THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TABLE launch_results (
  workspace_id TEXT NOT NULL, request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('succeeded','failed','uncertain')),
  child_session_id TEXT, assignment_id TEXT, error_code TEXT, error_message TEXT,
  PRIMARY KEY(workspace_id,request_id),
  CHECK((state='succeeded') = (child_session_id IS NOT NULL)),
  CHECK((state='succeeded') = (error_code IS NULL)),
  CHECK((error_code IS NULL) = (error_message IS NULL)),
  CHECK(child_session_id IS NOT NULL OR assignment_id IS NULL),
  FOREIGN KEY(workspace_id,request_id) REFERENCES operations(workspace_id,request_id),
  FOREIGN KEY(workspace_id,child_session_id) REFERENCES agent_tree(workspace_id,session_id)
) STRICT;
CREATE TRIGGER launch_result_identity BEFORE INSERT ON launch_results BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operations o WHERE o.workspace_id=NEW.workspace_id AND o.request_id=NEW.request_id
      AND o.kind='spawn' AND o.state=NEW.state
      AND o.error_code IS NEW.error_code AND o.error_message IS NEW.error_message
      AND (NEW.state<>'succeeded' OR EXISTS (
        SELECT 1 FROM agent_tree t WHERE t.workspace_id=o.workspace_id AND t.session_id=NEW.child_session_id
          AND t.parent_session_id=o.caller_session_id AND t.definition_name=o.definition_name
          AND t.task_name IS o.task_name AND o.resolved_agent_id=t.session_id
          AND (length(trim(o.payload))>0)=(NEW.assignment_id IS NOT NULL)
          AND (NEW.assignment_id IS NULL OR EXISTS (
            SELECT 1 FROM assignments a WHERE a.workspace_id=o.workspace_id AND a.parent_session_id=o.caller_session_id
              AND a.child_session_id=t.session_id AND a.assignment_id=NEW.assignment_id AND a.state='outstanding'
          ))
      ))
  ) THEN RAISE(ABORT,'The recorded request identity does not match this submission.') END;
END;
CREATE TRIGGER launch_result_retained BEFORE DELETE ON launch_results BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TRIGGER launch_result_transition BEFORE UPDATE ON launch_results BEGIN
  SELECT CASE WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.request_id<>NEW.request_id
    OR OLD.state<>'uncertain' OR NEW.state NOT IN ('succeeded','failed')
    THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TABLE execution_events (
  event_order INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK(length(event_id)>0), session_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('human_input','turn_started','turn_settled','disrupted','process_exit')),
  turn_id TEXT, outcome TEXT CHECK(outcome IN ('success','failure','abort')), result_text TEXT,
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
  UNIQUE(workspace_id,event_id),
  CHECK(event_id<>'' AND (turn_id IS NULL OR length(turn_id)>0)),
  CHECK((kind='turn_settled') = (outcome IS NOT NULL)),
  CHECK(kind NOT IN ('turn_started','turn_settled') OR turn_id IS NOT NULL),
  CHECK(kind='turn_settled' OR result_text IS NULL),
  FOREIGN KEY(workspace_id,session_id,instance_id) REFERENCES instances(workspace_id,session_id,instance_id)
) STRICT;
CREATE UNIQUE INDEX one_terminal_turn ON execution_events(workspace_id,session_id,turn_id) WHERE kind='turn_settled';
CREATE TRIGGER event_identity BEFORE UPDATE ON execution_events BEGIN
  SELECT CASE WHEN OLD.event_order<>NEW.event_order OR OLD.workspace_id<>NEW.workspace_id
    OR OLD.event_id<>NEW.event_id OR OLD.session_id<>NEW.session_id OR OLD.instance_id<>NEW.instance_id
    OR OLD.kind<>NEW.kind OR OLD.turn_id IS NOT NEW.turn_id OR OLD.outcome IS NOT NEW.outcome
    OR OLD.result_text IS NOT NEW.result_text OR OLD.processed>NEW.processed
    THEN RAISE(ABORT,'The recorded request identity does not match this submission.') END;
END;
CREATE TRIGGER event_retained BEFORE DELETE ON execution_events BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TABLE input_processing (
  workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL, turn_id TEXT NOT NULL CHECK(length(turn_id)>0),
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
  PRIMARY KEY(workspace_id,request_id),
  FOREIGN KEY(workspace_id,request_id) REFERENCES operations(workspace_id,request_id),
  FOREIGN KEY(workspace_id,session_id,instance_id) REFERENCES instances(workspace_id,session_id,instance_id)
) STRICT;
CREATE TRIGGER input_recipient BEFORE INSERT ON input_processing BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operations WHERE workspace_id=NEW.workspace_id AND request_id=NEW.request_id
      AND kind IN ('message','report','automatic_report','unexpected_exit') AND recipient_session_id=NEW.session_id AND state IN ('in_progress','succeeded','uncertain')
  ) THEN RAISE(ABORT,'The recorded request identity does not match this submission.') END;
END;
CREATE TRIGGER input_processing_retained BEFORE DELETE ON input_processing BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TRIGGER input_processing_identity BEFORE UPDATE ON input_processing BEGIN
  SELECT CASE WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.request_id<>NEW.request_id
    OR OLD.session_id<>NEW.session_id OR OLD.processed=1 OR (NEW.processed=1 AND (
      OLD.instance_id<>NEW.instance_id OR OLD.turn_id<>NEW.turn_id OR NOT EXISTS (
        SELECT 1 FROM execution_events WHERE workspace_id=NEW.workspace_id AND session_id=NEW.session_id
          AND instance_id=NEW.instance_id AND turn_id=NEW.turn_id AND kind='turn_settled' AND outcome='success'
      ))) THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TABLE delivery_evidence (
  workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, recipient_session_id TEXT NOT NULL,
  instance_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('enqueued','received')),
  PRIMARY KEY(workspace_id,request_id),
  FOREIGN KEY(workspace_id,request_id) REFERENCES operations(workspace_id,request_id),
  FOREIGN KEY(workspace_id,recipient_session_id,instance_id) REFERENCES instances(workspace_id,session_id,instance_id)
) STRICT;
CREATE TRIGGER delivery_identity BEFORE UPDATE ON delivery_evidence BEGIN
  SELECT CASE WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.request_id<>NEW.request_id
    OR OLD.recipient_session_id<>NEW.recipient_session_id OR OLD.instance_id<>NEW.instance_id
    OR OLD.state<>'enqueued' OR NEW.state<>'received'
    THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER delivery_recipient BEFORE INSERT ON delivery_evidence BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operations o JOIN execution_attempts a USING(workspace_id,request_id)
    WHERE o.workspace_id=NEW.workspace_id AND o.request_id=NEW.request_id
      AND o.recipient_session_id=NEW.recipient_session_id
      AND ((a.recipient_instance_id=NEW.instance_id AND a.command='prompt') OR
        (a.command='resume' AND EXISTS (SELECT 1 FROM message_assignments m WHERE m.workspace_id=o.workspace_id AND m.request_id=o.request_id AND m.instance_id=NEW.instance_id)))
      AND o.state IN ('in_progress','uncertain','succeeded')
  ) THEN RAISE(ABORT,'The recorded request identity does not match this submission.') END;
END;
CREATE TRIGGER delivery_retained BEFORE DELETE ON delivery_evidence BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TABLE message_assignments (
  workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL, assignment_id TEXT NOT NULL, instance_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,request_id),
  FOREIGN KEY(workspace_id,request_id) REFERENCES operations(workspace_id,request_id),
  FOREIGN KEY(workspace_id,parent_session_id,child_session_id,assignment_id,instance_id)
    REFERENCES assignments(workspace_id,parent_session_id,child_session_id,assignment_id,instance_id)
) STRICT;
CREATE TRIGGER message_assignment_identity BEFORE INSERT ON message_assignments BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operations o JOIN execution_attempts a USING(workspace_id,request_id)
    WHERE o.workspace_id=NEW.workspace_id AND o.request_id=NEW.request_id AND o.kind='message'
      AND o.caller_session_id=NEW.parent_session_id AND o.recipient_session_id=NEW.child_session_id
      AND o.state='in_progress' AND (a.command='resume' OR (a.command='prompt' AND a.recipient_instance_id=NEW.instance_id))
  ) THEN RAISE(ABORT,'The recorded request identity does not match this submission.') END;
END;
CREATE TRIGGER message_assignment_immutable BEFORE UPDATE ON message_assignments BEGIN
  SELECT RAISE(ABORT,'The recorded request identity does not match this submission.');
END;
CREATE TRIGGER message_assignment_retained BEFORE DELETE ON message_assignments BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TABLE completion_authorizations (
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL, instance_id TEXT NOT NULL, event_id TEXT NOT NULL,
  request_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('authorized','settled','closed','cancelled')),
  PRIMARY KEY(workspace_id,request_id), UNIQUE(workspace_id,event_id),
  FOREIGN KEY(workspace_id,event_id) REFERENCES execution_events(workspace_id,event_id),
  FOREIGN KEY(workspace_id,request_id) REFERENCES operations(workspace_id,request_id),
  FOREIGN KEY(workspace_id,parent_session_id,session_id,assignment_id,instance_id)
    REFERENCES assignments(workspace_id,parent_session_id,child_session_id,assignment_id,instance_id)
) STRICT;
CREATE UNIQUE INDEX one_live_completion ON completion_authorizations(workspace_id,session_id,assignment_id)
  WHERE state<>'cancelled';
CREATE TRIGGER completion_retained BEFORE DELETE ON completion_authorizations BEGIN
  SELECT RAISE(ABORT,'The recorded operation state does not permit this transition.');
END;
CREATE TRIGGER completion_transition BEFORE UPDATE ON completion_authorizations BEGIN
  SELECT CASE WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.session_id<>NEW.session_id
    OR OLD.assignment_id<>NEW.assignment_id OR OLD.parent_session_id<>NEW.parent_session_id
    OR OLD.instance_id<>NEW.instance_id OR OLD.event_id<>NEW.event_id OR OLD.request_id<>NEW.request_id
    OR NOT ((OLD.state='authorized' AND NEW.state IN ('settled','cancelled')) OR (OLD.state='settled' AND NEW.state='closed'))
    THEN RAISE(ABORT,'The recorded operation state does not permit this transition.') END;
END;
CREATE TRIGGER completion_identity BEFORE INSERT ON completion_authorizations BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM execution_events e JOIN operations o ON o.workspace_id=e.workspace_id AND o.request_id=NEW.request_id
    JOIN instances i ON i.workspace_id=e.workspace_id AND i.session_id=e.session_id AND i.instance_id=e.instance_id
    WHERE e.workspace_id=NEW.workspace_id AND e.event_id=NEW.event_id AND e.session_id=NEW.session_id
      AND e.instance_id=NEW.instance_id AND e.kind='turn_settled' AND e.outcome='success'
      AND length(trim(e.result_text))>0 AND i.auto_exit=1 AND i.takeover=0 AND i.status='running'
      AND o.kind='automatic_report' AND o.caller_session_id=e.session_id AND o.recipient_session_id=NEW.parent_session_id
      AND o.assignment_id=NEW.assignment_id AND o.payload=e.result_text AND o.state='pending'
  ) THEN RAISE(ABORT,'Completion requires a successful settled turn with no pending input, outstanding child assignments, unprocessed child outcomes, or disruption.') END;
END;
`;