DROP TABLE IF EXISTS "user",
"issue",
"comment",
"label",
"issueLabel",
"emoji",
"userPref",
"zero.schemaVersions" CASCADE;

CREATE TABLE "user" (
    "id" VARCHAR PRIMARY KEY,
    "login" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "avatar" VARCHAR,
    "role" VARCHAR DEFAULT 'user' NOT NULL,
    "githubID" INTEGER NOT NULL
);

CREATE UNIQUE INDEX user_login_idx ON "user" (login);
CREATE UNIQUE INDEX user_githubid_idx ON "user" ("githubID");

CREATE TABLE issue (
    "id" VARCHAR PRIMARY KEY,
    "shortID" INTEGER GENERATED BY DEFAULT AS IDENTITY (START WITH 3000),
    "title" VARCHAR NOT NULL,
    "open" BOOLEAN NOT NULL,
    "modified" double precision DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000),
    "created" double precision DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000),
    "creatorID" VARCHAR REFERENCES "user"(id) NOT NULL,
    "assigneeID" VARCHAR REFERENCES "user"(id),
    "description" TEXT DEFAULT '',
    -- This is a denormalized column that contains a comma-separated list of
    -- label IDs. This is temporary until Zero imlements support for filter-by-
    -- subquery. It does demonstrate the utility of connecting to existing
    -- mature databases though: we can use all the neat features of Postgres and
    -- Zero faithfully replicates whatever they do.
    --
    -- NULL here represents no labels. Empty string represents a single label
    -- with value "".
    "labelIDs" TEXT
);

CREATE TABLE "viewState" (
    "userID" VARCHAR REFERENCES "user"(id) ON DELETE CASCADE,
    "issueID" VARCHAR REFERENCES issue(id) ON DELETE CASCADE,
    "viewed" double precision,
    PRIMARY KEY ("userID", "issueID")
);

CREATE TABLE comment (
    id VARCHAR PRIMARY KEY,
    "issueID" VARCHAR REFERENCES issue(id) ON DELETE CASCADE,
    "created" double precision,
    "body" TEXT NOT NULL,
    "creatorID" VARCHAR REFERENCES "user"(id)
);

CREATE OR REPLACE FUNCTION update_issue_modified_time()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE issue
    SET modified = EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000
    WHERE id = NEW."issueID";
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_issue_modified_time_on_comment
AFTER INSERT ON comment
FOR EACH ROW
EXECUTE FUNCTION update_issue_modified_time();

CREATE OR REPLACE FUNCTION comment_set_created_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    NEW.created = (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comment_set_created_on_insert_trigger
BEFORE INSERT ON comment
FOR EACH ROW
EXECUTE FUNCTION comment_set_created_on_insert();

CREATE TABLE label (
    "id" VARCHAR PRIMARY KEY,
    "name" VARCHAR NOT NULL
);

CREATE TABLE "issueLabel" (
    "labelID" VARCHAR REFERENCES label(id),
    "issueID" VARCHAR REFERENCES issue(id) ON DELETE CASCADE,
    PRIMARY KEY ("labelID", "issueID")
);

CREATE TABLE emoji (
    "id" VARCHAR PRIMARY KEY,
    "value" VARCHAR NOT NULL,
    "annotation" VARCHAR,
    -- The PK of the "subject" (either issue or comment) that the emoji is attached to
    -- We cannot use a FK to enforce referential integrity. Instead we use a trigger to enforce this.
    -- We wil also need a custom secondary index on this since the FK won't give it to us.
    "subjectID" VARCHAR NOT NULL,
    "creatorID" VARCHAR REFERENCES "user"(id) ON DELETE CASCADE,
    "created" double precision DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000),

    UNIQUE ("subjectID", "creatorID", "value")
);
CREATE INDEX emoji_created_idx ON emoji (created);
CREATE INDEX emoji_subject_id_idx ON emoji ("subjectID");

CREATE OR REPLACE FUNCTION emoji_check_subject_id()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if subjectID exists in the issue table
    IF EXISTS (SELECT 1 FROM issue WHERE id = NEW."subjectID") THEN
        NULL; -- Do nothing
    ELSIF EXISTS (SELECT 1 FROM comment WHERE id = NEW."subjectID") THEN
        NULL; -- Do nothing
    ELSE
        RAISE EXCEPTION 'id ''%'' does not exist in issue or comment', NEW."subjectID";
    END IF;
    
    PERFORM update_issue_modified_on_emoji_change(NEW."subjectID");

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER emoji_check_subject_id_update_trigger
BEFORE INSERT OR UPDATE ON emoji
FOR EACH ROW
EXECUTE FUNCTION emoji_check_subject_id();

CREATE OR REPLACE FUNCTION emoji_set_created_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    NEW.created = EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER emoji_set_created_on_insert_trigger
BEFORE INSERT ON emoji
FOR EACH ROW
EXECUTE FUNCTION emoji_set_created_on_insert();

-- Delete emoji when issue is deleted
CREATE OR REPLACE FUNCTION delete_emoji_on_issue_delete()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM emoji WHERE "subjectID" = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER delete_emoji_on_issue_delete_trigger
AFTER DELETE ON issue
FOR EACH ROW
EXECUTE FUNCTION delete_emoji_on_issue_delete();

-- Delete emoji when comment is deleted
CREATE OR REPLACE FUNCTION delete_emoji_on_comment_delete()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM emoji WHERE "subjectID" = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER delete_emoji_on_comment_delete_trigger
AFTER DELETE ON comment
FOR EACH ROW
EXECUTE FUNCTION delete_emoji_on_comment_delete();

