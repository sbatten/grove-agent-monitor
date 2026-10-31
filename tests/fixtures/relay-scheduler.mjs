// A simulated host for send_message delivery, following the host's contract:
// - delivery "steer" to an idle chat is rejected with reason "cannotSteer";
// - delivery "steer" otherwise fills the chat's one steering slot (a newer steer replaces it), and the
//   message lands at the chat's next tool boundary, inside the active turn;
// - delivery "queue" (the default) to a busy chat waits until its turn ends; to an idle chat it starts a turn.
// The timing is simulated: it shows ordering, not real latency.
export class RelayHost {
  constructor() {
    this.chats = new Map();
    this.trace = [];
    this.clock = 0;
  }

  // `onPrompt(message)` is what the chat sees when a message is delivered (the user-prompt hook, when on).
  // `reject` makes every send to the chat fail with that reason (e.g. a provider error).
  add(link, onPrompt, { active = false, hookEnabled = true, reject = null } = {}) {
    this.chats.set(link, { link, onPrompt, active, hookEnabled, reject, queue: [], steer: null, seen: [] });
  }

  log(event, link, detail = {}) {
    this.trace.push({ t: ++this.clock, event, chat: link, ...detail });
  }

  async send({ session, message, delivery = 'queue' }) {
    const c = this.chats.get(session);
    if (!c) throw new Error(`unknown chat ${session}`);
    if (c.reject) {
      this.log('rejected', session, { delivery, reason: c.reject });
      return { action: 'rejected', reason: c.reject };
    }
    if (delivery === 'steer') {
      if (!c.active) {
        this.log('rejected', session, { delivery, reason: 'cannotSteer' });
        return { action: 'rejected', reason: 'cannotSteer' };
      }
      if (c.steer) this.log('steer-replaced', session);
      c.steer = message;
      this.log('steered', session, { delivery });
      return { action: 'steered' };
    }
    if (c.active) {
      c.queue.push(message);
      this.log('queued', session, { delivery });
      return { action: 'queued' };
    }
    this.log('started', session, { delivery });
    await this.startTurn(c, message);
    return { action: 'started' };
  }

  // Send as an agent following Grove's instructions: steer, and on "cannotSteer" send it again queued.
  async relay({ session, message, delivery }) {
    const first = await this.send({ session, message, delivery });
    if (first.action === 'rejected' && first.reason === 'cannotSteer') return [first, await this.send({ session, message, delivery: 'queue' })];
    return [first];
  }

  async startTurn(c, message) {
    c.active = true;
    this.log('turn-start', c.link);
    return this.deliver(c, message);
  }

  async deliver(c, message) {
    c.seen.push(message);
    this.log('delivered', c.link, { message: message.slice(0, 60) });
    c.lastContext = c.hookEnabled ? await c.onPrompt(message) : null;
    return c.lastContext;
  }

  // The chat finished a tool call: a steered message lands now.
  async boundary(link, tool = 'tool') {
    const c = this.chats.get(link);
    this.log('tool-boundary', link, { tool });
    if (!c.steer) return null;
    const m = c.steer;
    c.steer = null;
    return this.deliver(c, m);
  }

  // The chat's turn ended: a pending steer goes to the front of the queue, and the next queued message starts a turn.
  async endTurn(link) {
    const c = this.chats.get(link);
    this.log('turn-end', link);
    c.active = false;
    if (c.steer) { c.queue.unshift(c.steer); c.steer = null; }
    const next = c.queue.shift();
    if (next !== undefined) return this.startTurn(c, next);
    return null;
  }
}
