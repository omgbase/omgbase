#!/usr/bin/env node
// The `timeline` corpus: a fictional multi-year programme ("Meridian", a mountain
// observatory, 2026–2028) of six projects, each a chain of 8–13 milestone notes
// linked by `after:` (the note before me — repository-root paths, one side only,
// the forward direction derived: `^docs collect { where after == ^_path }`), with
// `when:` dates, `window:` date ranges (spec/properties §2.2), `status`, `owner`
// (people notes), `tags`, a categorical `track`, a numeric `effort`, bodies with
// path links across projects, `- [ ]` tasks, `#hashtags`, and deliberate decoys
// (near-miss names, a milestone whose body names another project without linking
// it, windows that start or end exactly at the queried date, a task inside a code
// fence). The milestones, people and open tasks are authored below — they ARE the
// tasks' expected answers; the filler (meetings, decisions, journal, glossary,
// risks, vendors) comes from a seeded PRNG so the whole corpus is a pure function
// of this file. `node src/corpus.ts` (pnpm --filter agent-bench corpus) writes the
// snapshot to corpora/timeline/, which is committed so transcripts are
// reproducible; a test pins the snapshot to a fresh generation.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_SEED = 20261020;

// ---- the authored data --------------------------------------------------------------

export interface Person {
  slug: string;
  name: string;
  role: string;
  team: string;
}

export const PEOPLE: readonly Person[] = [
  { slug: "mara-lindqvist", name: "Mara Lindqvist", role: "instrument scientist", team: "instrument" },
  { slug: "mara-lind", name: "Mara Lind", role: "outreach coordinator", team: "outreach" },
  { slug: "tomas-okafor", name: "Tomas Okafor", role: "site engineer", team: "civil" },
  { slug: "ines-ferreira", name: "Inês Ferreira", role: "enclosure lead", team: "civil" },
  { slug: "yusuf-adeyemi", name: "Yusuf Adeyemi", role: "data architect", team: "software" },
  { slug: "hana-sato", name: "Hana Sato", role: "facilities engineer", team: "operations" },
  { slug: "priya-raman", name: "Priya Raman", role: "partnerships lead", team: "outreach" },
  { slug: "lukas-brandt", name: "Lukas Brandt", role: "optical engineer", team: "instrument" },
  { slug: "zoe-chen", name: "Zoe Chen", role: "detector and pipeline engineer", team: "software" },
  { slug: "samir-haddad", name: "Samir Haddad", role: "procurement and construction manager", team: "civil" },
];

export interface Project {
  slug: string;
  name: string;
  lead: string;
  track: string;
  summary: string;
}

export const PROJECTS: readonly Project[] = [
  { slug: "aurora", name: "Aurora spectrograph", lead: "mara-lindqvist", track: "instrument", summary: "The first-light instrument: a bench spectrograph fed from the dome through a slit mask." },
  { slug: "basalt", name: "Basalt site works", lead: "tomas-okafor", track: "civil", summary: "Road, piers, drainage: everything that has to exist before a dome can stand on the ridge." },
  { slug: "cirrus", name: "Cirrus dome and enclosure", lead: "ines-ferreira", track: "civil", summary: "The enclosure: steel, shutter, thermal sealing, and the slit that has to agree with the spectrograph." },
  { slug: "delta", name: "Delta data pipeline", lead: "yusuf-adeyemi", track: "software", summary: "From detector frames to a public archive: ingest, calibration, quick-look, API, release." },
  { slug: "ember", name: "Ember power and cooling", lead: "hana-sato", track: "operations", summary: "Generators, substation, glycol loop and chillers for the summit." },
  { slug: "fjord", name: "Fjord partnerships and outreach", lead: "priya-raman", track: "outreach", summary: "Partners, schools, the visitor centre and the inauguration." },
];

export type Status = "open" | "done" | "blocked" | "dropped";

export interface Milestone {
  project: string;
  slug: string;
  title: string;
  /** the window's first day */
  start: string;
  /** the milestone date — the window's last day */
  when: string;
  status: Status;
  owner: string;
  effort: number;
  /** done milestones: when the status flipped */
  closed?: string;
  /** extra tags beyond `milestone` and the project */
  tags?: string[];
  /** a body paragraph that NAMES another project without linking it (a decoy for grep) */
  mentions?: string;
}

// Chain order = array order within a project. Dates are monotone along every chain
// EXCEPT aurora's, where "Detector cooldown test" slipped past "Slit mask
// fabrication" — so an answer ordered by `when` is wrong and only the `after:`
// chain is right. Windows around 2027-03-15 (the range task's date) are placed on
// purpose: bench-alignment and chiller-commissioning END on it, visitor-centre-brief
// STARTS on it (all in flight — inclusive ends); foundation-pour ends the day
// before, integration-with-dome and battery-backup start the day after (not in
// flight); partner-agreements ends 03-12 but was CLOSED on 03-15 (a date decoy).
const M = (project: string, slug: string, title: string, start: string, when: string, status: Status, owner: string, effort: number, extra: Partial<Milestone> = {}): Milestone =>
  ({ project, slug, title, start, when, status, owner, effort, ...extra });