-- When an emoji is added or deleted we find the issue and update the modified time
CREATE OR REPLACE FUNCTION update_issue_modified_on_emoji_change("subjectID" VARCHAR)
RETURNS VOID AS $$
BEGIN
    UPDATE issue
    SET modified = EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000
    FROM (
        SELECT issue.id AS id
        FROM issue JOIN comment ON issue.id=comment."issueID"
        WHERE comment.id = "subjectID" OR issue.id = "subjectID"
    ) AS subquery
    WHERE issue.id = subquery.id;
END;   
$$ LANGUAGE plpgsql;

CREATE TABLE "userPref" (
    "key" VARCHAR NOT NULL,
    "value" VARCHAR NOT NULL,
    "userID" VARCHAR REFERENCES "user"(id) ON DELETE CASCADE,

    PRIMARY KEY ("key", "userID")
);

CREATE SCHEMA IF NOT EXISTS zero;

CREATE TABLE IF NOT EXISTS zero."schemaVersions" (
    "minSupportedVersion" INT4,
    "maxSupportedVersion" INT4,

    -- Ensure that there is only a single row in the table.
    -- Application code can be agnostic to this column, and
    -- simply invoke UPDATE statements on the version columns.
    "lock" BOOL PRIMARY KEY DEFAULT true,
    CONSTRAINT zero_schema_versions_single_row_constraint CHECK (lock)
);

INSERT INTO zero."schemaVersions" ("lock", "minSupportedVersion", "maxSupportedVersion")
VALUES (true, 3, 4) ON CONFLICT DO NOTHING;


-- last modified function and trigger
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.modified = (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_set_last_modified
BEFORE INSERT OR UPDATE ON issue
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();

CREATE OR REPLACE FUNCTION issue_set_created_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    NEW.created = (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_set_created_on_insert_trigger
BEFORE INSERT ON issue
FOR EACH ROW
EXECUTE FUNCTION issue_set_created_on_insert();


-- We use a trigger to maintain the "labelIDs" column in the issue table.
-- Add a new column to store labelIDs
CREATE OR REPLACE FUNCTION update_issue_labelIDs()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        -- Use OLD when the operation is DELETE to access the old issueID
        UPDATE issue
        SET "labelIDs" = (
            SELECT STRING_AGG("labelID", ',')
            FROM "issueLabel"
            WHERE "issueID" = OLD."issueID"
        )
        WHERE id = OLD."issueID";
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- For INSERT or UPDATE, use NEW to access the current issueID
        UPDATE issue
        SET "labelIDs" = (
            SELECT STRING_AGG("labelID", ',')
            FROM "issueLabel"
            WHERE "issueID" = NEW."issueID"
        )
        WHERE id = NEW."issueID";
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for INSERT operation
CREATE TRIGGER update_labelIDs_on_insert
AFTER
INSERT
    ON "issueLabel" FOR EACH ROW EXECUTE FUNCTION update_issue_labelIDs();

-- Trigger for UPDATE operation
CREATE TRIGGER update_labelIDs_on_update
AFTER
UPDATE
    ON "issueLabel" FOR EACH ROW EXECUTE FUNCTION update_issue_labelIDs();

-- Trigger for DELETE operation
CREATE TRIGGER update_labelIDs_on_delete
AFTER
    DELETE ON "issueLabel" FOR EACH ROW EXECUTE FUNCTION update_issue_labelIDs();

COPY "user"
FROM
    '/docker-entrypoint-initdb.d/users.csv' WITH CSV HEADER;

COPY "label"
FROM
    '/docker-entrypoint-initdb.d/labels.csv' WITH CSV HEADER;

COPY "issue"
FROM
    '/docker-entrypoint-initdb.d/issues.csv' WITH CSV HEADER;

COPY "issueLabel"
FROM
    '/docker-entrypoint-initdb.d/issue_labels.csv' WITH CSV HEADER;

COPY "comment"
FROM
    '/docker-entrypoint-initdb.d/comments.csv' WITH CSV HEADER;

-- We have to manually update the "labelIDs" column in the issue table because
-- COPY doesn't run triggers.
UPDATE
    issue
SET
    "labelIDs" = (
        SELECT
            STRING_AGG("labelID", ',')
        FROM
            "issueLabel"
        WHERE
            "issueID" = issue.id
    );

-- Create the indices on upstream so we can copy to downstream on replication.
-- We have discussed that, in the future, the indices of the Zero replica
-- can / should diverge from the indices of the upstream. This is because
-- the Zero replica could be serving a different set of applications than the
-- upstream. If that is true, it would be beneficial to have indices dedicated
-- to those use cases. This may not be true, however.
--
-- Until then, I think it makes the most sense to copy the indices from upstream
-- to the replica. The argument in favor of this is that it gives the user a single
-- place to manage indices and it saves us a step in setting up our demo apps.
CREATE INDEX issuelabel_issueid_idx ON "issueLabel" ("issueID");

CREATE INDEX issue_modified_idx ON issue (modified);

CREATE INDEX issue_created_idx ON issue (created);

CREATE INDEX issue_open_modified_idx ON issue (open, modified);

CREATE INDEX comment_issueid_idx ON "comment" ("issueID");

SELECT
    *
FROM
    pg_create_logical_replication_slot('zero_0', 'pgoutput');

VACUUM;