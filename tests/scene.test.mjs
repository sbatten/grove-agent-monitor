// Run: node tests/scene.test.mjs
// Team tents at camp: pitched per task, idle members rest inside (not drawn), struck when the team leaves.
import assert from 'node:assert/strict';
import { Cast } from '../extensions/grove-agent-monitor/web/scene/actors.mjs';
import { tentSlot, TENT_SPACIOUS, W, H } from '../extensions/grove-agent-monitor/web/scene/layout.mjs';

const ag = (id, activity, taskId, taskColor) => ({ id, name: id, role: 'generalist', activity, task: '', taskId, taskColor, error: '' });
const run = (cast, ticks) => { for (let i = 0; i < ticks; i++) cast.update(1); };

// First sync places everyone without walking: team members start inside a fully pitched tent.
const cast = new Cast();
cast.sync([ag('chief', 'idle'), ag('lead-T1', 'idle', 'T1', 'amber'), ag('T1-planner', 'planning', 'T1', 'amber'), ag('T1-rev', 'idle', 'T1', 'amber')], null);
assert.deepEqual([...cast.tents.values()].map((t) => [t.taskId, t.slot, t.raised, t.color]), [['T1', 0, 1, 'amber']]);
assert.deepEqual(cast.team('T1').inside.map((a) => a.id).sort(), ['T1-rev', 'lead-T1']);
assert.deepEqual(cast.team('T1').out.map((a) => a.id), ['T1-planner']);
assert.equal(cast.actors.get('chief').inside, false, 'agents without a task sit at the fire');
assert.equal(cast.actors.get('chief').station, 'camp');
const tent = cast.tents.get('T1');
assert.equal(cast.hitTest(tent.x, tent.y - 4), null, 'members inside are not hit-testable');
assert.equal(cast.tentAt(tent.x, tent.y - 10)?.taskId, 'T1');
assert.equal(cast.tentAt(tent.x + 60, tent.y - 10), null);

// A member goes back to work: it leaves the tent and walks to its station; then comes back in.
cast.sync([ag('chief', 'idle'), ag('lead-T1', 'idle', 'T1', 'amber'), ag('T1-planner', 'planning', 'T1', 'amber'), ag('T1-rev', 'plan-review', 'T1', 'amber')], null);
assert.equal(cast.actors.get('T1-rev').inside, false);
assert.ok(cast.actors.get('T1-rev').walking);
run(cast, 400);
assert.equal(cast.actors.get('T1-rev').station, 'plan-review');
cast.sync([ag('chief', 'idle'), ag('lead-T1', 'idle', 'T1', 'amber'), ag('T1-planner', 'idle', 'T1', 'amber'), ag('T1-rev', 'idle', 'T1', 'amber')], null);
assert.equal(cast.actors.get('T1-planner').tentId, 'T1');
assert.equal(cast.actors.get('T1-planner').inside, false, 'walking back first');
run(cast, 600);
assert.equal(cast.team('T1').inside.length, 3, 'everyone back inside');

// A new team pitches a tent in the next slot, raised over time from the ground.
cast.sync([ag('chief', 'idle'), ag('lead-T1', 'idle', 'T1', 'amber'), ag('lead-T2', 'idle', 'T2', 'cyan1')], null);
const t2 = cast.tents.get('T2');
assert.equal(t2.slot, 1);
assert.equal(t2.raised, 0);
run(cast, 10);
assert.ok(t2.raised > 0 && t2.raised < 1);
run(cast, 40);
assert.equal(t2.raised, 1);
assert.equal(cast.tents.get('T1').standing, true);

// T1 finishes: its members walk out of the grove and its tent is struck, freeing the slot.
cast.sync([ag('chief', 'idle'), ag('lead-T2', 'idle', 'T2', 'cyan1')], null);
assert.equal(cast.tents.get('T1').standing, false);
assert.ok([...cast.actors.values()].filter((a) => a.id.includes('T1')).every((a) => a.leaving && !a.inside));
run(cast, 60);
assert.equal(cast.tents.has('T1'), false, 'struck once nobody is inside');
cast.sync([ag('chief', 'idle'), ag('lead-T2', 'idle', 'T2', 'cyan1'), ag('lead-T3', 'idle', 'T3', 'magenta1')], null);
assert.equal(cast.tents.get('T3').slot, 0, 'the freed slot nearest the fire is reused');