export const MILESTONES: readonly Milestone[] = [
  // aurora — 11
  M("aurora", "kickoff", "Aurora kickoff", "2026-02-02", "2026-02-06", "done", "mara-lindqvist", 3, { closed: "2026-02-06" }),
  M("aurora", "science-requirements", "Science requirements signed off", "2026-02-09", "2026-03-20", "done", "mara-lindqvist", 8, { closed: "2026-03-23" }),
  M("aurora", "optical-design-review", "Optical design review", "2026-03-23", "2026-05-15", "done", "lukas-brandt", 13, { closed: "2026-05-18" }),
  M("aurora", "grating-procurement", "Grating procurement", "2026-05-18", "2026-09-30", "done", "mara-lindqvist", 5, { closed: "2026-10-02" }),
  M("aurora", "detector-cooldown-test", "Detector cooldown test", "2026-10-05", "2027-01-29", "done", "zoe-chen", 8, { closed: "2027-02-01", tags: ["slipped"] }),
  M("aurora", "slit-mask-fabrication", "Slit mask fabrication", "2026-10-12", "2026-12-18", "done", "lukas-brandt", 5, { closed: "2026-12-18" }),
  M("aurora", "bench-alignment", "Bench alignment", "2027-02-01", "2027-03-15", "done", "mara-lindqvist", 8, { closed: "2027-03-17" }),
  M("aurora", "integration-with-dome", "Integration with the dome", "2027-03-16", "2027-05-28", "done", "mara-lindqvist", 13, { closed: "2027-06-01", mentions: "Cirrus" }),
  M("aurora", "first-light", "First light", "2027-06-07", "2027-08-20", "done", "lukas-brandt", 3, { closed: "2027-08-23" }),
  M("aurora", "throughput-calibration", "Throughput calibration", "2027-08-23", "2027-11-12", "open", "zoe-chen", 8),
  M("aurora", "closeout", "Aurora closeout", "2027-11-15", "2028-01-14", "open", "mara-lindqvist", 2),
  // basalt — 9
  M("basalt", "kickoff", "Basalt kickoff", "2026-01-12", "2026-01-16", "done", "tomas-okafor", 2, { closed: "2026-01-16" }),
  M("basalt", "geotechnical-survey", "Geotechnical survey", "2026-01-19", "2026-03-13", "done", "tomas-okafor", 8, { closed: "2026-03-16" }),
  M("basalt", "access-road-design", "Access road design", "2026-03-16", "2026-05-08", "done", "samir-haddad", 8, { closed: "2026-05-11" }),
  M("basalt", "environmental-permit", "Environmental permit", "2026-04-06", "2026-08-28", "done", "tomas-okafor", 5, { closed: "2026-09-01" }),
  M("basalt", "road-construction", "Access road construction", "2026-08-31", "2027-01-22", "done", "samir-haddad", 21, { closed: "2027-01-25" }),
  M("basalt", "foundation-pour", "Pier foundation pour", "2027-01-25", "2027-03-14", "done", "tomas-okafor", 13, { closed: "2027-03-16" }),
  M("basalt", "drainage-works", "Drainage works", "2027-03-01", "2027-04-23", "done", "samir-haddad", 5, { closed: "2027-04-26" }),
  M("basalt", "site-handover", "Site handover", "2027-04-26", "2027-05-14", "done", "tomas-okafor", 3, { closed: "2027-05-17", mentions: "Cirrus" }),
  M("basalt", "closeout", "Basalt closeout", "2027-05-17", "2027-06-11", "open", "tomas-okafor", 2),
  // cirrus — 12
  M("cirrus", "kickoff", "Cirrus kickoff", "2026-03-02", "2026-03-06", "done", "ines-ferreira", 2, { closed: "2026-03-06" }),
  M("cirrus", "enclosure-concept", "Enclosure concept study", "2026-03-09", "2026-05-29", "done", "ines-ferreira", 8, { closed: "2026-06-01" }),
  M("cirrus", "wind-load-analysis", "Wind load analysis", "2026-06-01", "2026-07-24", "done", "lukas-brandt", 5, { closed: "2026-07-27" }),
  M("cirrus", "design-review", "Design review", "2026-07-27", "2026-09-04", "done", "ines-ferreira", 5, { closed: "2026-09-07" }),
  M("cirrus", "steel-tender", "Steel tender", "2026-09-07", "2026-12-11", "done", "samir-haddad", 8, { closed: "2026-12-14" }),
  M("cirrus", "dome-slit-alignment", "Dome slit alignment to the spectrograph", "2026-12-14", "2027-02-26", "done", "mara-lindqvist", 8, { closed: "2027-03-01", tags: ["aurora"], mentions: "Aurora" }),
  M("cirrus", "shutter-fabrication", "Shutter fabrication", "2027-03-01", "2027-05-21", "done", "ines-ferreira", 13, { closed: "2027-05-24" }),
  M("cirrus", "dome-erection", "Dome erection", "2027-05-24", "2027-09-10", "done", "samir-haddad", 21, { closed: "2027-09-14" }),
  M("cirrus", "shutter-commissioning", "Shutter commissioning", "2027-09-13", "2027-10-29", "blocked", "ines-ferreira", 5),
  M("cirrus", "thermal-sealing", "Thermal sealing", "2027-11-01", "2027-12-17", "open", "ines-ferreira", 5),
  M("cirrus", "acceptance-tests", "Enclosure acceptance tests", "2028-01-10", "2028-02-11", "open", "lukas-brandt", 8),
  M("cirrus", "closeout", "Cirrus closeout", "2028-02-14", "2028-03-03", "open", "ines-ferreira", 2),
  // delta — 13
  M("delta", "kickoff", "Delta kickoff", "2026-04-06", "2026-04-10", "done", "yusuf-adeyemi", 2, { closed: "2026-04-10" }),
  M("delta", "data-model", "Data model", "2026-04-13", "2026-06-05", "done", "yusuf-adeyemi", 8, { closed: "2026-06-08" }),
  M("delta", "ingest-prototype", "Ingest prototype", "2026-06-08", "2026-08-14", "done", "zoe-chen", 13, { closed: "2026-08-17" }),
  M("delta", "archive-schema-freeze", "Archive schema freeze", "2026-08-17", "2026-10-02", "done", "yusuf-adeyemi", 5, { closed: "2026-10-05" }),
  M("delta", "storage-procurement", "Storage procurement", "2026-10-05", "2026-12-18", "done", "hana-sato", 5, { closed: "2026-12-21" }),
  M("delta", "pipeline-v1", "Pipeline v1", "2027-01-04", "2027-03-26", "done", "zoe-chen", 21, { closed: "2027-03-30", mentions: "Aurora" }),
  M("delta", "calibration-database", "Calibration database", "2027-03-29", "2027-05-21", "done", "yusuf-adeyemi", 8, { closed: "2027-05-24" }),
  M("delta", "quicklook-viewer", "Quick-look viewer", "2027-05-24", "2027-07-16", "done", "zoe-chen", 8, { closed: "2027-07-19" }),
  M("delta", "archive-api", "Archive API", "2027-07-19", "2027-10-01", "open", "yusuf-adeyemi", 13),
  M("delta", "end-to-end-rehearsal", "End-to-end rehearsal", "2027-10-04", "2027-12-10", "open", "zoe-chen", 8),
  M("delta", "operations-handbook", "Operations handbook", "2028-01-10", "2028-02-25", "open", "yusuf-adeyemi", 5),
  M("delta", "public-release", "Public data release", "2028-02-28", "2028-04-21", "open", "zoe-chen", 8),
  M("delta", "closeout", "Delta closeout", "2028-04-24", "2028-05-12", "open", "yusuf-adeyemi", 2),
  // ember — 8 (nothing open)
  M("ember", "kickoff", "Ember kickoff", "2026-05-04", "2026-05-08", "done", "hana-sato", 2, { closed: "2026-05-08" }),
  M("ember", "load-study", "Load study", "2026-05-11", "2026-07-03", "done", "hana-sato", 5, { closed: "2026-07-06" }),
  M("ember", "generator-tender", "Generator tender", "2026-07-06", "2026-09-25", "done", "samir-haddad", 8, { closed: "2026-09-28" }),
  M("ember", "glycol-loop-design", "Glycol loop design", "2026-09-28", "2026-11-20", "done", "hana-sato", 8, { closed: "2026-11-23" }),
  M("ember", "substation-install", "Substation install", "2026-11-23", "2027-02-12", "done", "samir-haddad", 13, { closed: "2027-02-15" }),
  M("ember", "chiller-commissioning", "Chiller commissioning", "2027-02-15", "2027-03-15", "done", "hana-sato", 5, { closed: "2027-03-18" }),
  M("ember", "battery-backup", "Battery backup", "2027-03-16", "2027-04-09", "dropped", "hana-sato", 5),
  M("ember", "closeout", "Ember closeout", "2027-04-12", "2027-04-30", "done", "hana-sato", 2, { closed: "2027-05-03" }),
  // fjord — 10
  M("fjord", "kickoff", "Fjord kickoff", "2026-06-01", "2026-06-05", "done", "priya-raman", 2, { closed: "2026-06-05" }),
  M("fjord", "stakeholder-map", "Stakeholder map", "2026-06-08", "2026-07-31", "done", "priya-raman", 5, { closed: "2026-08-03" }),
  M("fjord", "school-programme-pilot", "School programme pilot", "2026-09-07", "2026-12-11", "done", "zoe-chen", 8, { closed: "2026-12-14" }),
  M("fjord", "partner-agreements", "Partner agreements", "2027-01-11", "2027-03-12", "done", "priya-raman", 8, { closed: "2027-03-15" }),
  M("fjord", "visitor-centre-brief", "Visitor centre brief", "2027-03-15", "2027-04-30", "done", "priya-raman", 5, { closed: "2027-05-04" }),
  M("fjord", "open-day", "Open day", "2027-06-14", "2027-06-18", "done", "mara-lind", 3, { closed: "2027-06-21" }),
  M("fjord", "documentary-filming", "Documentary filming", "2027-08-02", "2027-11-05", "open", "lukas-brandt", 5),
  M("fjord", "naming-competition", "Naming competition", "2027-11-08", "2028-01-28", "open", "priya-raman", 3),
  M("fjord", "inauguration-planning", "Inauguration planning", "2028-02-01", "2028-05-26", "open", "priya-raman", 8),
  M("fjord", "closeout", "Fjord closeout", "2028-05-29", "2028-06-16", "open", "priya-raman", 2),
];

