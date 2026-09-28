/**
 * Triage — web app backend for the triage queue (docs/DESIGN.md "Triage web app").
 *
 *   doGet(e)                    -> TriageUI.html (HtmlService template)
 *   triageList()                -> {items, sections, filtered, generatedAt, warnings}
 *   triageAct(id, action, patch) -> {item, message}
 *
 * Actions (all on one queue item; the UI calls triageAct once per selected item):
 *   accept   dup (and not notDuplicate) -> comment on the existing task
 *            waiting (kind or project 'Waiting') -> Waiting.create (hidden project, resurfaces later)
 *            otherwise -> new task in project/section with the source's label and description
 *   dismiss  status 'dismissed' + feedback 'dismissed' (negative example for Extract)
 *   wait     park in Waiting on others now (patch {waitOn?, waitOnEmail?, resurface?}) + feedback 'rerouted'
 *   move     change destination (patch {project, section?}); project 'Waiting' turns it into a waiting item
 *   edit     change wording (patch {title?, due?}) + feedback 'edited'
 *   undup    toggle notDuplicate (only when a duplicate was detected) + a 'not_duplicate' feedback row
 *            for every change: set -> {dupTaskId, dupTaskTitle}; cleared -> same + {cleared: true}
 *   undo     reverse this item's last action: delete the task/comment it created, restore the fields
 *
 * Every action that changes something pushes an undo record onto item.undo (kept in the queue JSON,
 * last UNDO_MAX) and returns changed: true. No-ops (unchanged destination/title, undup to the current
 * state) push nothing and return changed: false, so the page must not add them to its undo stack.
 *
 * Feedback withdrawal contract (feedback rows are append-only):
 *   - not_duplicate is a state log per (item, dupTaskId); the NEWEST row wins. Clearing the flag, or
 *     undoing a set, appends a row with detail.cleared = true; undoing a clear appends a plain row.
 *     Dedupe.blockedTaskIds_ honours detail.cleared, and the row stays visible to callers that load
 *     feedbackRecent(n, 'not_duplicate') only (Meetings, Slack).
 *   - undoing dismiss / edit / move / wait appends {type: 'undone', queueId, detail: {action, at}}, where
 *     detail.at equals the `at` of the feedback row(s) that action wrote, so readers can drop them.
 *
 * Side effects before state: accept/wait create the Todoist task or comment first, then save the queue
 * item. If saving fails, the task/comment just created is deleted again (compensation) before the error
 * reaches the page, so a retry cannot leave a second copy. Feedback rows are written after the state is
 * saved and are best-effort (a failure is logged and noted in the message, never rolled back).
 *
 * google.script.run reference (argument/return values must be plain JSON-like data; a thrown
 * Error reaches withFailureHandler with its message): https://developers.google.com/apps-script/guides/html/reference/run
 * Todoist API v1 (tasks, comments DELETE /comments/{id}): https://developer.todoist.com/api/v1/
 */
