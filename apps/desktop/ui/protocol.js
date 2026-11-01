(function (root) {
  'use strict';
  const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
  const STATES = new Set(['planning', 'executing', 'verifying', 'waiting', 'awaiting_input', 'cancel_requested', ...TERMINAL]);
  function valid(e) {
    return !!e && e.schema_version === '0.1' && typeof e.event_id === 'string' && !!e.event_id && typeof e.task_id === 'string' && !!e.task_id && Number.isSafeInteger(e.sequence) && e.sequence >= 0 && STATES.has(e.task_state) && (e.task_state !== 'succeeded' || e.phase === 'verified' && e.result?.verified === true) && (e.progress == null || Number.isFinite(e.progress.completed) && Number.isFinite(e.progress.total) && e.progress.total > 0 && e.progress.completed >= 0 && e.progress.completed <= e.progress.total);
  }
  class ConnectionGate {
    constructor() { this.connection = null; this.session = null; this.snapshot = null; this.sequence = -1; this.connected = false; }
    restore(hello) {
      if (hello.type !== 'hello' || typeof hello.connection_id !== 'string' || !hello.connection_id || typeof hello.session_id !== 'string' || !hello.session_id) return { accepted: false, reason: 'invalid-hello' };
      if (hello.snapshot && (!valid(hello.snapshot) || hello.snapshot.session_id !== hello.session_id)) return { accepted: false, reason: 'invalid-snapshot' };
      this.connection = hello.connection_id; this.session = hello.session_id; this.connected = true;
      this.snapshot = hello.snapshot ? JSON.parse(JSON.stringify(hello.snapshot)) : null; this.sequence = this.snapshot?.sequence ?? -1;
      return { accepted: true, restored: true, snapshot: this.snapshot, celebrate: false };
    }
    accept(envelope) {
      const e = envelope.event;
      const reject = reason => ({ accepted: false, reason });
      if (!this.connected || envelope.connection_id !== this.connection || envelope.session_id !== this.session) return reject('old-connection');
      if (!valid(e) || e.session_id !== this.session) return reject('invalid-event');
      if (this.snapshot && e.task_id !== this.snapshot.task_id) {
        if (envelope.type !== 'task-started' || e.sequence !== 0 || e.task_state !== 'planning' || !TERMINAL.has(this.snapshot.task_state)) return reject('wrong-task');
        this.sequence = -1;
      }
      if (e.sequence <= this.sequence) return reject('duplicate-or-stale');
      if (this.snapshot?.task_id === e.task_id && TERMINAL.has(this.snapshot.task_state)) return reject('terminal-locked');
      if (this.snapshot?.task_state === 'cancel_requested' && !['cancel_requested', 'waiting', ...TERMINAL].includes(e.task_state)) return reject('cancel-pending');
      this.snapshot = JSON.parse(JSON.stringify(e)); this.sequence = e.sequence;
      return { accepted: true, snapshot: this.snapshot, celebrate: e.task_state === 'succeeded' };
    }
    disconnect() { this.connected = false; }
  }
  const api = { ConnectionGate, valid, TERMINAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HostProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