/** The open (`- [ ]`) tasks of the whole corpus, each in the note named — nothing else in the corpus is unchecked. */
export const OPEN_TASKS: readonly { path: string; text: string }[] = [
  { path: "/people/zoe-chen.md", text: "Book the cryostat service visit" },
  { path: "/people/tomas-okafor.md", text: "File the drainage as-built drawings" },
  { path: "/projects/aurora/throughput-calibration.md", text: "Source a NIST-traceable calibration lamp" },
  { path: "/projects/aurora/closeout.md", text: "Archive the bench alignment logs" },
  { path: "/projects/basalt/closeout.md", text: "Return the site cabins to the hire company" },
  { path: "/projects/cirrus/thermal-sealing.md", text: "Confirm the gasket supplier lead time" },
  { path: "/projects/delta/operations-handbook.md", text: "Draft the on-call rota" },
  { path: "/projects/delta/public-release.md", text: "Agree the embargo period with the partners" },
  { path: "/projects/fjord/naming-competition.md", text: "Shortlist the school entries" },
  { path: "/meetings/2027-09-14-weekly.md", text: "Chase the shutter motor warranty paperwork" },
  { path: "/decisions/012-single-glycol-loop.md", text: "Revisit once the chiller duty cycle is measured" },
  { path: "/journal/2028-03.md", text: "Write up the lessons learned from the shutter slip" },
  { path: "/risks/r-07-spare-detector.md", text: "Price a spare detector before the warranty lapses" },
  { path: "/vendors/northcool-systems.md", text: "Renew the glycol service contract" },
];

/** The decoy: a task-shaped line inside a code fence — not a task node, not an open task. */
export const FENCED_TASK_DECOY = "Action item (owner, due date)";

// ---- the semantic-only plants -----------------------------------------------------------------
//
// Three retrieval tasks (`semantic-synonym`, `semantic-paraphrase`, `semantic-cross-domain`)
// ask a question in everyday words whose answer is a note written in deliberately
// different vocabulary: NO content word of the question (stopwords removed, loosely
// stemmed) appears anywhere in the target's text — frontmatter, title, path or body —
// so a grep for the question's words cannot find it, while each DECOY carries at least
// one of those words in an unrelated sense, so a grep finds the decoys instead. The
// guard test (`test/semantic-plants.test.ts`) pins both halves, and the opt-in ranking
// test pins that the target is the top `semantic()` hit under gte-base. A planted
// passage must clear the engine's embedding floor (24 whitespace tokens, spec/search
// §2.1) to be ranked at all. Nothing here carries a `window`, an `after:` or an open
// task, so the other timeline tasks' answers do not move.

export interface PlantedNote {
  path: string;
  text: string;
}

export interface SemanticPlant {
  /** the task id (`tasks/<id>.json`) */
  task: string;
  /** the question the task's prompt opens with and its solution embeds verbatim */
  question: string;
  target: PlantedNote;
  decoys: readonly PlantedNote[];
}

const note = (fm: string, body: string): string => `---\n${fm}\n---\n\n${body}\n`;

