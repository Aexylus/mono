import {useState} from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import {useRoute} from 'wouter';
import {useQuery} from 'zero-react/src/use-query.js';
import {useZero} from '../../domain/schema.js';
import Markdown from '../../components/markdown.js';
import Selector from '../../components/selector.js';

export default function IssuePage() {
  const z = useZero();
  const [isOpen, setIsOpen] = useState(false);
  const [match, params] = useRoute('/issue/:id');

  // Function to toggle the dropdown state
  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };
  const closeSelector = () => {
    setIsOpen(false);
  };

  // todo: one should be in the schema
  const q = z.query.issue
    .where('id', params?.id ?? '')
    .related('creator')
    .related('labels')
    .related('comments', comments =>
      comments
        .orderBy('created', 'asc')
        .related('creator', creator => creator.one()),
    )
    .one();
  const issue = useQuery(match && q);

  const [editing, setEditing] = useState<typeof issue | null>(null);
  const [edits, setEdits] = useState<Partial<typeof issue>>({});

  const save = () => {
    if (!editing) {
      return;
    }
    z.mutate.issue.update({id: editing.id, ...edits});
    setEditing(null);
    setEdits({});
  };

  const cancel = () => {
    setEditing(null);
    setEdits({});
  };

  // TODO: We need the notion of the 'partial' result type to correctly render
  // a 404 here. We can't put the 404 here now because it would flash until we
  // get data.
  if (!issue) {
    return null;
  }

  const rendering = editing ? {...editing, ...edits} : issue;

  return (
    <div className="issue-detail-container">
      {/* Center column of info */}
      <div className="issue-detail">
        <div className="issue-breadcrumb">
          <span className="breadcrumb-item">Open issues</span>
          <span className="breadcrumb-item">&rarr;</span>
          <span className="breadcrumb-item">ZB-15</span>
        </div>
        <div className="edit-button">
          {!editing ? (
            <button
              style={{border: '1px outset white'}}
              onMouseDown={() => setEditing(issue)}
            >
              Edit
            </button>
          ) : (
            <>
              <button style={{border: '1px outset white'}} onMouseDown={save}>
                Save
              </button>
              <button style={{border: '1px outset white'}} onMouseDown={cancel}>
                Cancel
              </button>
            </>
          )}
        </div>
        {!editing ? (
          <h1 className="issue-detail-title">{rendering.title}</h1>
        ) : (
          <TextareaAutosize
            value={rendering.title}
            style={{color: 'black', width: '600px'}}
            onChange={e => setEdits({...edits, title: e.target.value})}
          />
        )}

        {/* These comments are actually github markdown which unfortunately has
         HTML mixed in. We need to find some way to render them, or convert to
         standard markdown? break-spaces makes it render a little better */}
        {!editing ? (
          <Markdown>{rendering.description}</Markdown>
        ) : (
          <TextareaAutosize
            style={{color: 'black', width: '600px'}}
            value={rendering.description}
            onChange={e => setEdits({...edits, description: e.target.value})}
          />
        )}
        {issue.comments.length > 0 ? (
          <div className="comments-container">
            <h2 className="issue-detail-label">Comments</h2>
            {issue.comments.map(comment => (
              <div key={comment.id} className="comment-item">
                <p className="comment-author">{comment.creator.name}</p>
                <Markdown>{comment.body}</Markdown>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Right sidebar */}
      <div className="issue-sidebar">
        <div className="sidebar-item">
          <p className="issue-detail-label">Status</p>
          {rendering.open ? (
            <button
              onClick={toggleDropdown}
              className="sidebar-button button-dropdown sidebar-status-open"
            >
              Open
            </button>
          ) : (
            <button
              onClick={toggleDropdown}
              className="sidebar-button button-dropdown sidebar-status-closed"
            >
              Closed
            </button>
          )}
          <Selector isOpen={isOpen} onClose={closeSelector} />
        </div>

        <div className="sidebar-item">
          <p className="issue-detail-label">Creator</p>
          <button className="sidebar-button issue-creator">
            {issue.creator[0].name}
          </button>
        </div>

        <div className="sidebar-item">
          <p className="issue-detail-label">Labels</p>
          {issue.labels.map(label => (
            <span className="label-item" key={label.id}>
              {label.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