// No limit: every team gets a tent. The first TENT_SPACIOUS (10) pitch without touching; past that they
// pack into the gaps, always inside the scene's camp band and clear of the fire seats.
assert.equal(TENT_SPACIOUS, 10);
const box = (i) => { const { x, y } = tentSlot(i); return [x - 10, y - 17, x + 11, y]; };
for (let i = 0; i < TENT_SPACIOUS; i++) for (let j = i + 1; j < TENT_SPACIOUS; j++) {
  const [a, b] = [box(i), box(j)];
  assert.ok(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1], `spacious tents ${i} and ${j} don't overlap`);
}
const seen = new Set();
for (let i = 0; i < 60; i++) {
  const { x, y, node } = tentSlot(i);
  assert.ok(x - 10 >= 120 && x + 11 <= 372 && y - 17 >= 266 && y <= H - 1, `tent ${i} at ${x},${y} stays in the camp band`);
  assert.ok(x + 11 < 184 || x - 10 > 296, `tent ${i} at ${x},${y} stays clear of the fire seats`);
  assert.equal(node, x < 240 ? 'D' : 'F');
  seen.add(`${x},${y}`);
}
assert.equal(seen.size, 60, 'every tent has its own spot');
assert.ok(W === 480);
const many = [ag('chief', 'idle')];
for (let i = 1; i <= 25; i++) many.push(ag(`lead-T${i}`, 'idle', `T${i}`, 'amber'));
const crowd = new Cast();
crowd.sync(many, null);
assert.equal(crowd.tents.size, 25, 'a tent for every team');
assert.ok([...crowd.actors.values()].filter((a) => a.id !== 'chief').every((a) => a.inside), 'everyone rests in their tent');
run(crowd, 60);
for (const t of crowd.tents.values()) {
  const [px, py] = [t.x, t.y - 3];
  const under = [...crowd.tents.values()].filter((o) => px >= o.x - 10 && px <= o.x + 11 && py >= o.y - 17 && py <= o.y + 1);
  const front = Math.max(...under.map((o) => o.y));
  assert.equal(crowd.tentAt(px, py)?.y, front, `the front-most tent wins the hover over ${t.taskId}`);
}

// A team member with an error stays out by the fire, where its error shows, and goes in once it clears.
const err = new Cast();
err.sync([ag('chief', 'idle'), ag('lead-T4', 'idle', 'T4', 'teal1'), { ...ag('T4-impl', 'idle', 'T4', 'teal1'), error: 'Session error: No response was returned.' }], null);
err.settle();
assert.equal(err.actors.get('T4-impl').inside, false, 'an errored member is not hidden in the tent');
assert.equal(err.actors.get('T4-impl').station, 'camp');
assert.equal(err.actors.get('lead-T4').inside, true);
err.sync([ag('chief', 'idle'), ag('lead-T4', 'idle', 'T4', 'teal1'), ag('T4-impl', 'idle', 'T4', 'teal1')], null);
err.settle();
assert.equal(err.actors.get('T4-impl').inside, true);

// settle() (page was hidden) finishes walks into tents and finishes pitching.
const quick = new Cast();
quick.sync([ag('chief', 'idle')], null);
quick.sync([ag('chief', 'idle'), ag('lead-T9', 'idle', 'T9', 'teal1')], null);
quick.settle();
assert.equal(quick.actors.get('lead-T9').inside, true);
assert.equal(quick.tents.get('T9').raised, 1);

// The engineer shapeshifts: a mage while walking, in a huddle or at camp; at a station, that station's class.
// The change takes MORPH_TICKS, from the old form to the new.
{
  const { MORPH_TICKS } = await import('../extensions/grove-agent-monitor/web/scene/actors.mjs');
  const eng = (activity) => ({ ...ag('T5-eng', activity, 'T5', 'amber'), role: 'engineer' });
  const c = new Cast();
  c.sync([eng('implementing')], null);
  const e = c.actors.get('T5-eng');
  assert.equal(e.form, 'artificer', 'already in form when the grove first appears');
  assert.equal(e.morph, null);
  c.sync([eng('testing')], null);
  run(c, 1);
  assert.ok(e.walking);
  assert.deepEqual([e.morph?.from, e.morph?.to], ['artificer', 'mage'], 'back to its own form to walk');
  run(c, MORPH_TICKS);
  assert.equal(e.form, 'mage');
  assert.equal(e.morph, null);
  while (e.walking) run(c, 1);
  assert.equal(e.station, 'testing');
  assert.equal(e.form, 'mage', 'it walks there as a mage');
  run(c, 1);
  assert.deepEqual([e.morph?.from, e.morph?.to], ['mage', 'warden'], 'arriving starts the change');
  run(c, MORPH_TICKS);
  assert.equal(e.form, 'warden');
  c.sync([eng('code-review')], null);
  run(c, 500);
  assert.equal(e.form, 'mage', 'a mage again with its reviewers');
  c.sync([eng('research')], null);
  run(c, 500);
  assert.equal(e.form, 'scout');
  // Changing its mind mid-change starts over from the form that's showing more.
  assert.equal(e.targetForm, 'scout');
  e.morph = { from: 'scout', to: 'mage', t: 2 };
  e.updateForm();
  assert.deepEqual([e.form, e.morph], ['scout', null], 'barely started turning into a mage, so it stays a scout');
  e.form = 'scout';
  e.morph = { from: 'scribe', to: 'mage', t: MORPH_TICKS - 5 };
  e.updateForm();
  assert.deepEqual([e.morph.from, e.morph.to, e.morph.t], ['mage', 'scout', 0], 'mostly a mage already, so it changes from the mage');
  // Settling (a hidden page catching up) skips the animation.
  c.sync([eng('planning')], null);
  c.settle();
  assert.deepEqual([e.form, e.morph], ['scribe', null]);
  // Everyone else keeps their class.
  const other = new Cast();
  other.sync([{ ...ag('x', 'implementing'), role: 'implementer' }, ag('y', 'testing')], null);
  assert.deepEqual([other.actors.get('x').form, other.actors.get('y').form], ['artificer', 'mage']);
  other.sync([{ ...ag('x', 'research'), role: 'implementer' }, ag('y', 'research')], null);
  run(other, 600);
  assert.deepEqual([other.actors.get('x').form, other.actors.get('y').form], ['artificer', 'mage']);
}

console.log('scene tests passed');