export const SEMANTIC_PLANTS: readonly SemanticPlant[] = [
  {
    // everyday words → domain jargon; zero overlap on camera / stay / cold / overnight (and no "warm", no "night")
    task: "semantic-synonym",
    question: "Which note explains why the camera would not stay cold overnight?",
    target: {
      path: "/journal/2026-11-17-dewar-hold-time.md",
      text: note(
        "type: journal\ntitle: Why the cryostat could not hold its operating point until dawn\nproject: aurora\nwhen: 2026-11-17\nauthor: /people/zoe-chen.md\ntags: [journal, aurora, cryostat]",
        `# Why the cryostat could not hold its operating point until dawn

Third run of the [Detector cooldown test](/projects/aurora/detector-cooldown-test.md). The dewar's hold time fell short of a full observing run again: the glycol loop cycled every forty minutes instead of holding steady, and the radiative load through the open dome slit exceeded the second-stage capacity by about three watts, so the CCD stage drifted upward from the second hour and was above its operating temperature well before dawn.

The thermal budget assumed a sealed enclosure and a steady coolant supply; neither exists yet. Until [Thermal sealing](/projects/cirrus/thermal-sealing.md) closes the gaps and Northcool fixes the chiller duty cycle, the cryostat will not hold the CCD at its operating point from dusk to dawn and the test cannot pass. See [Extend the detector cooldown test](/decisions/016-detector-cooldown-extension.md).`,
      ),
    },
    decoys: [
      {
        // "cold", "overnight", "stay" — the weather, not the instrument
        path: "/meetings/2027-01-20-summit-closure.md",
        text: note(
          "type: meeting\ntitle: Extraordinary sync — summit closure\nwhen: 2027-01-20\nattendees: [/people/tomas-okafor.md, /people/samir-haddad.md, /people/hana-sato.md]\nprojects: [basalt, cirrus]\ntags: [meeting, extraordinary, weather]",
          `# Extraordinary sync — summit closure

Cold weather closed the summit road overnight and the plough will not get through before Thursday; the site stays shut, the crews stay at the base station, and the pier survey moves to next week. Nobody goes up until Tomas has walked the road. #weather

## Decisions

The access rota is suspended while the road is closed; the overnight watch at the base station continues.`,
        ),
      },
      {
        // "camera" — the film crew's, not the science detector
        path: "/risks/r-26-camera-fogging.md",
        text: note(
          "type: risk\ntitle: Documentary camera lens fogs inside the dome\nproject: fjord\nlikelihood: medium\nimpact: low\nstatus: open\nowner: /people/priya-raman.md\ntags: [risk, fjord]",
          `# Documentary camera lens fogs inside the dome

Threatens [Documentary filming](/projects/fjord/documentary-filming.md). The film crew's camera lens fogs over every time it is carried from the control room into the dome; the shots of the shutter opening at dusk were lost twice, and Sable Film want a drying cabinet for the camera by the dome door before the next shoot.`,
        ),
      },
      {
        // "cold storage", "stays", "overnight" — the canteen
        path: "/vendors/ridgeline-catering.md",
        text: note(
          "type: vendor\nname: Ridgeline Catering\nsupplies: [site canteen, cold storage]\ntags: [vendor]",
          `# Ridgeline Catering

Supplies the site canteen and cold storage; first engaged for [Access road construction](/projects/basalt/road-construction.md). The cold storage unit stays at the base station because the summit has no three-phase supply for it yet; overnight deliveries come up with the morning crew bus, and the canteen stays open while any crew is on the ridge.`,
        ),
      },
    ],
  },
  {
    // the question states a conclusion; the note is the reasoning without the conclusion's words (argue / buying / backup / detector / mistake)
    task: "semantic-paraphrase",
    question: "Where did someone argue that buying the backup detector was a mistake?",
    target: {
      path: "/journal/2028-04-14-the-crate-in-the-store.md",
      text: note(
        "type: journal\ntitle: In hindsight, the spare was the wrong call\nproject: aurora\nwhen: 2028-04-14\nauthor: /people/mara-lindqvist.md\ntags: [journal, aurora, procurement]",
        `# In hindsight, the spare was the wrong call

Mara's position, for the record: procuring the spare focal-plane array last spring was the wrong call, and hindsight has only sharpened it. The spare sits unused in its crate in the instrument store and will until the warranty on the one in the cryostat lapses; the money would have funded two months of commissioning time between [Bench alignment](/projects/aurora/bench-alignment.md) and [First light](/projects/aurora/first-light.md), which is exactly what we ran short of.

I said so at the time and was overruled; the board's reasoning — that a second unit protects first light — was sound on paper, but the insurance we paid for was never the scarce resource. Noted here so the [spare-parts budget line](/decisions/036-spare-parts-budget.md) discussion starts from what actually happened rather than from the paper.`,
      ),
    },
    decoys: [
      {
        // "backup detector" — approved, and nobody minded
        path: "/meetings/2027-03-10-detector-procurement.md",
        text: note(
          "type: meeting\ntitle: Extraordinary sync — detector procurement\nwhen: 2027-03-10\nattendees: [/people/mara-lindqvist.md, /people/zoe-chen.md, /people/samir-haddad.md]\nprojects: [aurora]\ntags: [meeting, extraordinary, procurement]",
          `# Extraordinary sync — detector procurement

The board approved the purchase order for the backup detector from [Halberd Detectors](/vendors/halberd-detectors.md) and everyone in the room agreed it was the right call; delivery is in twelve weeks, Zoe books the acceptance test for the second unit when it lands, and Samir confirms the warranty on the first one runs to the end of 2029. #procurement`,
        ),
      },
      {
        // "mistake", "argued" — about flat fields
        path: "/journal/2027-06-30-flat-field-gradient.md",
        text: note(
          "type: journal\ntitle: The flat-field gradient\nproject: aurora\nwhen: 2027-06-30\nauthor: /people/lukas-brandt.md\ntags: [journal, aurora, calibration]",
          `# The flat-field gradient

Taking the flat fields through the open dome slit was a mistake: the gradient across the field is the slit, not the lamp, and a week of calibration frames has to be redone. Lukas argued for a screen on the inside of the dome from the start and he was right; the screen goes up before the next calibration run.`,
        ),
      },
      {
        // "backup", "detector" — a smoke detector in the backup generator shed
        path: "/risks/r-27-generator-shed-smoke-detector.md",
        text: note(
          "type: risk\ntitle: Smoke detector in the backup generator shed trips on start-up\nproject: ember\nlikelihood: medium\nimpact: medium\nstatus: open\nowner: /people/hana-sato.md\ntags: [risk, ember]",
          `# Smoke detector in the backup generator shed trips on start-up

Threatens [Substation install](/projects/ember/substation-install.md). The smoke detector in the backup generator shed trips every time the backup set starts in damp weather, and the fire panel then locks out the substation feed for ten minutes; a detector rated for diesel exhaust is on order from Meridian Power.`,
        ),
      },
    ],
  },
  {
    // the concept named in the question (a person's state) is described only by its symptoms and consequences; zero overlap on burn / burning
    task: "semantic-cross-domain",
    question: "Which note describes someone burning out?",
    target: {
      path: "/journal/2027-12-14-three-weeks-on-call.md",
      text: note(
        "type: journal\ntitle: Three weeks on call\nproject: delta\nwhen: 2027-12-14\nauthor: /people/yusuf-adeyemi.md\ntags: [journal, delta, people]",
        `# Three weeks on call

Zoe has carried the on-call rota alone for three weeks while the [End-to-end rehearsal](/projects/delta/end-to-end-rehearsal.md) runs, and it shows: she fell asleep in the Tuesday sync, snapped at the partners on Thursday's call, the pipeline's error rate doubled on her watch, and she has started answering questions with questions. She has not had a day off since October. I have taken her off the rota until January and the rehearsal loses a week for it; a week is cheap against what we were about to lose.`,
      ),
    },
    decoys: [
      {
        // "burnout" — a shutter motor's windings, not a person (the strongest decoy: second to the target under gte-base)
        path: "/meetings/2027-09-28-shutter-motor-burnout.md",
        text: note(
          "type: meeting\ntitle: Shutter motor burnout\nwhen: 2027-09-28\nattendees: [/people/ines-ferreira.md, /people/samir-haddad.md]\nprojects: [cirrus]\ntags: [meeting, commissioning]",
          `# Shutter motor burnout

The second shutter motor burnout this month: water got past the seal on the east drive and shorted the windings, and the motor is a write-off. Kestrel will supply a sealed replacement under [Replace the shutter motors](/decisions/027-shutter-motor-replacement.md), and the warranty claim goes in this week. #commissioning`,
        ),
      },
      {
        // "burning" — a firmware image onto a controller
        path: "/risks/r-28-shutter-controller-firmware.md",
        text: note(
          "type: risk\ntitle: Burning the shutter controller firmware fails halfway\nproject: cirrus\nlikelihood: low\nimpact: medium\nstatus: open\nowner: /people/ines-ferreira.md\ntags: [risk, cirrus]",
          `# Burning the shutter controller firmware fails halfway

Threatens [Shutter commissioning](/projects/cirrus/shutter-commissioning.md). Burning the new firmware image onto the shutter controller over the serial link fails halfway through on two of the three boards Kestrel shipped, leaving the controller unbootable until the image is burnt again from the recovery header; a bricked controller on the summit is a day's drive to fix.`,
        ),
      },
      {
        // "burnt out", "burning through" — the calibration lamp
        path: "/meetings/2027-10-26-calibration-lamp.md",
        text: note(
          "type: meeting\ntitle: Calibration lamp\nwhen: 2027-10-26\nattendees: [/people/zoe-chen.md, /people/lukas-brandt.md]\nprojects: [aurora]\ntags: [meeting, commissioning]",
          `# Calibration lamp

The arc lamp burnt out after a hundred and forty hours, a third of its rated life, and Zoe is burning through the spares faster than the [Throughput calibration](/projects/aurora/throughput-calibration.md) plan allowed for; Lukas will ask Aurora Optics whether the lamp housing is running hot. #commissioning`,
        ),
      },
      {
        // "burning" — cleared scrub along the road line
        path: "/journal/2026-08-19-clearing-the-ridge.md",
        text: note(
          "type: journal\ntitle: Clearing the ridge\nproject: basalt\nwhen: 2026-08-19\nauthor: /people/tomas-okafor.md\ntags: [journal, basalt, sitework]",
          `# Clearing the ridge

Ridgeway's crew spent the week burning the cleared scrub along the road line, inside the permit's burning window and with the fire service told each morning; the [Access road construction](/projects/basalt/road-construction.md) starts on a clean line on Monday, a week earlier than the plan assumed. #sitework`,
        ),
      },
    ],
  },
];

