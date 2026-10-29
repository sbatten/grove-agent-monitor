// Shared domain model for the Grove. Imported by both the browser and the extension server.

export const ACTIVITIES = Object.freeze([
  'idle', 'planning', 'plan-review', 'implementing', 'code-review', 'testing', 'research', 'council', 'waiting', 'done',
]);

export const STATIONS = Object.freeze([
  'planning', 'plan-review', 'implementing', 'code-review', 'testing', 'research', 'council', 'waiting', 'camp',
]);

export const ACTIVITY_STATION = Object.freeze({
  idle: 'camp', done: 'camp', planning: 'planning', 'plan-review': 'plan-review', implementing: 'implementing',
  'code-review': 'code-review', testing: 'testing', research: 'research', council: 'council', waiting: 'waiting',
});

export const STATION_LABELS = Object.freeze({
  planning: 'PLANNING', 'plan-review': 'REVIEW', implementing: 'IMPLEMENTING', 'code-review': 'CODE REVIEW',
  testing: 'TESTING', research: 'RESEARCH', council: 'COUNCIL', waiting: 'NEEDS YOU', camp: 'CAMP',
});

// Role → sprite class. Roles describe the job an agent was hired for.
export const ROLES = Object.freeze({
  orchestrator: { sprite: 'archmage', title: 'Archmage' },
  planner: { sprite: 'scribe', title: 'Scribe' },
  implementer: { sprite: 'artificer', title: 'Artificer' },
  reviewer: { sprite: 'seer', title: 'Seer' },
  tester: { sprite: 'warden', title: 'Warden' },
  researcher: { sprite: 'scout', title: 'Scout' },
  generalist: { sprite: 'mage', title: 'Mage' },
  // A task's engineer does every kind of step itself: a mage that shapeshifts into each station's class.
  engineer: { sprite: 'mage', title: 'Engineer', shapeshifter: true },
});

// The form a shapeshifter takes once it stands at a station: the class that normally works there. Everywhere
// else (walking, reviews, council, camp, the lantern) it's in its own form.
export const STATION_FORMS = Object.freeze({ planning: 'planner', research: 'researcher', implementing: 'implementer', testing: 'tester' });
export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));

export const THEMES = Object.freeze(['night', 'dusk', 'dawn']);

// Each task's colour (palette names): agents wear a pennant in it, review huddles fly its banner, and its
// team's tent at camp is made of it. Task Tn gets TASK_COLORS[(n - 1) % length].
export const TASK_COLORS = Object.freeze(['amber', 'cyan1', 'magenta1', 'teal1', 'violet2', 'ember1', 'waterHi', 'mossHi']);