const Triage = {
  ACTIONS: ['accept', 'dismiss', 'wait', 'move', 'edit', 'undup', 'undo'],
  PROJECT_KEYS: ['GR', 'ISC', 'Me', 'SG'],
  WAITING: 'Waiting',
  UNDO_MAX: 10,
  KV_FILTERED: 'inbox.lastFiltered',
  MAX_TITLE: 300,

  /** Label per queue source (DESIGN "Todoist client" labels). */
  LABELS_: { meeting: 'meeting', email: 'from-email', slack: 'from-slack', system: 'check' },

  /** Fields the UI needs (the ready-made description and undo stack stay server-side). */
  CLIENT_FIELDS_: [
    'id', 'status', 'createdAt', 'source', 'sourceKey', 'origin', 'link', 'title', 'quote', 'why', 'kind', 'due',
    'resurface', 'waitOn', 'waitOnEmail', 'project', 'section', 'confidence', 'routeConfidence', 'dupTaskId',
    'dupTaskTitle', 'chips', 'resolvedAt', 'resultTaskId', 'notDuplicate'
  ],

  // ------------------------------------------------------------------ web app

  /** HtmlService page for the web app. */
  page(e) {
    return HtmlService.createTemplateFromFile('TriageUI').evaluate()
      .setTitle('Todo Triage')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  },

  // ------------------------------------------------------------------ list

  /**
   * Pending queue items plus the section catalogue and the inbox filter summary.
   * @return {{items: Object[], sections: Object, filtered: {count, examples, byReason, at, seen},
   *           generatedAt: string, warnings: string[]}}
   */
  list() {
    const warnings = [];
    const items = Store.queueList({ status: 'pending' }).map(Triage.clientItem);
    // Per project, straight from Todoist: Route/Todoist.sectionCatalogue swallow errors as [], which
    // would hide an outage behind an empty section list.
    const sections = {};
    const failed = [];
    let firstErr = null;
    Triage.PROJECT_KEYS.forEach(function (k) {
      try {
        sections[k] = Triage.sectionNames_(k);
      } catch (e) {
        sections[k] = [];
        failed.push(k);
        if (!firstErr) firstErr = e;
      }
    });
    if (failed.length) {
      warnings.push('Could not load Todoist sections for ' + failed.join(', ') + ': ' + Triage.errText_(firstErr));
    }
    let filtered = null;
    try {
      filtered = Store.kvGet(Triage.KV_FILTERED, null);
    } catch (e) {
      warnings.push('Could not read the inbox filter summary: ' + Triage.errText_(e));
    }
    return {
      items: items,
      sections: sections,
      filtered: Triage.filteredSummary_(filtered),
      generatedAt: Util.now().toISOString(),
      warnings: warnings
    };
  },

  /** Queue item -> plain object for the UI (+ canUndo, dupTaskUrl, resultTaskUrl). */
  clientItem(item) {
    const out = {};
    Triage.CLIENT_FIELDS_.forEach(function (k) {
      out[k] = item[k] === undefined ? null : item[k];
    });
    out.chips = Array.isArray(item.chips) ? item.chips.slice() : [];
    out.notDuplicate = !!item.notDuplicate;
    out.kind = item.kind === 'waiting' ? 'waiting' : 'todo';
    out.canUndo = Array.isArray(item.undo) && item.undo.length > 0;
    out.dupTaskUrl = item.dupTaskId ? Todoist.taskUrl(item.dupTaskId) : null;
    out.resultTaskUrl = item.resultTaskId ? Todoist.taskUrl(item.resultTaskId) : null;
    return out;
  },

  filteredSummary_(f) {
    if (!f || typeof f !== 'object') return { count: 0, examples: [], byReason: {}, at: null, seen: null };
    return {
      count: +f.count || 0,
      examples: Array.isArray(f.examples) ? f.examples.slice(0, 20).map(function (x) {
        return { subject: String((x && x.subject) || ''), from: String((x && x.from) || ''), reason: String((x && x.reason) || '') };
      }) : [],
      byReason: f.byReason && typeof f.byReason === 'object' ? f.byReason : {},
      at: f.at || null,
      seen: f.seen === undefined ? null : f.seen
    };
  },

  // ------------------------------------------------------------------ act

  /**
   * Perform one action on one queue item.
   * @param {string} id queue id
   * @param {string} action one of Triage.ACTIONS
   * @param {Object} [patch] action-specific fields (see file header)
   * @return {{item: Object, message: string, changed: boolean}} item in client shape; changed is false
   *   for a no-op (nothing saved, no undo record pushed)
   */
  act(id, action, patch) {
    if (!id) throw new Error('No suggestion id given');
    if (Triage.ACTIONS.indexOf(action) < 0) throw new Error('Unknown action: ' + action);
    const item = Store.queueGet(id);
    if (!item) throw new Error('This suggestion no longer exists (it may have been removed from the queue)');
    const p = patch && typeof patch === 'object' ? patch : {};
    if (action !== 'undo' && item.status !== 'pending') {
      throw new Error('Already ' + item.status + '. Press z to undo it first.');
    }
    const res = Triage['do_' + action + '_'](item, p);
    return { item: Triage.clientItem(res.item), message: res.message, changed: res.changed !== false };
  },

  // accept ----------------------------------------------------------------

  do_accept_(item, p) {
    const prev = Triage.snapshot_(item);
    const edits = Triage.applyEdits_(item, p);
    const now = Util.now().toISOString();
    let effect, status, resultTaskId, message;

    if (Triage.isWaiting_(item)) {
      const task = Waiting.create(Triage.waitingInput_(item));
      effect = { type: 'task', taskId: String(task.id) };
      status = 'waiting';
      resultTaskId = String(task.id);
      message = 'Parked in Waiting on others until ' + Triage.dayLabel_(Triage.dueOf_(task) || item.resurface);
    } else if (item.dupTaskId && !item.notDuplicate) {
      let comment;
      try {
        comment = Todoist.addComment(item.dupTaskId, Triage.commentText_(item));
      } catch (e) {
        if (e && e.status === 404) {
          throw new Error('The matching task no longer exists. Press u (not a duplicate) to create a new task instead.');
        }
        throw e;
      }
      effect = { type: 'comment', taskId: String(item.dupTaskId), commentId: comment && comment.id ? String(comment.id) : null };
      status = 'accepted';
      resultTaskId = String(item.dupTaskId);
      message = 'Added as a comment on “' + Util.truncate(item.dupTaskTitle || 'the existing task', 60) + '”';
    } else {
      const task = Todoist.createTask(Triage.taskInput_(item));
      effect = { type: 'task', taskId: String(task.id) };
      status = 'accepted';
      resultTaskId = String(task.id);
      message = 'Accepted → ' + Triage.destLabel_(item);
    }

    const updated = Triage.saveOrCompensate_(item.id, Object.assign(Triage.fieldsOf_(item), {
      status: status, resolvedAt: now, resultTaskId: resultTaskId,
      undo: Triage.pushUndo_(item, { action: 'accept', at: now, prev: prev, effect: effect, fb: edits.length > 0 })
    }), effect);
    message += Triage.addFeedback_(edits.map(function (fb) { return Object.assign({ at: now }, fb); }));
    return { item: updated, message: message };
  },

  // dismiss ---------------------------------------------------------------

  do_dismiss_(item, p) {
    const prev = Triage.snapshot_(item);
    const now = Util.now().toISOString();
    const updated = Store.queueUpdate(item.id, {
      status: 'dismissed', resolvedAt: now,
      undo: Triage.pushUndo_(item, { action: 'dismiss', at: now, prev: prev, effect: null })
    });
    const note = Triage.addFeedback_([{
      at: now, type: 'dismissed', queueId: item.id, sourceKey: item.sourceKey || '', title: item.title || '',
      detail: { source: item.source || null, origin: item.origin || null, quote: Util.truncate(item.quote || '', 300),
        why: item.why || null, project: item.project || null, section: item.section || null, kind: item.kind || null,
        reason: p.reason || null }
    }]);
    return { item: updated, message: 'Dismissed “' + Util.truncate(item.title || '', 48) + '”' + note };
  },

  // wait ------------------------------------------------------------------

  do_wait_(item, p) {
    const prev = Triage.snapshot_(item);
    const now = Util.now().toISOString();
    const wasTodo = item.kind !== 'waiting';
    if (p.waitOn !== undefined && p.waitOn !== null && String(p.waitOn).trim()) item.waitOn = String(p.waitOn).trim();
    if (p.waitOnEmail) item.waitOnEmail = Util.parseEmail(p.waitOnEmail) || item.waitOnEmail || null;
    if (p.resurface !== undefined) {
      if (p.resurface && !Util.isIsoDate(p.resurface)) throw new Error('Resurface date must be YYYY-MM-DD');
      item.resurface = p.resurface || null;
    }
    item.kind = 'waiting';
    if (item.project === Triage.WAITING) item.project = null;
    const task = Waiting.create(Triage.waitingInput_(item));
    const effect = { type: 'task', taskId: String(task.id) };
    const updated = Triage.saveOrCompensate_(item.id, Object.assign(Triage.fieldsOf_(item), {
      status: 'waiting', resolvedAt: now, resultTaskId: String(task.id),
      undo: Triage.pushUndo_(item, { action: 'wait', at: now, prev: prev, effect: effect, fb: wasTodo })
    }), effect);
    const note = wasTodo ? Triage.addFeedback_([{
      at: now, type: 'rerouted', queueId: item.id, sourceKey: item.sourceKey || '', title: item.title || '',
      detail: { from: { kind: 'todo', project: prev.project, section: prev.section }, to: { kind: 'waiting', waitOn: item.waitOn || null } }
    }]) : '';
    return {
      item: updated,
      message: 'Parked in Waiting on others' + (item.waitOn ? ' (' + item.waitOn + ')' : '') + ' until ' +
        Triage.dayLabel_(Triage.dueOf_(task) || item.resurface) + note
    };
  },

  // move ------------------------------------------------------------------

  do_move_(item, p) {
    const prev = Triage.snapshot_(item);
    const now = Util.now().toISOString();
    const dest = Triage.resolveDest_(item, p);
    const changed = dest.kind !== (item.kind === 'waiting' ? 'waiting' : 'todo') ||
      dest.project !== (item.project || null) || dest.section !== (item.section || null);
    if (!changed) return { item: item, changed: false, message: 'Destination unchanged: ' + Triage.destLabel_(item) };
    item.kind = dest.kind;
    item.project = dest.project;
    item.section = dest.section;
    const updated = Store.queueUpdate(item.id, Object.assign(Triage.fieldsOf_(item), {
      undo: Triage.pushUndo_(item, { action: 'move', at: now, prev: prev, effect: null })
    }));
    const note = Triage.addFeedback_([{
      at: now, type: 'rerouted', queueId: item.id, sourceKey: item.sourceKey || '', title: item.title || '',
      detail: { from: { kind: prev.kind, project: prev.project, section: prev.section },
        to: { kind: dest.kind, project: dest.project, section: dest.section } }
    }]);
    return { item: updated, message: 'Destination set: ' + Triage.destLabel_(updated) + '. Press s to accept' + note };
  },

  // edit ------------------------------------------------------------------

  do_edit_(item, p) {
    const prev = Triage.snapshot_(item);
    const now = Util.now().toISOString();
    const edits = Triage.applyEdits_(item, p);
    if (!edits.length) return { item: item, changed: false, message: 'No change' };
    const updated = Store.queueUpdate(item.id, Object.assign(Triage.fieldsOf_(item), {
      undo: Triage.pushUndo_(item, { action: 'edit', at: now, prev: prev, effect: null })
    }));
    const note = Triage.addFeedback_(edits.map(function (fb) { return Object.assign({ at: now }, fb); }));
    return { item: updated, message: 'Saved: “' + Util.truncate(updated.title, 60) + '”' + note };
  },

  // undup -----------------------------------------------------------------

  do_undup_(item, p) {
    if (!item.dupTaskId) throw new Error("This one isn't flagged as a duplicate");
    const prev = Triage.snapshot_(item);
    const now = Util.now().toISOString();
    const next = p.notDuplicate === undefined ? !item.notDuplicate : !!p.notDuplicate;
    if (next === !!item.notDuplicate) {
      return { item: item, changed: false, message: next ? 'Already marked as not a duplicate' : 'Already flagged as a duplicate' };
    }
    const updated = Store.queueUpdate(item.id, {
      notDuplicate: next,
      undo: Triage.pushUndo_(item, { action: 'undup', at: now, prev: prev, effect: null })
    });
    const note = Triage.addFeedback_([Triage.notDupRow_(item, next, now)]);
    return {
      item: updated,
      message: (next ? 'Not a duplicate: accepting will create a new task' : 'Flagged as a duplicate again: accepting adds a comment') + note
    };
  },

  // undo ------------------------------------------------------------------

  do_undo_(item, p) {
    const stack = Array.isArray(item.undo) ? item.undo.slice() : [];
    const rec = stack.pop();
    if (!rec) throw new Error('Nothing to undo for this suggestion');
    const notes = [];
    const eff = rec.effect;
    if (eff && eff.type === 'task' && eff.taskId) {
      try {
        Todoist.deleteTask(eff.taskId);
      } catch (e) {
        if (!e || e.status !== 404) throw new Error('Could not delete the Todoist task: ' + Triage.errText_(e));
        notes.push('task was already gone');
      }
    } else if (eff && eff.type === 'comment') {
      if (eff.commentId) {
        try {
          Triage.deleteComment_(eff.commentId);
        } catch (e) {
          if (!e || e.status !== 404) throw new Error('Could not delete the Todoist comment: ' + Triage.errText_(e));
          notes.push('comment was already gone');
        }
      } else {
        notes.push('the comment could not be removed automatically');
      }
    }
    const restore = Object.assign({}, rec.prev || {}, { undo: stack });
    const updated = Store.queueUpdate(item.id, restore);
    const now = Util.now().toISOString();
    let fb = null;
    if (rec.action === 'undup' && item.dupTaskId) {
      // Restore the previous not_duplicate state as the newest row (see file header).
      fb = Triage.notDupRow_(item, !!(rec.prev && rec.prev.notDuplicate), now);
    } else if (Triage.wroteFeedback_(rec)) {
      fb = {
        at: now, type: 'undone', queueId: item.id, sourceKey: item.sourceKey || '', title: item.title || '',
        detail: { action: rec.action, at: rec.at || null }
      };
    }
    const note = fb ? Triage.addFeedback_([fb]) : '';
    return { item: updated, message: 'Undone' + (notes.length ? ' (' + notes.join('; ') + ')' : '') + note };
  },

  /** Actions (other than undup, which has its own state rows) whose feedback an undo withdraws. */
  FEEDBACK_ACTIONS_: { dismiss: 1, edit: 1, move: 1, wait: 1, accept: 1 },

  // ------------------------------------------------------------------ helpers

  /** Fields an undo restores. */
  snapshot_(item) {
    return {
      status: item.status || 'pending', title: item.title || '', project: item.project || null,
      section: item.section || null, kind: item.kind === 'waiting' ? 'waiting' : 'todo', due: item.due || null,
      waitOn: item.waitOn || null, waitOnEmail: item.waitOnEmail || null, resurface: item.resurface || null,
      notDuplicate: !!item.notDuplicate, resolvedAt: item.resolvedAt || null, resultTaskId: item.resultTaskId || null
    };
  },

  /** Editable fields to persist after in-place changes. */
  fieldsOf_(item) {
    return {
      title: item.title, project: item.project || null, section: item.section || null,
      kind: item.kind === 'waiting' ? 'waiting' : 'todo', due: item.due || null, waitOn: item.waitOn || null,
      waitOnEmail: item.waitOnEmail || null, resurface: item.resurface || null
    };
  },

  pushUndo_(item, rec) {
    const stack = Array.isArray(item.undo) ? item.undo.slice() : [];
    stack.push(rec);
    return stack.slice(-Triage.UNDO_MAX);
  },

  /**
   * Apply {title?, due?, project?, section?} edits to item in place (used by edit and accept).
   * @return {Object[]} feedback entries to record ('edited' / 'rerouted')
   */
  applyEdits_(item, p) {
    const out = [];
    if (p.title !== undefined && p.title !== null) {
      const t = Util.truncate(String(p.title).replace(/\s+/g, ' ').trim(), Triage.MAX_TITLE);
      if (!t) throw new Error('The title cannot be empty');
      if (t !== item.title) {
        out.push({ type: 'edited', queueId: item.id, sourceKey: item.sourceKey || '', title: t,
          detail: { field: 'title', from: item.title || '', to: t } });
        item.title = t;
      }
    }
    if (p.due !== undefined) {
      const d = p.due || null;
      if (d && !Util.isIsoDate(d)) throw new Error('Due date must be YYYY-MM-DD');
      if (d !== (item.due || null)) {
        out.push({ type: 'edited', queueId: item.id, sourceKey: item.sourceKey || '', title: item.title || '',
          detail: { field: 'due', from: item.due || null, to: d } });
        item.due = d;
      }
    }
    if (p.project !== undefined || p.section !== undefined) {
      const dest = Triage.resolveDest_(item, p);
      if (dest.kind !== (item.kind === 'waiting' ? 'waiting' : 'todo') || dest.project !== (item.project || null) ||
        dest.section !== (item.section || null)) {
        out.push({ type: 'rerouted', queueId: item.id, sourceKey: item.sourceKey || '', title: item.title || '',
          detail: { from: { kind: item.kind || 'todo', project: item.project || null, section: item.section || null },
            to: { kind: dest.kind, project: dest.project, section: dest.section } } });
        item.kind = dest.kind;
        item.project = dest.project;
        item.section = dest.section;
      }
    }
    return out;
  },

  /**
   * Destination from a move patch. {project: 'Waiting'} -> waiting item (project kept as the follow-up destination).
   * Without an explicit section the current one is kept if it exists in the new project, else the project root.
   * @return {{kind, project, section}}
   */
  resolveDest_(item, p) {
    const rawProject = p.project === undefined ? item.project : p.project;
    if (rawProject && String(rawProject).toLowerCase() === 'waiting') {
      return { kind: 'waiting', project: item.project || null, section: item.section || null };
    }
    const project = rawProject ? Route.normalizeKey(rawProject) : null;
    if (rawProject && !project) throw new Error('Unknown project: ' + rawProject);
    let section = null;
    if (project) {
      const want = p.section !== undefined ? p.section : item.section;
      if (want) {
        // Load this project's sections so an outage is an error, not "section missing" (which would
        // silently drop the item's section to the project root).
        let names;
        try {
          names = Triage.sectionNames_(project);
        } catch (e) {
          throw new Error('Could not load the Todoist sections for ' + project + ', so nothing was changed. ' +
            'Try again in a moment (' + Triage.errText_(e) + ')');
        }
        const cat = {};
        cat[project] = names;
        section = Route.section(project, want, cat);
        if (!section && p.section !== undefined) throw new Error('Section “' + p.section + '” does not exist in ' + project);
      }
    }
    return { kind: 'todo', project: project, section: section };
  },

  /** Section names of one routing key, live (cached) from Todoist; throws on API errors. */
  sectionNames_(key) {
    return Todoist.sectionNames(key);
  },

  /**
   * Store.queueUpdate after a Todoist side effect. If saving fails, delete the task/comment that was
   * just created (so a retry cannot leave a second one) and rethrow with what happened.
   */
  saveOrCompensate_(id, patch, effect) {
    try {
      return Store.queueUpdate(id, patch);
    } catch (e) {
      let undone;
      try {
        if (effect && effect.type === 'task' && effect.taskId) Todoist.deleteTask(effect.taskId);
        else if (effect && effect.type === 'comment' && effect.commentId) Triage.deleteComment_(effect.commentId);
        else throw new Error('nothing to remove');
        undone = true;
      } catch (e2) {
        undone = e2 && e2.status === 404;
        console.log('Triage: compensation failed for ' + id + ': ' + Triage.errText_(e2));
      }
      const what = effect && effect.type === 'comment' ? 'comment' : 'task';
      throw new Error('Could not save the triage state (' + Triage.errText_(e) + '). ' + (undone
        ? 'The Todoist ' + what + ' it created was removed again, so it is safe to retry.'
        : 'The Todoist ' + what + ' it created could not be removed: check Todoist before retrying.'));
    }
  },

  /** Append feedback rows; best-effort. Returns '' or a short note for the message. */
  addFeedback_(rows) {
    let failed = 0;
    (rows || []).forEach(function (fb) {
      try {
        Store.feedbackAdd(fb);
      } catch (e) {
        failed++;
        console.log('Triage: could not record ' + fb.type + ' feedback for ' + fb.queueId + ': ' + Triage.errText_(e));
      }
    });
    return failed ? ' (feedback not recorded)' : '';
  },

  /** not_duplicate state row for (item, dupTaskId): blocked = true suppresses the match, false clears it. */
  notDupRow_(item, blocked, at) {
    const detail = { dupTaskId: String(item.dupTaskId), dupTaskTitle: item.dupTaskTitle || null };
    if (!blocked) detail.cleared = true;
    return { at: at, type: 'not_duplicate', queueId: item.id, sourceKey: item.sourceKey || '', title: item.title || '', detail: detail };
  },

  /** Did the action recorded in `rec` write feedback that an undo should withdraw? */
  wroteFeedback_(rec) {
    if (!Triage.FEEDBACK_ACTIONS_[rec.action]) return false;
    if (rec.fb !== undefined) return !!rec.fb;
    return rec.action !== 'accept';
  },

  /** DELETE /comments/{id} (Todoist API v1: https://developer.todoist.com/api/v1/#tag/Comments). */
  deleteComment_(commentId) {
    return Todoist.api('delete', '/comments/' + encodeURIComponent(commentId));
  },

  isWaiting_(item) {
    return item.kind === 'waiting' || item.project === Triage.WAITING;
  },

  /** Waiting.create input from a queue item (project 'Waiting' is not a follow-up destination). */
  waitingInput_(item) {
    const it = Object.assign({}, item);
    if (it.project === Triage.WAITING) it.project = null;
    delete it.undo;
    return it;
  },

  /** Todoist.createTask input for a normal accept. */
  taskInput_(item) {
    const label = Triage.LABELS_[item.source];
    const labels = Array.isArray(item.labels) && item.labels.length ? item.labels.slice() : (label ? [label] : []);
    const machine = { q: item.id };
    if (item.sourceKey) machine.key = item.sourceKey;
    let description;
    if (item.description) {
      const old = Todoist.parseMachineLine(item.description) || {};
      description = Todoist.withMachineLine(item.description, Object.assign({}, machine, old));
    } else {
      const lines = [];
      if (item.origin) lines.push(item.origin);
      if (item.link) lines.push('[Open source](' + item.link + ')');
      const quote = String(item.quote || '').trim();
      if (quote) lines.push(quote.split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'));
      description = Todoist.withMachineLine(lines.join('\n'), { key: machine.key, q: machine.q });
    }
    const t = {
      content: item.title,
      description: description,
      projectName: item.project || 'Inbox',
      labels: labels
    };
    if (item.project && item.section) t.sectionName = item.section;
    if (item.due && Util.isIsoDate(item.due)) t.dueDate = item.due;
    return t;
  },

  /** Comment added to the existing task when a duplicate is accepted. */
  commentText_(item) {
    const lines = ['Also came up: ' + (item.title || '')];
    if (item.origin) lines.push(item.origin);
    if (item.link) lines.push('[Open source](' + item.link + ')');
    const quote = String(item.quote || '').trim();
    if (quote) lines.push(Util.truncate(quote, 600).split(/\r?\n/).map(function (l) { return '> ' + l; }).join('\n'));
    return lines.join('\n');
  },

  destLabel_(item) {
    if (Triage.isWaiting_(item)) return 'Waiting on others';
    if (item.dupTaskId && !item.notDuplicate) return 'a comment on the existing task';
    if (!item.project) return 'Inbox';
    return item.project + (item.section ? ' › ' + item.section : '');
  },

  dueOf_(task) {
    const d = task && task.due && (task.due.date || task.due.datetime);
    return d ? String(d).slice(0, 10) : null;
  },

  /** 'Fri 2 Oct' for an ISO day; 'in 7 days' when unknown. */
  dayLabel_(iso) {
    if (!iso || !Util.isIsoDate(String(iso).slice(0, 10))) return 'in 7 days';
    const parts = String(iso).slice(0, 10).split('-').map(Number);
    // Noon UTC keeps the calendar day stable in any US/EU script time zone.
    return Util.formatDay(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12)));
  },

  errText_(e) {
    if (!e) return 'unknown error';
    return (e.status ? 'HTTP ' + e.status + ': ' : '') + (e.message || String(e));
  }
};

/** Web app entrypoint. */
function doGet(e) {
  return Triage.page(e);
}

/** google.script.run: pending suggestions + sections + filtered-email summary. */
function triageList() {
  return Triage.list();
}

/** google.script.run: perform an action on one suggestion. */
function triageAct(id, action, patch) {
  return Triage.act(id, action, patch);
}