/** Every planted path (targets and decoys), in plant order. */
export function plantedPaths(): string[] {
  return SEMANTIC_PLANTS.flatMap((p) => [p.target.path, ...p.decoys.map((d) => d.path)]);
}

// ---- the PRNG and the word lists ---------------------------------------------------------

/** mulberry32: a tiny deterministic PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function pickN<T>(r: () => number, xs: readonly T[], n: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return out;
}

const GLOSSARY: readonly [string, string][] = [
  ["airmass", "The path length through the atmosphere relative to the zenith; it sets how much the sky dims and reddens a source."],
  ["first light", "The first astronomical exposure through a completed instrument — a milestone, not a measurement."],
  ["slit mask", "A plate with narrow apertures at the focal plane selecting what the spectrograph disperses."],
  ["grating", "The dispersing element: a ruled or holographic surface that spreads light by wavelength."],
  ["cryostat", "The vacuum vessel that keeps a detector cold enough to read out quietly."],
  ["dark current", "Charge a detector accumulates with no light at all, falling steeply with temperature."],
  ["flat field", "An exposure of a uniform source used to divide out pixel-to-pixel sensitivity."],
  ["quick-look", "A fast, approximate reduction shown within minutes so observers can judge the night."],
  ["glycol loop", "The closed cooling circuit carrying heat from the instrument room to the chillers outside."],
  ["pier", "The concrete column a telescope mount stands on, isolated from the building floor."],
  ["shutter", "The dome's opening — on Cirrus a bi-parting slit with its own drive and seals."],
  ["seeing", "The blurring of star images by atmospheric turbulence, measured in arcseconds."],
  ["throughput", "The fraction of light entering the instrument that reaches the detector at a given wavelength."],
  ["embargo", "The period during which newly archived data is visible only to the proposing team."],
  ["as-built", "A drawing revised to show what was actually constructed, not what was designed."],
  ["geotechnical survey", "Boreholes and load tests that tell the engineers what the ridge is made of."],
  ["wind load", "The structural force the enclosure must take from the summit wind, by direction and gust."],
  ["calibration lamp", "An arc or quartz lamp giving known emission lines for the wavelength solution."],
  ["wavelength solution", "The mapping from detector pixel to wavelength, fitted from calibration lines."],
  ["readout noise", "The uncertainty added to every pixel by the act of reading it out."],
  ["duty cycle", "The share of time a system is actually working — a chiller, a shutter drive, a telescope."],
  ["run book", "The ordered procedure an operator follows for a routine task."],
  ["tender", "A formal invitation to suppliers to bid against a specification."],
  ["handover", "The moment a contractor's deliverable becomes the programme's responsibility."],
  ["closeout", "The final milestone of a project: records archived, lessons written, budget closed."],
  ["baffle", "A blackened surface that stops stray light reaching where it is not wanted."],
  ["vignetting", "Loss of light at the edge of a field because something upstream clips the beam."],
  ["data release", "A versioned public publication of archive data with fixed calibration."],
  ["stakeholder map", "Who cares about the programme, how much, and what they can do about it."],
  ["naming competition", "The schools' competition that names the telescope at the inauguration."],
];

const VENDORS: readonly [string, string, string[]][] = [
  ["aurora-optics", "Aurora Optics Ltd", ["gratings", "coatings"]],
  ["northcool-systems", "Northcool Systems", ["chillers", "glycol loop service"]],
  ["ridgeway-civil", "Ridgeway Civil Engineering", ["road construction", "drainage"]],
  ["kestrel-steel", "Kestrel Steel Fabrication", ["dome steel", "shutter frames"]],
  ["halberd-detectors", "Halberd Detectors", ["detectors", "cryostats"]],
  ["meridian-power", "Meridian Power Services", ["generators", "substation"]],
  ["lumen-glass", "Lumen Glass Works", ["slit masks", "windows"]],
  ["archivum-cloud", "Archivum Cloud Storage", ["object storage", "archive hosting"]],
  ["tern-surveys", "Tern Geotechnical Surveys", ["boreholes", "load tests"]],
  ["sable-film", "Sable Film Collective", ["documentary production"]],
  ["quill-design", "Quill Exhibition Design", ["visitor centre fit-out"]],
  ["eastgate-hire", "Eastgate Site Hire", ["site cabins", "temporary power"]],
];

const RISKS: readonly [string, string, string][] = [
  ["r-01-road-washout", "Access road washout before the pour", "basalt"],
  ["r-02-grating-delivery", "Grating delivery slips past the bench alignment window", "aurora"],
  ["r-03-steel-prices", "Steel prices rise between tender and award", "cirrus"],
  ["r-04-storage-vendor", "Storage vendor exits the market", "delta"],
  ["r-05-generator-noise", "Generator noise breaches the permit limit", "ember"],
  ["r-06-partner-withdrawal", "A founding partner withdraws", "fjord"],
  ["r-07-spare-detector", "No spare detector when the warranty lapses", "aurora"],
  ["r-08-winter-closure", "Winter closure of the road delays the dome erection", "cirrus"],
  ["r-09-schema-churn", "Archive schema changes after the freeze", "delta"],
  ["r-10-glycol-leak", "Glycol leak in the instrument room", "ember"],
  ["r-11-permit-appeal", "Environmental permit appealed", "basalt"],
  ["r-12-slit-mismatch", "Dome slit and spectrograph slit disagree at integration", "cirrus"],
  ["r-13-key-person", "Single point of failure on the pipeline team", "delta"],
  ["r-14-school-uptake", "Low uptake of the school programme", "fjord"],
  ["r-15-cooldown-failure", "Cryostat fails to reach operating temperature", "aurora"],
  ["r-16-pier-settlement", "Pier settlement after the pour", "basalt"],
  ["r-17-shutter-icing", "Shutter seals ice in winter", "cirrus"],
  ["r-18-embargo-dispute", "Partners dispute the embargo period", "delta"],
  ["r-19-chiller-capacity", "Chiller capacity short in summer", "ember"],
  ["r-20-filming-weather", "Weather closes the documentary filming window", "fjord"],
  ["r-21-calibration-lamp", "Calibration lamp obsolete before procurement", "aurora"],
  ["r-22-drainage-capacity", "Drainage undersized for a hundred-year storm", "basalt"],
  ["r-23-acceptance-criteria", "Enclosure acceptance criteria left ambiguous", "cirrus"],
  ["r-24-release-date", "Public release date announced before the archive is ready", "delta"],
  ["r-25-inauguration-clash", "Inauguration clashes with the partners' calendars", "fjord"],
];

const DECISIONS: readonly [string, string, string, string][] = [
  // [slug, title, project, when]
  ["001-ridge-site", "Build on the north ridge", "basalt", "2026-01-20"],
  ["002-single-instrument-first-light", "One instrument at first light", "aurora", "2026-02-10"],
  ["003-reflective-grating", "A reflective grating, not a grism", "aurora", "2026-03-30"],
  ["004-bi-parting-shutter", "A bi-parting shutter", "cirrus", "2026-04-14"],
  ["005-object-storage", "Object storage for the archive", "delta", "2026-04-28"],
  ["006-gravel-road", "A gravel road, paved later", "basalt", "2026-05-12"],
  ["007-diesel-generators", "Diesel generators with a battery study", "ember", "2026-06-02"],
  ["008-schools-first", "Schools before the general public", "fjord", "2026-06-23"],
  ["009-schema-freeze-date", "Freeze the archive schema by October", "delta", "2026-07-07"],
  ["010-steel-over-composite", "Steel over composite for the dome", "cirrus", "2026-08-04"],
  ["011-slit-mask-in-house", "Fabricate the slit masks in house", "aurora", "2026-09-15"],
  ["012-single-glycol-loop", "A single glycol loop with a bypass", "ember", "2026-10-06"],
  ["013-separate-pier-pour", "Pour the piers before the floor", "basalt", "2026-11-10"],
  ["014-quicklook-in-browser", "Quick-look in the browser, not a desktop app", "delta", "2026-11-24"],
  ["015-dome-slit-tolerance", "A two-millimetre slit alignment tolerance", "cirrus", "2026-12-15"],
  ["016-detector-cooldown-extension", "Extend the detector cooldown test", "aurora", "2027-01-05"],
  ["017-drainage-before-handover", "Drainage before handover", "basalt", "2027-02-02"],
  ["018-visitor-centre-at-base", "The visitor centre at the base station", "fjord", "2027-02-23"],
  ["019-no-battery-backup", "Drop the battery backup", "ember", "2027-03-23"],
  ["020-calibration-db-postgres", "Postgres for the calibration database", "delta", "2027-04-06"],
  ["021-open-day-june", "An open day in June", "fjord", "2027-04-27"],
  ["022-first-light-target", "The first-light target", "aurora", "2027-06-01"],
  ["023-dome-erection-crane", "A tower crane for the dome erection", "cirrus", "2027-06-15"],
  ["024-archive-api-versioning", "Version the archive API in the path", "delta", "2027-07-27"],
  ["025-documentary-access", "Camera access during commissioning", "fjord", "2027-08-10"],
  ["026-throughput-reference", "A photometric standard for throughput", "aurora", "2027-09-07"],
  ["027-shutter-motor-replacement", "Replace the shutter motors", "cirrus", "2027-10-05"],
  ["028-rehearsal-scope", "Scope of the end-to-end rehearsal", "delta", "2027-10-19"],
  ["029-naming-rules", "Rules for the naming competition", "fjord", "2027-11-16"],
  ["030-thermal-sealing-material", "Silicone over neoprene for the seals", "cirrus", "2027-11-30"],
  ["031-closeout-template", "One closeout template for every project", "aurora", "2027-12-14"],
  ["032-handbook-format", "The operations handbook as a run book", "delta", "2028-01-18"],
  ["033-acceptance-criteria", "Enclosure acceptance criteria", "cirrus", "2028-01-25"],
  ["034-release-embargo", "A twelve-month embargo", "delta", "2028-02-29"],
  ["035-inauguration-date", "Inauguration in June 2028", "fjord", "2028-03-07"],
  ["036-spare-parts-budget", "A spare-parts budget line", "aurora", "2028-03-21"],
  ["037-release-versioning", "DR1 as the first release name", "delta", "2028-04-04"],
  ["038-lessons-learned-format", "Lessons learned as one page per project", "basalt", "2028-04-18"],
  ["039-closeout-order", "Close Delta before Fjord", "delta", "2028-05-02"],
  ["040-programme-closeout", "The programme closeout review", "fjord", "2028-05-30"],
];

const SCOPE_ITEMS = [
  "Agree the acceptance criteria with the lead",
  "Confirm the budget line and the supplier",
  "Walk the interface with the neighbouring project",
  "Record the as-built state in the project folder",
  "Brief the weekly sync on the risks",
  "Schedule the review with the programme board",
  "Check the summit weather window",
  "Update the integrated schedule",
];

const NOTE_SENTENCES = [
  "Nothing here surprised anyone who had read the risk register.",
  "The schedule held, which on this programme counts as news.",
  "Two of the scope items moved to the next milestone by agreement.",
  "The lead signed off after a second walk-through on site.",
  "The supplier's paperwork arrived late but complete.",
  "A reminder that the summit road closes in heavy snow stands.",
  "The weekly sync took the decision rather than wait for the board.",
  "The programme office wants the as-built records within the month.",
];

const MEETING_DECISIONS = [
  "No decision this week; the open items roll over.",
  "The board slot moves to the first Tuesday of next month.",
  "The integrated schedule is re-baselined at the next sync.",
  "The risk register is reviewed in full next week.",
  "The procurement thresholds are confirmed as published.",
  "The summit access rota is unchanged.",
];

const ACTION_ITEMS = [
  "Circulate the minutes",
  "Update the integrated schedule",
  "Book the summit vehicle",
  "Send the supplier the revised drawing",
  "Confirm the attendees for the board",
  "Re-run the cost forecast",
  "Chase the outstanding invoice",
  "Add the new risk to the register",
];

const HASHTAGS = ["summit", "schedule", "procurement", "weather", "safety", "budget", "commissioning", "sitework"];

// ---- helpers --------------------------------------------------------------------------------

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function yamlList(xs: readonly string[]): string {
  return `[${xs.join(", ")}]`;
}

export function milestonePath(m: Milestone): string {
  return `/projects/${m.project}/${m.slug}.md`;
}

export function personPath(slug: string): string {
  return `/people/${slug}.md`;
}

function personName(slug: string): string {
  return PEOPLE.find((p) => p.slug === slug)!.name;
}

function projectName(slug: string): string {
  return PROJECTS.find((p) => p.slug === slug)!.name;
}

/** The milestones of a project in chain order. */
export function chainOf(project: string): Milestone[] {
  return MILESTONES.filter((m) => m.project === project);
}

/** The open tasks that live in a note, in the authored order. */
function openTasksIn(path: string): string[] {
  return OPEN_TASKS.filter((t) => t.path === path).map((t) => t.text);
}

function tasksSection(path: string, r: () => number, done: number): string {
  const lines: string[] = [];
  for (const t of pickN(r, ACTION_ITEMS, done)) lines.push(`- [x] ${t}`);
  for (const t of openTasksIn(path)) lines.push(`- [ ] ${t}`);
  return lines.length === 0 ? "" : `\n## Tasks\n\n${lines.join("\n")}\n`;
}

// ---- the generators ---------------------------------------------------------------------------

function indexNote(): string {
  const projects = PROJECTS.map((p) => `- [${p.name}](/projects/${p.slug}/index.md) — ${p.summary}`).join("\n");
  const people = PEOPLE.map((p) => `- [${p.name}](${personPath(p.slug)}) — ${p.role}`).join("\n");
  return `---
type: hub
title: Meridian programme
tags: [meridian, index]
programme: meridian
---

# Meridian programme

A mountain observatory built over three years, 2026 to 2028: six projects, each a
chain of milestone notes linked by \`after:\` (the note before it), weekly syncs under
\`meetings/\`, the decision log under \`decisions/\`, monthly journals, the glossary,
the risk register and the vendor notes. #summit

## Projects

${projects}

## People

${people}

## Conventions

A milestone carries \`when\` (its date), \`window\` (first day..last day, inclusive),
\`status\` (open, done, blocked, dropped), \`owner\` (a people note), \`track\`,
\`effort\` (story points) and \`after\` — the milestone before it in the project's
sequence. Done milestones carry \`closed\`, the day the status flipped.
`;
}

function projectIndex(p: Project): string {
  const chain = chainOf(p.slug);
  const kickoff = chain[0]!;
  const last = chain[chain.length - 1]!;
  const open = chain.filter((m) => m.status === "open").length;
  return `---
type: project
name: ${p.name}
slug: ${p.slug}
lead: ${personPath(p.lead)}
track: ${p.track}
tags: [project, ${p.slug}]
window: ${kickoff.start}..${last.when}
milestones: ${chain.length}
---

# ${p.name}

${p.summary} Led by [${personName(p.lead)}](${personPath(p.lead)}).

The sequence starts at [${kickoff.title}](${milestonePath(kickoff)}) and ends at
[${last.title}](${milestonePath(last)}); ${open === 0 ? "nothing is still open" : `${open} milestone${open === 1 ? " is" : "s are"} still open`}.
Every milestone names the one before it in \`after:\`; follow the chain forward
from the kickoff to read the project in order. #${p.slug}
`;
}

function milestoneNote(m: Milestone, r: () => number): string {
  const path = milestonePath(m);
  const chain = chainOf(m.project);
  const i = chain.indexOf(m);
  const prev = i > 0 ? chain[i - 1] : undefined;
  const tags = ["milestone", m.project, m.status === "done" ? "done" : m.status, ...(m.tags ?? [])];
  const fm = [
    "---",
    "type: milestone",
    `project: ${m.project}`,
    `title: ${m.title}`,
    `when: ${m.when}`,
    `window: ${m.start}..${m.when}`,
    `status: ${m.status}`,
    ...(m.closed ? [`closed: ${m.closed}`] : []),
    `owner: ${personPath(m.owner)}`,
    `track: ${PROJECTS.find((p) => p.slug === m.project)!.track}`,
    `effort: ${m.effort}`,
    `tags: ${yamlList(tags)}`,
    ...(prev ? [`after: ${milestonePath(prev)}`] : []),
    "---",
  ].join("\n");
  const scope = pickN(r, SCOPE_ITEMS, 3).map((s) => `- ${s}`).join("\n");
  const related = pick(r, DECISIONS.filter((d) => d[2] === m.project));
  const other = pick(r, PROJECTS.filter((p) => p.slug !== m.project));
  const cross = pick(r, chainOf(other.slug));
  const mention = m.mentions ? ` The ${m.mentions} team sat in on the review, as their schedule depends on this one.` : "";
  const statusLine = m.status === "done"
    ? `Done on ${m.closed}, owned by [${personName(m.owner)}](${personPath(m.owner)}).`
    : m.status === "blocked"
      ? `Blocked — owned by [${personName(m.owner)}](${personPath(m.owner)}), waiting on a supplier.`
      : m.status === "dropped"
        ? `Dropped by the board; the owner was [${personName(m.owner)}](${personPath(m.owner)}).`
        : `Open, owned by [${personName(m.owner)}](${personPath(m.owner)}).`;
  const fence = m.slug === "kickoff" && m.project === "delta"
    ? "\n```text\nframe → ingest → calibrate → quick-look → archive → release\n```\n"
    : "";
  const body = `${fm}

# ${m.title}

A milestone of [${projectName(m.project)}](/projects/${m.project}/index.md): ${pick(r, NOTE_SENTENCES).toLowerCase()}
${statusLine}${mention} #${pick(r, HASHTAGS)}
${fence}
## Scope

${scope}

## Notes

${pick(r, NOTE_SENTENCES)} Decided under [${related[1]}](/decisions/${related[0]}.md).
The nearest dependency outside the project is [${cross.title}](${milestonePath(cross)}).
${tasksSection(path, r, m.status === "done" ? 2 : 1)}`;
  return body;
}

function personNote(p: Person, r: () => number): string {
  const path = personPath(p.slug);
  const owned = MILESTONES.filter((m) => m.owner === p.slug);
  const leads = PROJECTS.filter((x) => x.lead === p.slug);
  const list = owned.length === 0 ? "No milestones owned." : owned.map((m) => `- [${m.title}](${milestonePath(m)}) (${m.project}, ${m.status})`).join("\n");
  return `---
type: person
name: ${p.name}
role: ${p.role}
team: ${p.team}
tags: [person, ${p.team}]
---

# ${p.name}

${p.role.charAt(0).toUpperCase()}${p.role.slice(1)} on the Meridian programme${leads.length > 0 ? `, leading ${leads.map((l) => `[${l.name}](/projects/${l.slug}/index.md)`).join(" and ")}` : ""}. #${p.team}

## Owns

${list}
${tasksSection(path, r, 1)}`;
}

function meetingNote(when: string, r: () => number): string {
  const path = `/meetings/${when}-weekly.md`;
  const inFlight = MILESTONES.filter((m) => m.start <= when && when <= m.when);
  const agenda = (inFlight.length > 0 ? pickN(r, inFlight, Math.min(2, inFlight.length)) : [pick(r, MILESTONES)]);
  const attendees = pickN(r, PEOPLE, 4);
  const projects = [...new Set(agenda.map((m) => m.project))];
  const other = pick(r, PROJECTS.filter((p) => !projects.includes(p.slug)));
  return `---
type: meeting
when: ${when}
attendees: ${yamlList(attendees.map((a) => personPath(a.slug)))}
projects: ${yamlList(projects)}
tags: [meeting, weekly]
---

# Weekly sync — ${when}

## Agenda

${agenda.map((m) => `- [${m.title}](${milestonePath(m)}) — ${m.project}, ${m.status === "done" && m.closed && m.closed <= when ? "closed" : "in flight"}`).join("\n")}
- ${other.name} gave a verbal update; nothing to minute. #${pick(r, HASHTAGS)}

## Decisions

${pick(r, MEETING_DECISIONS)}

## Actions

${pickN(r, ACTION_ITEMS, 2).map((a) => `- [x] ${a} — ${pick(r, attendees).name}`).join("\n")}
${openTasksIn(path).map((t) => `- [ ] ${t}`).join("\n")}`.replace(/\n$/, "") + "\n";
}

function decisionNote(d: readonly [string, string, string, string], i: number, r: () => number): string {
  const [slug, title, project, when] = d;
  const path = `/decisions/${slug}.md`;
  const superseded = i % 9 === 4;
  const nearest = chainOf(project).reduce((best, m) => (Math.abs(Date.parse(m.when) - Date.parse(when)) < Math.abs(Date.parse(best.when) - Date.parse(when)) ? m : best));
  const term = pick(r, GLOSSARY)[0];
  return `---
type: decision
title: ${title}
project: ${project}
when: ${when}
status: ${superseded ? "superseded" : "accepted"}
tags: [decision, ${project}]
---

# ${title}

Taken on ${when} for [${projectName(project)}](/projects/${project}/index.md), nearest
to [${nearest.title}](${milestonePath(nearest)}). ${pick(r, NOTE_SENTENCES)} See [[${term}]].
${superseded ? "\nSuperseded by a later decision; kept for the record.\n" : ""}${tasksSection(path, r, 1)}`;
}

function journalNote(month: string, r: () => number): string {
  const path = `/journal/${month}.md`;
  const first = `${month}-01`;
  const y = Number(month.slice(0, 4));
  const mo = Number(month.slice(5));
  const nextFirst = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  const last = addDays(nextFirst, -1);
  const closed = MILESTONES.filter((m) => m.closed && m.closed.startsWith(month));
  const started = MILESTONES.filter((m) => m.start.startsWith(month));
  return `---
type: journal
month: ${month}
window: ${first}..${last}
tags: [journal]
---

# Journal — ${month}

${closed.length === 0 ? "Nothing closed this month." : `Closed: ${closed.map((m) => `[${m.title}](${milestonePath(m)})`).join(", ")}.`}
${started.length === 0 ? "Nothing started." : `Started: ${started.map((m) => `[${m.title}](${milestonePath(m)})`).join(", ")}.`}
${pick(r, NOTE_SENTENCES)} #${pick(r, HASHTAGS)}
${tasksSection(path, r, 1)}`;
}

function glossaryNote(term: string, definition: string): string {
  return `---
type: term
term: ${term}
tags: [glossary]
---

# ${term}

${definition}
`;
}

function riskNote(risk: readonly [string, string, string], i: number, r: () => number): string {
  const [slug, title, project] = risk;
  const path = `/risks/${slug}.md`;
  const likelihood = ["low", "medium", "high"][i % 3]!;
  const impact = ["medium", "high", "low"][(i >> 1) % 3]!;
  const status = i % 5 === 0 ? "closed" : "open";
  const m = pick(r, chainOf(project));
  return `---
type: risk
title: ${title}
project: ${project}
likelihood: ${likelihood}
impact: ${impact}
status: ${status}
owner: ${personPath(PROJECTS.find((p) => p.slug === project)!.lead)}
tags: [risk, ${project}]
---

# ${title}

Threatens [${m.title}](${milestonePath(m)}). ${pick(r, NOTE_SENTENCES)}
${tasksSection(path, r, 1)}`;
}

function vendorNote(v: readonly [string, string, string[]], r: () => number): string {
  const [slug, name, supplies] = v;
  const path = `/vendors/${slug}.md`;
  const m = pick(r, MILESTONES);
  return `---
type: vendor
name: ${name}
supplies: ${yamlList(supplies)}
tags: [vendor]
---

# ${name}

Supplies ${supplies.join(" and ")}; first engaged for [${m.title}](${milestonePath(m)}). ${pick(r, NOTE_SENTENCES)}
${tasksSection(path, r, 1)}`;
}

function templateNote(): string {
  return `---
type: template
tags: [template]
---

# Meeting template

Copy this into \`meetings/<date>-weekly.md\`. The action list uses task syntax:

\`\`\`markdown
## Actions

- [ ] ${FENCED_TASK_DECOY}
- [x] A completed item
\`\`\`

An action is open until someone ticks it; the weekly sync reads the open ones first.
`;
}

/** The whole corpus as path → bytes, in path order. A pure function of this file. */
export function generateTimeline(): Map<string, string> {
  const r = rng(CORPUS_SEED);
  const out = new Map<string, string>();
  out.set("/index.md", indexNote());
  for (const p of PROJECTS) out.set(`/projects/${p.slug}/index.md`, projectIndex(p));
  for (const m of MILESTONES) out.set(milestonePath(m), milestoneNote(m, r));
  for (const p of PEOPLE) out.set(personPath(p.slug), personNote(p, r));
  for (let when = "2026-01-06"; when <= "2028-06-27"; when = addDays(when, 7)) out.set(`/meetings/${when}-weekly.md`, meetingNote(when, r));
  DECISIONS.forEach((d, i) => out.set(`/decisions/${d[0]}.md`, decisionNote(d, i, r)));
  for (let y = 2026; y <= 2028; y++) for (let mo = 1; mo <= (y === 2028 ? 6 : 12); mo++) {
    const month = `${y}-${String(mo).padStart(2, "0")}`;
    out.set(`/journal/${month}.md`, journalNote(month, r));
  }
  for (const [term, def] of GLOSSARY) out.set(`/glossary/${term.replace(/\s+/g, "-")}.md`, glossaryNote(term, def));
  RISKS.forEach((risk, i) => out.set(`/risks/${risk[0]}.md`, riskNote(risk, i, r)));
  for (const v of VENDORS) out.set(`/vendors/${v[0]}.md`, vendorNote(v, r));
  out.set("/templates/meeting.md", templateNote());
  for (const p of SEMANTIC_PLANTS) {
    out.set(p.target.path, p.target.text);
    for (const d of p.decoys) out.set(d.path, d.text);
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ---- the snapshot ------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** Where the committed snapshot lives. */
export const TIMELINE_DIR = resolve(HERE, "..", "corpora", "timeline");

/** Write the generated corpus to `dir` (replacing it). Returns the number of files. */
export function writeTimeline(dir = TIMELINE_DIR): number {
  const files = generateTimeline();
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    const abs = join(dir, path.replace(/^\/+/, ""));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return files.size;
}

/** Every file under `dir` as path → bytes (the `/`-rooted reference form), sorted. */
export function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.set(`/${relative(dir, full).split(sep).join("/")}`, readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The paths whose bytes differ between two trees (missing on either side counts). */
export function diffTrees(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [p, v] of a) if (b.get(p) !== v) out.push(p);
  for (const p of b.keys()) if (!a.has(p)) out.push(p);
  return out.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = writeTimeline();
  console.error(`wrote ${n} files to ${TIMELINE_DIR}`);
}
